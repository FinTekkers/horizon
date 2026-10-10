// HZ-378 R6: a budget breach pauses the item with the reason in Activity and
// never auto-retries — not even for a retryable-tagged failure on the job
// lane, which is what the lane's no-retry rule exists for.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-job-budget-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = 'farm-secret-r6'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { REASON } = await import('../../domain/js/reasons.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })
await app.ready()
after(async () => {
  await app.close()
})

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const PLAN =
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '/tmp', commands: ['scripts/a.sh'], budget_minutes: 20 }, null, 2) +
  '\n```'
const farmHeaders = { 'x-farm-secret': config.FARM_SHARED_SECRET }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function seedTask(id) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, approved_plan_hash) VALUES (?, ?, 'High', ?, 'task', ?)").run(
    id,
    `Task ${id}`,
    EXECUTE_STEP_INDEX,
    sha256(PLAN),
  )
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
  ).run(id, RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, PLAN)
}

const activeRunId = (id) => db.prepare("SELECT id FROM step_run WHERE item_id = ? AND status = 'active'").get(id).id
const runCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ?').get(id, EXECUTE_STEP_INDEX).n
const lastEvent = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(id).text

async function failJob(id, error, reason) {
  orchestrator.kick(id)
  await wait(10)
  const runId = activeRunId(id)
  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/fail`,
    headers: farmHeaders,
    payload: { error, reason },
  })
  assert.equal(res.statusCode, 200)
  return runId
}

test('R6: a budget breach pauses the item with the reason in Activity, and no retry ever starts', async () => {
  seedTask('T-R6')
  const runId = await failJob('T-R6', "the job ran past the run plan's time budget and was stopped", REASON.JOB_BUDGET_EXCEEDED)

  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status, 'cancelled')
  assert.equal(store.getItem('T-R6').paused, true)
  const event = lastEvent('T-R6')
  assert.ok(event.startsWith(`agent step failed (${REASON.JOB_BUDGET_EXCEEDED}): the job ran past`), event)
  assert.ok(event.includes('item paused'), event)

  // No auto-retry: still one attempt after a kick well past any retry delay.
  assert.equal(runCount('T-R6'), 1)
  orchestrator.kick('T-R6')
  await wait(50)
  assert.equal(runCount('T-R6'), 1)
  assert.equal(store.getItem('T-R6').paused, true)
})

test('a retryable-tagged failure on the job lane still pauses without retrying', async () => {
  seedTask('T-R6B')
  await failJob('T-R6B', 'could not hand the step to the farm: fetch failed', REASON.UNREACHABLE)

  assert.equal(store.getItem('T-R6B').paused, true)
  assert.equal(runCount('T-R6B'), 1)
  assert.ok(lastEvent('T-R6B').startsWith(`agent step failed (${REASON.UNREACHABLE}):`), lastEvent('T-R6B'))
})
