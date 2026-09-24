// HZ-76: most step failures are transient (farm briefly unreachable, a
// callback timed out, a step sat unpicked, an implement attempt ran out of
// turn budget) and a human adds nothing by being paged for them. Only a
// small, explicit set of reasons is ever auto-retried, under a hard cap
// that's enforced in code AND persisted on step_run.auto_retry_count — never
// decided by an agent or a prompt (see failFarmRun/kick in orchestrator.js).
//
// checks-failed (a real guardrail violation) and any other/untagged failure
// must still pause immediately — that's the signal the code is wrong, and
// auto-retry must never mask it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-auto-retry-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire during these tests
process.env.FARM_STEP_TIMEOUT_MS = '600000'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

let dispatchBehavior = () => ({ ok: true, json: async () => ({}) })
globalThis.fetch = async (url, opts) => dispatchBehavior(String(url), opts?.body ? JSON.parse(opts.body) : null)

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')
const insertAbandoned = db.prepare(
  `INSERT INTO work_item (id, title, priority, cursor, abandoned_at, abandoned_reason, abandoned_by)
   VALUES (?, ?, 'Medium', ?, datetime('now'), ?, ?)`,
)

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function activeRun(itemId) {
  return db.prepare("SELECT * FROM step_run WHERE item_id = ? AND status = 'active'").get(itemId)
}

function eventTexts(itemId) {
  return db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(itemId).map((r) => r.text)
}

function activeStepRunRow(itemId, stepIndex, autoRetryCount = 0) {
  const agent = STEPS[stepIndex].agent
  return db
    .prepare(
      `INSERT INTO step_run (item_id, step_index, attempt, agent, status, auto_retry_count)
       VALUES (?, ?, 1, ?, 'active', ?)`,
    )
    .run(itemId, stepIndex, agent, autoRetryCount).lastInsertRowid
}

test('a retryable reason under the cap auto-retries: item stays unpaused, a fresh run is dispatched, and the retry is visible in the activity feed', async () => {
  insertItem.run('AR-1', 'Retries once', 'Medium', IMPLEMENT_STEP_INDEX)
  const runId = activeStepRunRow('AR-1', IMPLEMENT_STEP_INDEX)

  const result = orchestrator.failFarmRun(runId, 'could not reach the farm', 'unreachable')
  await wait(10)

  assert.deepEqual(result, { ok: true, retried: true })
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status, 'cancelled')
  assert.equal(store.getItem('AR-1').paused, false, 'a retryable failure under the cap must not pause the item')

  const retried = activeRun('AR-1')
  assert.ok(retried, 'a fresh run must be dispatched automatically — no human action')
  assert.equal(retried.auto_retry_count, 1)

  // Visible in the activity feed end-to-end (store.listItems(), not just the
  // internal addEvent call) — a retry nobody can see is worse than a pause.
  const item = store.listItems().find((it) => it.id === 'AR-1')
  assert.ok(
    item.events.some((e) => /auto-retrying \(1\/3\)/.test(e.text)),
    'the retry must show up in the item events the UI activity feed reads',
  )

  orchestrator.cancel('AR-1') // clear the retried run's own (real) watchdog timer so the process can exit
})

test('the auto-retry budget is a hard, DB-persisted cap: driving a step past it pauses rather than looping forever', async () => {
  insertItem.run('AR-2', 'Exhausts the cap', 'Medium', IMPLEMENT_STEP_INDEX)
  let runId = activeStepRunRow('AR-2', IMPLEMENT_STEP_INDEX)

  for (let attempt = 1; attempt <= orchestrator.AUTO_RETRY_CAP; attempt++) {
    const result = orchestrator.failFarmRun(runId, 'step timed out', 'timeout')
    assert.deepEqual(result, { ok: true, retried: true }, `attempt ${attempt} should still be under the cap`)
    const retried = activeRun('AR-2')
    assert.equal(retried.auto_retry_count, attempt)
    runId = retried.id
  }

  // One more failure at the cap must pause instead of retrying again.
  const result = orchestrator.failFarmRun(runId, 'step timed out', 'timeout')
  assert.deepEqual(result, { ok: true })
  assert.equal(store.getItem('AR-2').paused, true, 'the cap must be enforced — this must pause, not loop forever')
  assert.equal(activeRun('AR-2'), undefined, 'no further run may be dispatched once the cap is reached')

  const retryEvents = eventTexts('AR-2').filter((t) => /auto-retrying/.test(t))
  assert.equal(retryEvents.length, orchestrator.AUTO_RETRY_CAP, 'exactly the capped number of retries, never more')
  assert.ok(
    eventTexts('AR-2').some((t) => /budget \(3\) exhausted/.test(t)),
    'the exhaustion pause must name the exhausted budget, distinctly from an ordinary pause',
  )
})

test('checks-failed (and any other untagged failure) never auto-retries — it pauses immediately, budget or not', async () => {
  insertItem.run('AR-3', 'Guardrail violation', 'Medium', IMPLEMENT_STEP_INDEX)
  const runId = activeStepRunRow('AR-3', IMPLEMENT_STEP_INDEX)

  // No reason argument at all — exactly what a checks-failed RuntimeError
  // from farm/step_agent.py produces (see farm/tests/test_step_agent.py's
  // test_main_does_not_tag_a_reason_for_an_ordinary_failure).
  const result = orchestrator.failFarmRun(runId, 'repo checks failed: eslint exited 1')

  assert.deepEqual(result, { ok: true })
  assert.equal(store.getItem('AR-3').paused, true, 'checks-failed is the signal the code is wrong — it must pause immediately')
  assert.equal(activeRun('AR-3'), undefined, 'no retry may fire for an untagged failure')
})

