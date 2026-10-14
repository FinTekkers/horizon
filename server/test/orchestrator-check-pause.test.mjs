// HZ-458 (metric 5): time a run spends in the farm's repo checks does not
// count against its step budget. The implement step tells farmd when its
// checks start and end, farmd relays it to POST /api/farm/steps/:runId/checks,
// and the server pauses the run's timer in between — so a red check handed
// back to the agent for a fix can never push a good attempt into a timeout,
// while agent time alone still times out.
//
// Real timers, like orchestrator-timeout.test.mjs: a short execution budget
// (FARM_STEP_TIMEOUT_MS = 600ms, at a plain farm step) and timestamps written
// in the past stand in for minutes of agent and check time. Every assertion
// sits at least ~150ms from the boundary it tests.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-check-pause-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
process.env.FARM_STEP_TIMEOUT_MS = '600'
process.env.FARM_CHECKS_PAUSE_MAX_MS = '600000'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { FARM_SHARED_SECRET } = await import('../src/config.js')
const store = await import('../src/store.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const app = buildApp({ logger: false })
await app.ready() // booted before any clock starts: a first inject's boot would eat the margins
const STEP = 4 // a plain farm step: its budget is FARM_STEP_TIMEOUT_MS (600ms)
const BUDGET_MS = 600

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function ago(ms) {
  return new Date(Date.now() - ms).toISOString()
}

function activeRun(itemId, { agentMsAgo, checksMs = 0, checksStartedMsAgo = null }) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(itemId, 'Check pause', 'Medium', STEP)
  return db
    .prepare(
      `INSERT INTO step_run (item_id, step_index, attempt, agent, status, agent_started_at, checks_ms, checks_started_at)
       VALUES (?, ?, 1, ?, 'active', ?, ?, ?)`,
    )
    .run(itemId, STEP, STEPS[STEP].agent, ago(agentMsAgo), checksMs, checksStartedMsAgo == null ? null : ago(checksStartedMsAgo))
    .lastInsertRowid
}

function stepRun(runId) {
  return db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
}

function checks(runId, phase, headers = { 'x-farm-secret': FARM_SHARED_SECRET }) {
  return app.inject({ method: 'POST', url: `/api/farm/steps/${runId}/checks`, headers, payload: { phase } })
}

async function checksOk(runId, phase) {
  const res = await checks(runId, phase)
  assert.equal(res.statusCode, 200, res.body)
  return res.json()
}

const CASES = [
  {
    name: '(a) check time longer than the budget left after agent time still completes, with no timeout',
    async run(itemId) {
      // 300ms of agent time, so 300ms of budget is left; the checks then take 450ms.
      const runId = activeRun(itemId, { agentMsAgo: 300 })
      orchestrator.rearmFarmRuns()
      assert.deepEqual(await checksOk(runId, 'start'), { ok: true, active: true, checks_ms: 0 })
      await wait(450)
      assert.equal(stepRun(runId).status, 'active', 'the step clock ran on while the checks did')
      const ended = await checksOk(runId, 'end')
      assert.ok(ended.checks_ms >= 440, `checks_ms ${ended.checks_ms} must hold the check window`)
      assert.equal(stepRun(runId).checks_started_at, null)
      // ~300ms of agent budget is still left after the checks.
      await wait(150)
      assert.equal(stepRun(runId).status, 'active', 'check time was counted against the step budget')
      assert.deepEqual(await orchestrator.completeFarmRun(runId, { summary: 'checks green after a long run' }), { ok: true })
      assert.equal(stepRun(runId).status, 'done')
      assert.doesNotMatch(stepRun(runId).output || '', /timed out/)
    },
  },
  {
    name: '(b) agent time over the budget still times out',
    async run(itemId) {
      const runId = activeRun(itemId, { agentMsAgo: BUDGET_MS + 100 })
      orchestrator.rearmFarmRuns()
      await checksOk(runId, 'start')
      await checksOk(runId, 'end')
      await wait(150)
      const run = stepRun(runId)
      assert.equal(run.status, 'cancelled', 'pausing the clock for checks must not excuse agent time')
      assert.match(run.output, /^FAILED: step timed out/)
    },
  },
  {
    name: '(c) a restart subtracts checks_ms from the elapsed time',
    async run(itemId) {
      // 800ms since the agent started, 500ms of it in checks: 300ms is left.
      // Counting the checks would leave nothing.
      const runId = activeRun(itemId, { agentMsAgo: 800, checksMs: 500 })
      orchestrator.rearmFarmRuns()
      await wait(150)
      assert.equal(stepRun(runId).status, 'active', 'the restart counted check time against the budget')
      await wait(300)
      assert.equal(stepRun(runId).status, 'cancelled', 'the remaining budget was not armed at all')
    },
  },
  {
    name: '(d) a restart mid-check arms only the backstop',
    async run(itemId) {
      // Agent time alone is over the budget, but the checks are still running.
      const runId = activeRun(itemId, { agentMsAgo: BUDGET_MS + 100, checksStartedMsAgo: 50 })
      orchestrator.rearmFarmRuns()
      await wait(200)
      assert.equal(stepRun(runId).status, 'active', 'a run restarted mid-check must stay paused')
      orchestrator.cancel(itemId) // clears the 10-minute backstop so the process can exit
    },
  },
]

for (const [i, c] of CASES.entries()) {
  test(c.name, () => c.run(`CP-${i + 1}`))
}

test('the checks route needs the farm secret and a known phase', async () => {
  const runId = activeRun('CP-AUTH', { agentMsAgo: 0 })
  assert.equal((await checks(runId, 'start', {})).statusCode, 401)
  assert.equal((await checks(runId, 'start', { 'x-farm-secret': 'wrong' })).statusCode, 401)
  assert.equal(stepRun(runId).checks_started_at, null, 'an unauthorized call must not pause the clock')
  assert.equal((await checks(runId, 'pause')).statusCode, 400)
  orchestrator.cancel('CP-AUTH')
})
