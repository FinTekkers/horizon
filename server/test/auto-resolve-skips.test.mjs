// HZ-235 metric line 2: items whose PR still merges cleanly, paused,
// abandoned and closed items get no auto-resolve run; an item whose step is
// running is skipped, then re-checked once that step ends — however it ends —
// and gets a run only if it is still conflicted then. One test per case.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupAutoResolve, REPO } from './helpers/autoResolveHarness.mjs'

const h = await setupAutoResolve('auto-resolve-skips')
const { db, lifecycle, orchestrator, autoResolve, gh, lines } = h
const { ACCEPT_GATE_INDEX, STEPS } = lifecycle
const REVIEW_STEP_INDEX = ACCEPT_GATE_INDEX - 1

beforeEach(() => h.reset())

async function mergeAndSettle(pr) {
  assert.equal((await h.mergeWebhook(pr)).statusCode, 204)
  await autoResolve.whenIdleForTest()
}

const passingVerdict = {
  code_review: { verdict: 'pass', findings: [] },
  qa_review: { verdict: 'pass', findings: [], regression_tests_run: true, new_code_unit_coverage: true, e2e_test_present: true },
}

test('a PR that still merges cleanly gets no run', async () => {
  h.insertItem('SK-CLEAN', { pr: 501 })
  await mergeAndSettle(600)
  assert.equal(h.farmCalls.length, 0)
  assert.deepEqual(h.itemLines('SK-CLEAN'), [`auto-resolve ${REPO} [main moved: merged PR #600] SK-CLEAN PR #501: clean`])
})

test('a paused item gets no run, even when conflicted', async () => {
  h.conflictedAtGate('SK-PAUSED', 502)
  db.prepare('UPDATE work_item SET paused = 1 WHERE id = ?').run('SK-PAUSED')
  await mergeAndSettle(601)
  assert.equal(h.farmCalls.length, 0)
  assert.equal(h.gateAction('SK-PAUSED'), undefined)
  assert.match(h.itemLines('SK-PAUSED')[0], /: skipped \(paused\)$/)
})

test('an abandoned item gets no run, even when conflicted', async () => {
  h.conflictedAtGate('SK-ABANDONED', 503)
  db.prepare("UPDATE work_item SET abandoned_at = datetime('now') WHERE id = ?").run('SK-ABANDONED')
  await mergeAndSettle(602)
  assert.equal(h.farmCalls.length, 0)
  assert.match(h.itemLines('SK-ABANDONED')[0], /: skipped \(abandoned\)$/)
})

test('a closed item gets no run: never considered, and dropped if it closed while waiting', async () => {
  h.insertItem('SK-CLOSED', { cursor: STEPS.length, pr: 504, mergeable: 0 })
  gh.mergeable.set(504, false)
  h.insertItem('SK-CLOSING', { cursor: REVIEW_STEP_INDEX, pr: 505 })
  const run = h.startStep('SK-CLOSING', REVIEW_STEP_INDEX)
  gh.mergeable.set(505, false)
  await mergeAndSettle(603)
  assert.deepEqual(h.itemLines('SK-CLOSED'), [], 'a closed item is not even considered')

  db.prepare("UPDATE step_run SET status = 'done' WHERE id = ?").run(run)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(STEPS.length, 'SK-CLOSING')
  await h.pollTick()
  assert.equal(h.farmCalls.length, 0)
  assert.match(h.itemLines('SK-CLOSING').at(-1), /: skipped \(closed\)$/)
  assert.ok(!autoResolve.waitingForTest().includes('SK-CLOSING'))
})

test('step running: skipped, then re-checked when review completes, and gets exactly one run', async () => {
  h.insertItem('SK-REVIEW', { cursor: REVIEW_STEP_INDEX, pr: 506 })
  const runId = h.startStep('SK-REVIEW', REVIEW_STEP_INDEX)
  gh.mergeable.set(506, false)
  await mergeAndSettle(604)
  assert.equal(h.farmCalls.length, 0)
  assert.deepEqual(h.itemLines('SK-REVIEW'), [`auto-resolve ${REPO} [main moved: merged PR #604] SK-REVIEW PR #506: skipped (step running)`])

  h.farmReplyNext(h.resolved)
  const done = await orchestrator.completeFarmRun(runId, { summary: 'reviewed', artifacts: { verdict: passingVerdict } })
  assert.deepEqual(done, { ok: true })
  assert.equal(h.row('SK-REVIEW').cursor, ACCEPT_GATE_INDEX)
  await h.untilFarmCalls(1)
  await autoResolve.whenIdleForTest()
  assert.equal(h.resolveCallsFor('SK-REVIEW').length, 1)
  assert.equal(h.gateAction('SK-REVIEW').started_by, 'main_moved')
  assert.match(h.itemLines('SK-REVIEW').at(-1), /\[main moved: merged PR #604\] SK-REVIEW PR #506: started — resolved$/)
})

test('a step ended by cancel/supersede tells no listener: the next poll tick re-checks and starts one run', async () => {
  h.insertItem('SK-CANCEL', { cursor: REVIEW_STEP_INDEX, pr: 507 })
  h.startStep('SK-CANCEL', REVIEW_STEP_INDEX)
  gh.mergeable.set(507, false)
  await mergeAndSettle(605)
  assert.match(h.itemLines('SK-CANCEL')[0], /: skipped \(step running\)$/)

  // A tick while the step is still running decides nothing and logs nothing.
  await h.pollTick()
  assert.equal(h.itemLines('SK-CANCEL').length, 1)

  orchestrator.cancel('SK-CANCEL', 'superseded')
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, 'SK-CANCEL')
  h.farmReplyNext(h.resolved)
  await h.pollTick()
  assert.equal(h.resolveCallsFor('SK-CANCEL').length, 1)
  assert.match(h.itemLines('SK-CANCEL').at(-1), /: started — resolved$/)

  gh.mergeable.set(507, true)
  await h.pollTick()
  assert.equal(h.farmCalls.length, 1, 'a later tick starts no second run')
})

test('re-checked after its step ends and now clean: no run, one clean line, leaves the list, later ticks start nothing', async () => {
  h.insertItem('SK-NOWCLEAN', { cursor: REVIEW_STEP_INDEX, pr: 508 })
  const runId = h.startStep('SK-NOWCLEAN', REVIEW_STEP_INDEX)
  gh.mergeable.set(508, false)
  await mergeAndSettle(606)
  assert.ok(autoResolve.waitingForTest().includes('SK-NOWCLEAN'))

  gh.mergeable.set(508, true) // implement merged main meanwhile
  await orchestrator.completeFarmRun(runId, { summary: 'reviewed', artifacts: { verdict: passingVerdict } })
  await h.untilLine(/SK-NOWCLEAN PR #508: clean$/)
  await autoResolve.whenIdleForTest()
  assert.equal(h.farmCalls.length, 0)
  assert.equal(h.itemLines('SK-NOWCLEAN').filter((l) => l.endsWith(': clean')).length, 1)
  assert.ok(!autoResolve.waitingForTest().includes('SK-NOWCLEAN'))

  gh.mergeable.set(508, false)
  lines.length = 0
  await h.pollTick()
  assert.equal(h.farmCalls.length, 0)
  assert.deepEqual(h.itemLines('SK-NOWCLEAN'), [])
})
