// HZ-57: the farm used to arm a step's ENTIRE timeout at dispatch, so time
// spent waiting in the farm's queue burned the same clock as time spent
// actually executing — a step queued behind other work could be killed
// having never run (run 326). Fixed by splitting into two clocks:
//   - a queue watchdog (FARM_QUEUE_TIMEOUT_MS), armed at dispatch, that only
//     bounds how long a step may sit unpicked-up;
//   - an execution timer (FARM_STEP_TIMEOUT_MS, or the implement-step floor),
//     armed fresh from `now` only once the farm confirms an agent actually
//     launched (POST .../started) — see orchestrator.js's
//     dispatchToFarm/markFarmRunStarted/rearmFarmRuns.
//
// These tests use short, distinct timeouts (real timers, not mocked) so the
// two clocks are separately observable within a fast test run, with margins
// wide enough (tens of ms either side of every boundary) to stay reliable
// under scheduler jitter on a loaded CI box:
//   FARM_QUEUE_TIMEOUT_MS = 600ms — the queue-wait bound
//   FARM_STEP_TIMEOUT_MS  = 300ms — the execution bound (also stands in for
//                                   "the old single deadline" in the
//                                   late-start regression test below)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-timeout-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600'
process.env.FARM_STEP_TIMEOUT_MS = '300'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const dispatches = []
globalThis.fetch = async (url, opts) => {
  dispatches.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  return { ok: true, json: async () => ({}) }
}

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function activeRunId(itemId) {
  return db.prepare("SELECT id FROM step_run WHERE item_id = ? AND status = 'active'").get(itemId).id
}

function stepRun(runId) {
  return db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
}

test('a step never picked up by the farm fails within the queue watchdog, distinctly worded from an execution timeout', async () => {
  insertItem.run('T-1', 'Never picked up', 'Medium', 4)
  orchestrator.kick('T-1')
  await wait(10)
  const runId = activeRunId('T-1')

  await wait(700) // > FARM_QUEUE_TIMEOUT_MS(600)
  const run = stepRun(runId)
  assert.equal(run.status, 'cancelled')
  assert.match(run.output, /^FAILED: step was never picked up by the farm/)
  assert.equal(store.getItem('T-1').paused, true)
  // farmd must not still launch this task file after the server gave up on it.
  const cancelCall = dispatches.find((d) => d.url.includes('/steps/cancel') && d.body?.run_id === runId)
  assert.ok(cancelCall, 'failFarmRun must tell the farm to drop the task, not just update its own DB')
})

test('a step that starts late — after the old combined deadline would have killed it — still completes', async () => {
  insertItem.run('T-2', 'Queued past the old deadline, then starts', 'Medium', 4)
  orchestrator.kick('T-2')
  await wait(10)
  const runId = activeRunId('T-2')

  // Still queued past FARM_STEP_TIMEOUT_MS (300ms) — under the old single
  // dispatch-time clock this step would already be dead. It survives because
  // the queue watchdog (600ms) hasn't fired yet.
  await wait(400)
  assert.equal(stepRun(runId).status, 'active', 'queue watchdog fired too early')

  const started = orchestrator.markFarmRunStarted(runId)
  assert.deepEqual(started, { ok: true, active: true })
  assert.ok(stepRun(runId).agent_started_at, 'agent_started_at must be stamped once the farm confirms a launch')

  // Within the execution budget counted from the start signal, not from dispatch.
  await wait(150)
  const result = await orchestrator.completeFarmRun(runId, { summary: 'finished after a late start' })
  assert.deepEqual(result, { ok: true })
  assert.equal(stepRun(runId).status, 'done')
  assert.equal(store.getItem('T-2').cursor, 5)
})

test('a duplicate started signal is idempotent — it does not reset the execution clock', async () => {
  insertItem.run('T-3', 'Duplicate started POST', 'Medium', 4)
  orchestrator.kick('T-3')
  await wait(10)
  const runId = activeRunId('T-3')

  assert.deepEqual(orchestrator.markFarmRunStarted(runId), { ok: true, active: true })
  const firstStamp = stepRun(runId).agent_started_at
  await wait(5)
  assert.deepEqual(orchestrator.markFarmRunStarted(runId), { ok: true, active: true })
  assert.equal(stepRun(runId).agent_started_at, firstStamp, 'a duplicate started call must not re-stamp/re-arm')

  orchestrator.cancel('T-3')
})