test('an unrecognized reason string also defaults to pause, not retry — only the explicit allowlist is retryable', async () => {
  insertItem.run('AR-4', 'Unknown reason', 'Medium', IMPLEMENT_STEP_INDEX)
  const runId = activeStepRunRow('AR-4', IMPLEMENT_STEP_INDEX)

  const result = orchestrator.failFarmRun(runId, 'something odd happened', 'not_a_real_reason')

  assert.deepEqual(result, { ok: true })
  assert.equal(store.getItem('AR-4').paused, true)
  assert.equal(activeRun('AR-4'), undefined)
})

test('the retry counter resets to 0 on any non-automatic dispatch — a human resume does not carry the budget forward', async () => {
  insertItem.run('AR-5', 'Resets on resume', 'Medium', IMPLEMENT_STEP_INDEX)
  const runId1 = activeStepRunRow('AR-5', IMPLEMENT_STEP_INDEX)

  orchestrator.failFarmRun(runId1, 'step timed out', 'timeout')
  await wait(10)
  const retried = activeRun('AR-5')
  assert.equal(retried.auto_retry_count, 1)

  // Simulate a human resume: cancel the in-flight (auto-retried) run and
  // unpause, then dispatch the ordinary way — kick(id) with no opts, exactly
  // like every human-resume/gate/review call site.
  orchestrator.cancel('AR-5')
  db.prepare('UPDATE work_item SET paused = 0 WHERE id = ?').run('AR-5')
  orchestrator.kick('AR-5')
  await wait(10)

  const resumed = activeRun('AR-5')
  assert.ok(resumed)
  assert.equal(resumed.auto_retry_count, 0, 'a normal dispatch must reset the auto-retry budget, not inherit it')

  orchestrator.cancel('AR-5')
})

test('a mixed-reason sequence shares ONE cumulative counter — timeout then unreachable both draw from the same budget', async () => {
  insertItem.run('AR-6', 'Mixed reasons', 'Medium', IMPLEMENT_STEP_INDEX)
  const runId1 = activeStepRunRow('AR-6', IMPLEMENT_STEP_INDEX)

  orchestrator.failFarmRun(runId1, 'step timed out', 'timeout')
  const afterTimeout = activeRun('AR-6')
  assert.equal(afterTimeout.auto_retry_count, 1)

  orchestrator.failFarmRun(afterTimeout.id, 'could not reach the farm', 'unreachable')
  const afterUnreachable = activeRun('AR-6')
  assert.equal(afterUnreachable.auto_retry_count, 2, 'unreachable must continue the SAME counter timeout started, not its own')

  orchestrator.failFarmRun(afterUnreachable.id, 'step was never picked up by the farm', 'never_picked_up')
  const afterThird = activeRun('AR-6')
  assert.equal(afterThird.auto_retry_count, 3)

  // One more (any retryable reason) must now hit the shared cap.
  orchestrator.failFarmRun(afterThird.id, 'step timed out', 'timeout')
  assert.equal(store.getItem('AR-6').paused, true)
  assert.equal(activeRun('AR-6'), undefined)
})

test('an abandoned item never gets auto-retried, even mid-flight — matches the HZ-59 dispatch guard', async () => {
  insertAbandoned.run('AR-7', 'Abandoned mid-step', IMPLEMENT_STEP_INDEX, 'no longer needed', 'Dana')
  const runId = activeStepRunRow('AR-7', IMPLEMENT_STEP_INDEX)

  const result = orchestrator.failFarmRun(runId, 'could not reach the farm', 'unreachable')

  assert.deepEqual(result, { ok: true })
  assert.equal(activeRun('AR-7'), undefined, 'an abandoned item must never be kicked back into dispatch, retryable reason or not')
})

test('a real dispatch failure (farm unreachable) auto-recovers through dispatchToFarm itself, not just a direct failFarmRun call', async () => {
  insertItem.run('AR-8', 'Farm unreachable at dispatch', 'Medium', IMPLEMENT_STEP_INDEX)

  // The farm is unreachable for exactly the FIRST dispatch attempt (a brief
  // outage), then comes back — the retry itself must succeed, matching the
  // success metric ("recovers with NO human action"), not cascade into
  // another failure.
  let runCalls = 0
  dispatchBehavior = (url) => {
    if (url.includes('/steps/run')) {
      runCalls++
      if (runCalls === 1) throw new Error('connect ECONNREFUSED')
    }
    return { ok: true, json: async () => ({}) }
  }
  try {
    orchestrator.kick('AR-8')
    await wait(30)
  } finally {
    dispatchBehavior = () => ({ ok: true, json: async () => ({}) })
  }

  assert.equal(runCalls, 2, 'expected exactly one failed dispatch and one successful retry dispatch')
  assert.equal(store.getItem('AR-8').paused, false, 'a farm-unreachable dispatch failure must recover with no human action')
  const retried = activeRun('AR-8')
  assert.ok(retried, 'dispatchToFarm catch must have auto-retried via failFarmRun(..., "unreachable")')
  assert.equal(retried.auto_retry_count, 1)

  orchestrator.cancel('AR-8')
})
