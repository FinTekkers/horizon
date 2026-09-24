// HZ-33: today ANY step failure pauses the item on first failure — HZ-21 sat
// dead for 3 days waiting for a human that a farm-unreachable blip or a first
// turn-cap exhaustion never needed. failFarmRun now classifies every failure
// into 'infra' | 'turn_cap' | 'checks_failed' and auto-retries the first two
// with backoff, up to a single shared RETRY_BUDGET — never per-category,
// because a per-category budget that resets whenever the category changes
// can't actually cap anything (a farm oscillating infra/turn_cap would retry
// forever). checks_failed never retries: masking a real guardrail violation
// behind a retry is exactly what the guardrails forbid.
//
// These tests drive failFarmRun directly against a manually-inserted active
// step_run row (same pattern as orchestrator-timeout.test.mjs's
// activeStepRunRow helper) rather than a real kick()/dispatch cycle — the
// classification and budget logic doesn't depend on how the run got there.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-retry-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')

function activeRunFor(id, stepIndex = 4, attempt = 1) {
  return db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, ?, ?)')
    .run(id, stepIndex, attempt, STEPS[stepIndex].agent).lastInsertRowid
}

function stepRun(runId) {
  return db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
}

function lastEvent(id) {
  return db.prepare('SELECT * FROM event WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(id)
}

test('an infra failure auto-retries: no pause, backoff scheduled, one activity event, budget recorded', async () => {
  insertItem.run('R-INFRA', 'Farm unreachable', 'Medium', 4)
  const runId = activeRunFor('R-INFRA')

  const result = orchestrator.failFarmRun(runId, 'ECONNREFUSED talking to the farm', 'infra')
  assert.deepEqual(result, { ok: true, retrying: true })

  const item = store.getItem('R-INFRA')
  assert.equal(item.paused, false)
  assert.equal(item.failure_category, 'infra')
  assert.equal(item.failure_cause, 'ECONNREFUSED talking to the farm')
  assert.equal(item.retry_count, 1)
  assert.equal(item.retry_budget, orchestrator.RETRY_BUDGET)
  assert.ok(item.next_retry_at && Date.parse(item.next_retry_at) > Date.now(), 'next_retry_at must be set in the future')

  assert.equal(stepRun(runId).status, 'cancelled')
  assert.equal(stepRun(runId).category, 'infra')

  const event = lastEvent('R-INFRA')
  assert.match(event.text, /infra.* failure \(attempt 1\/3\)/i)
  assert.match(event.text, /auto-retrying/)

  orchestrator.cancel('R-INFRA') // clear the scheduled retry timer so the process can exit
})

test('a turn_cap failure (checkpointed exhaustion, HZ-31) also auto-retries', async () => {
  insertItem.run('R-TURNCAP', 'Implement step hit its turn cap', 'Medium', IMPLEMENT_STEP_INDEX)
  const runId = activeRunFor('R-TURNCAP', IMPLEMENT_STEP_INDEX)

  const result = orchestrator.failFarmRun(runId, 'claude timed out after 2700s', 'turn_cap')
  assert.deepEqual(result, { ok: true, retrying: true })

  const item = store.getItem('R-TURNCAP')
  assert.equal(item.paused, false)
  assert.equal(item.failure_category, 'turn_cap')
  assert.equal(item.retry_count, 1)

  orchestrator.cancel('R-TURNCAP')
})

test('a checks_failed failure never retries — pauses immediately with a full banner, no bare "paused"', async () => {
  insertItem.run('R-CHECKS', 'Repo tests failed', 'Medium', IMPLEMENT_STEP_INDEX)
  const runId = activeRunFor('R-CHECKS', IMPLEMENT_STEP_INDEX)

  const result = orchestrator.failFarmRun(runId, 'repo checks failed (npm test): 2 failing', 'checks_failed')
  assert.deepEqual(result, { ok: true })

  const item = store.getItem('R-CHECKS')
  assert.equal(item.paused, true)
  assert.equal(item.failure_category, 'checks_failed')
  assert.equal(item.failure_cause, 'repo checks failed (npm test): 2 failing')
  assert.equal(item.retry_count, 1)
  assert.equal(item.next_retry_at, null)

  const event = lastEvent('R-CHECKS')
  assert.doesNotMatch(event.text, /auto-retrying/)
  assert.match(event.text, /checks failure/i)
})

test('RETRY_BUDGET is a single counter shared across categories — oscillating categories cannot extend it', async () => {
  insertItem.run('R-OSCILLATE', 'Alternating infra/turn_cap failures', 'Medium', 4)
  const categories = ['infra', 'turn_cap', 'infra'] // RETRY_BUDGET attempts, alternating category every time
  assert.equal(categories.length, orchestrator.RETRY_BUDGET)

  for (let i = 0; i < categories.length; i++) {
    const runId = activeRunFor('R-OSCILLATE', 4, i + 1)
    const result = orchestrator.failFarmRun(runId, `attempt ${i + 1} failed`, categories[i])
    assert.deepEqual(result, { ok: true, retrying: true }, `attempt ${i + 1} should still be within budget`)
    assert.equal(store.getItem('R-OSCILLATE').retry_count, i + 1)
  }

  // One more failure, a THIRD distinct category value in a row — if the
  // budget were tracked per-category (resetting on every category switch)
  // this would look like "attempt 1" of a fresh 'turn_cap' streak and retry
  // again. The shared counter must instead see attempt 4 > RETRY_BUDGET(3)
  // and pause.
  const finalRunId = activeRunFor('R-OSCILLATE', 4, categories.length + 1)
  const finalResult = orchestrator.failFarmRun(finalRunId, 'attempt 4 failed', 'turn_cap')
  assert.deepEqual(finalResult, { ok: true })
  const item = store.getItem('R-OSCILLATE')
  assert.equal(item.paused, true)
  assert.equal(item.retry_count, orchestrator.RETRY_BUDGET + 1)
  assert.equal(item.next_retry_at, null)
  const event = lastEvent('R-OSCILLATE')
  assert.match(event.text, /retry budget \(3\) exhausted/)
})

test('a successful completion after a retry clears the failure/retry streak', async () => {
  insertItem.run('R-RECOVER', 'Recovers after one infra retry', 'Medium', 4)
  const failedRunId = activeRunFor('R-RECOVER', 4, 1)
  orchestrator.failFarmRun(failedRunId, 'transient blip', 'infra')
  assert.equal(store.getItem('R-RECOVER').retry_count, 1)

  const retriedRunId = activeRunFor('R-RECOVER', 4, 2)
  const result = await orchestrator.completeFarmRun(retriedRunId, { summary: 'succeeded on retry' })
  assert.deepEqual(result, { ok: true })

  const item = store.getItem('R-RECOVER')
  assert.equal(item.cursor, 5)
  assert.equal(item.failure_category, null)
  assert.equal(item.failure_cause, null)
  assert.equal(item.retry_count, 0)
  assert.equal(item.retry_budget, null)
  assert.equal(item.next_retry_at, null)
})

test('an unrecognized/missing category falls back to infra (failFarmRun default param)', async () => {
  insertItem.run('R-DEFAULT', 'No category passed', 'Medium', 4)
  const runId = activeRunFor('R-DEFAULT', 4)
  orchestrator.failFarmRun(runId, 'could not hand the step to the farm')
  const item = store.getItem('R-DEFAULT')
  assert.equal(item.failure_category, 'infra')
  orchestrator.cancel('R-DEFAULT')
})

test('a stale run (already superseded) is a no-op, same as before HZ-33', async () => {
  insertItem.run('R-STALE', 'Stale run', 'Medium', 4)
  const runId = activeRunFor('R-STALE', 4)
  db.prepare("UPDATE step_run SET status = 'superseded' WHERE id = ?").run(runId)
  const result = orchestrator.failFarmRun(runId, 'too late', 'infra')
  assert.deepEqual(result, { ok: true, stale: true })
  assert.equal(store.getItem('R-STALE').retry_count, 0)
})