test('a cancelled run rejects a late started signal — it must not be resurrected', async () => {
  insertItem.run('T-4', 'Cancelled before it started', 'Medium', 4)
  orchestrator.kick('T-4')
  await wait(10)
  const runId = activeRunId('T-4')

  orchestrator.cancel('T-4')
  assert.equal(stepRun(runId).status, 'cancelled')

  const started = orchestrator.markFarmRunStarted(runId)
  assert.deepEqual(started, { ok: true, active: false })
  assert.equal(stepRun(runId).agent_started_at, null)
})

// ---- rearmFarmRuns: surviving a server restart mid-run (HZ-57) ----

function activeStepRunRow(itemId, { stepIndex = 4, agentStartedAt = null, startedAt = null } = {}) {
  const startedAtSql = startedAt ? `'${startedAt}'` : "datetime('now')"
  const agent = STEPS[stepIndex].agent
  return db
    .prepare(
      `INSERT INTO step_run (item_id, step_index, attempt, agent, status, started_at, agent_started_at)
       VALUES (?, ?, 1, ?, 'active', ${startedAtSql}, ?)`,
    )
    .run(itemId, stepIndex, agent, agentStartedAt).lastInsertRowid
}

test('rearmFarmRuns arms the REMAINING execution budget, not a fresh grant, on restart', async () => {
  insertItem.run('T-5', 'Mid-execution restart', 'Medium', 4)
  // agent_started_at 150ms in the past; FARM_STEP_TIMEOUT_MS is 300ms, so
  // ~150ms of budget remains. A fresh-grant bug would instead give a full 300ms.
  const agentStartedAt = new Date(Date.now() - 150).toISOString()
  const runId = activeStepRunRow('T-5', { stepIndex: 4, agentStartedAt })

  orchestrator.rearmFarmRuns()
  await wait(80)
  assert.equal(stepRun(runId).status, 'active', 'died far too early for a ~150ms remaining budget')
  await wait(150) // 230ms after rearm: past the correct ~150ms remaining, short of a fresh 300ms grant
  assert.equal(stepRun(runId).status, 'cancelled', 'still alive at 230ms — looks like a fresh grant, not the remaining budget')
})

test('rearmFarmRuns falls back to started_at (dispatch time) for a pre-migration row with no agent_started_at', async () => {
  insertItem.run('T-6', 'Pre-migration active row', 'Medium', 4)
  // Simulates a row that was already active before agent_started_at existed:
  // NULL agent_started_at, but an old dispatch-time started_at. Must be
  // treated as "possibly already executing" (execution budget from
  // started_at), never as "never picked up" (the much longer queue budget).
  const startedAt = new Date(Date.now() - 150).toISOString()
  const runId = activeStepRunRow('T-6', { stepIndex: 4, agentStartedAt: null, startedAt })

  orchestrator.rearmFarmRuns()
  await wait(80)
  assert.equal(stepRun(runId).status, 'active', 'died far too early for a ~150ms remaining budget')
  await wait(150) // 230ms after rearm: the 600ms queue budget would still be alive here — proving the bug is fixed
  assert.equal(
    stepRun(runId).status,
    'cancelled',
    'still alive at 230ms — treated the pre-migration row as freshly queued instead of already executing',
  )
})

// ---- implement-step allowance stays distinct from the queue watchdog ----

test('the queue watchdog does not grant the implement-step floor while a step is only queued', async () => {
  insertItem.run('T-7', 'Implement step queued, never started', 'Medium', IMPLEMENT_STEP_INDEX)
  orchestrator.kick('T-7')
  await wait(10)
  const runId = activeRunId('T-7')

  await wait(700) // > FARM_QUEUE_TIMEOUT_MS(600) — must fail on the queue clock, not get a 50-minute floor
  const run = stepRun(runId)
  assert.equal(run.status, 'cancelled')
  assert.match(run.output, /^FAILED: step was never picked up by the farm/)
})

test('the implement-step execution floor still applies once the step has started', async () => {
  insertItem.run('T-8', 'Implement step started', 'Medium', IMPLEMENT_STEP_INDEX)
  orchestrator.kick('T-8')
  await wait(10)
  const runId = activeRunId('T-8')

  assert.deepEqual(orchestrator.markFarmRunStarted(runId), { ok: true, active: true })
  await wait(450) // well past FARM_STEP_TIMEOUT_MS(300) — the plain execution budget would have killed this
  assert.equal(stepRun(runId).status, 'active', 'implement step was held to the plain FARM_STEP_TIMEOUT_MS, not its floor')

  orchestrator.cancel('T-8') // clear the (still 50-minute-scale) execution timer so the test process can exit
})
