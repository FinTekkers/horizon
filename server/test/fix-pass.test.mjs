// HZ-182: after a review rejection, a fix-only implement run and a delta
// review of only what changed. Driven through the real kick → dispatch →
// completeFarmRun path, reading the task each dispatch actually sends.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-fix-pass-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, REVIEW_STEP_INDEX, IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const dispatches = []
globalThis.fetch = async (url, init) => {
  dispatches.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
  return { ok: true, json: async () => ({}) }
}

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')
const used = []
after(() => used.forEach((id) => orchestrator.cancel(id)))

function lastDispatch(id, stepIndex) {
  const found = dispatches.filter((d) => d.url.endsWith('/steps/run') && d.body.item.id === id && d.body.step.index === stepIndex)
  assert.ok(found.length > 0, `no /steps/run dispatch for ${id} step ${stepIndex}`)
  return found.at(-1).body
}

const QA_PASS = { verdict: 'pass', regression_tests_run: true, new_code_unit_coverage: true, e2e_test_present: true, findings: [] }
const PASS = { code_review: { verdict: 'pass', findings: [] }, qa_review: QA_PASS }
const FINDING = { file: 'server/src/x.js', line: 42, severity: 'block', detail: 'unguarded lookup' }
const failVerdict = (findings = [FINDING]) => ({ code_review: { verdict: 'fail', findings }, qa_review: QA_PASS })

// An item at the review step whose first (full) review has been dispatched.
function startAtReview(id) {
  used.push(id)
  insertItem.run(id, `fix pass ${id}`, 'Medium', REVIEW_STEP_INDEX)
  orchestrator.kick(id)
  return lastDispatch(id, REVIEW_STEP_INDEX)
}

async function review(id, verdict, extra = {}) {
  const task = lastDispatch(id, REVIEW_STEP_INDEX)
  return orchestrator.completeFarmRun(task.run_id, {
    summary: 'reviewed',
    artifacts: { artifact_md: '## Code review', verdict, reviewed_sha: 'aaaaaaa1', ...extra },
  })
}

async function implement(id, artifacts) {
  const task = lastDispatch(id, IMPLEMENT_STEP_INDEX)
  return orchestrator.completeFarmRun(task.run_id, { summary: 'fixed', artifacts })
}

// A rejected full review, then a fix pass whose diff is `lines` long.
async function toDeltaReview(id, implementArtifacts = { fix_diff_lines: 12 }) {
  startAtReview(id)
  await review(id, failVerdict())
  await implement(id, implementArtifacts)
  return lastDispatch(id, REVIEW_STEP_INDEX)
}

const deltaReply = (verdict, previous, files = ['server/src/x.js']) => ({
  reviewed_sha: 'bbbbbbb2',
  review_mode: 'delta',
  delta_files: files,
  verdict: { ...verdict, previous_findings: previous },
})

test('the first review of an item is always a full review', () => {
  const task = startAtReview('FP-FIRST')
  assert.deepEqual(task.scope, { mode: 'full' })
})

test('metric 1: a rejection dispatches a fix-only implement run on a third of the budget, listing the findings', async () => {
  startAtReview('FP-1')
  await review('FP-1', failVerdict())
  const task = lastDispatch('FP-1', IMPLEMENT_STEP_INDEX)
  assert.equal(task.scope.mode, 'fix')
  assert.equal(task.scope.base_sha, 'aaaaaaa1')
  assert.equal(task.scope.max_turns, Math.floor(STEPS[IMPLEMENT_STEP_INDEX].maxTurns / 3))
  assert.equal(task.scope.max_turns, 53)
  assert.ok(task.scope.max_turns * 3 <= STEPS[IMPLEMENT_STEP_INDEX].maxTurns)
  assert.deepEqual(task.scope.findings, [{ file: 'server/src/x.js', line: 42, detail: 'unguarded lookup' }])
  // The findings reach the prompt once: as the feedback the fix pass reads.
  assert.equal(task.feedback.length, 1)
  assert.match(task.feedback[0].message, /server\/src\/x\.js:42/)
  assert.match(task.feedback[0].message, /unguarded lookup/)
})

test('metric 2: the next review is a delta from the last reviewed commit, carrying the previous findings', async () => {
  const task = await toDeltaReview('FP-2')
  assert.equal(task.scope.mode, 'delta')
  assert.equal(task.scope.base_sha, 'aaaaaaa1')
  assert.deepEqual(task.scope.previous_findings, [{ index: 0, file: 'server/src/x.js', line: 42, detail: 'unguarded lookup' }])
})

test('metric 3: a new block finding in previously reviewed code becomes a note, not a block', async () => {
  await toDeltaReview('FP-3')
  const outside = { file: 'server/src/old.js', line: 7, severity: 'block', detail: 'pre-existing smell' }
  await review('FP-3', null, deltaReply(failVerdict([outside]), [{ index: 0, resolved: true }]))
  const item = store.getItem('FP-3')
  assert.equal(item.cursor, ACCEPT_GATE_INDEX)
  assert.equal(item.review_cycle_count, 1) // only the first, full rejection
  assert.equal(item.last_reviewed_sha, 'bbbbbbb2')
  const run = db.prepare("SELECT artifact FROM step_run WHERE item_id = 'FP-3' AND step_index = ? ORDER BY id DESC").get(REVIEW_STEP_INDEX)
  assert.match(run.artifact, /## Notes — outside the fix diff, not blocking/)
  assert.match(run.artifact, /server\/src\/old\.js:7/)
})

test('a fix-pass review blocks on a defect inside the fix diff', async () => {
  await toDeltaReview('FP-3B')
  const inside = { file: 'server/src/x.js', line: 50, severity: 'block', detail: 'fix introduced a crash' }
  await review('FP-3B', null, deltaReply(failVerdict([inside]), [{ index: 0, resolved: true }]))
  const item = store.getItem('FP-3B')
  assert.equal(item.cursor, IMPLEMENT_STEP_INDEX)
  assert.equal(item.review_cycle_count, 2)
  assert.deepEqual(JSON.parse(item.fix_findings_json), [{ file: 'server/src/x.js', line: 50, detail: 'fix introduced a crash' }])
})

test('a previous finding counts as resolved only on a boolean true: a string is malformed, an omission blocks', async () => {
  await toDeltaReview('FP-STR')
  await review('FP-STR', null, deltaReply(PASS, [{ index: 0, resolved: 'true' }]))
  assert.equal(store.getItem('FP-STR').paused, true) // malformed: a string is not a boolean
  await toDeltaReview('FP-MISS')
  await review('FP-MISS', null, deltaReply(PASS, [])) // the finding was never reported
  const item = store.getItem('FP-MISS')
  assert.equal(item.cursor, IMPLEMENT_STEP_INDEX)
  assert.match(JSON.parse(item.fix_findings_json)[0].detail, /^unresolved: unguarded lookup/)
})

test('fail closed: a malformed fix-pass verdict pauses the item and never advances it', async () => {
  await toDeltaReview('FP-BAD')
  const reply = deltaReply(PASS, [{ index: 0, resolved: true }])
  delete reply.verdict.previous_findings
  await review('FP-BAD', null, reply)
  const item = store.getItem('FP-BAD')
  assert.equal(item.cursor, REVIEW_STEP_INDEX)
  assert.equal(item.paused, true)
  assert.equal(item.review_cycle_count, 1)
})

test('fail closed: an unparseable reviewer reply, as the farm shapes it, is a reject', async () => {
  // A `{}` reply from both reviewers: the farm coerces each verdict to fail
  // with no findings and merges every previous finding as unresolved.
  await toDeltaReview('FP-JUNK')
  const junk = {
    code_review: { verdict: 'fail', findings: [] },
    qa_review: { verdict: 'fail', regression_tests_run: false, new_code_unit_coverage: false, e2e_test_present: false, findings: [] },
  }
  await review('FP-JUNK', null, deltaReply(junk, [{ index: 0, resolved: false, detail: '' }], []))
  const item = store.getItem('FP-JUNK')
  assert.equal(item.cursor, IMPLEMENT_STEP_INDEX)
  assert.equal(item.review_cycle_count, 2)
})

test('a delta dispatch the farm ran as a full review is judged by the full rules', async () => {
  await toDeltaReview('FP-FALLBACK')
  const outside = { file: 'server/src/old.js', line: 7, severity: 'block', detail: 'real problem' }
  await review('FP-FALLBACK', failVerdict([outside]), { reviewed_sha: 'ccccccc3', review_mode: 'full', scope_fallback: 'base_not_ancestor' })
  assert.equal(store.getItem('FP-FALLBACK').cursor, IMPLEMENT_STEP_INDEX)
})

test('guardrail: fix-pass cycles count toward the cap of 3', async () => {
  await toDeltaReview('FP-CAP')
  const inside = { file: 'server/src/x.js', line: 1, severity: 'block', detail: 'still broken' }
  await review('FP-CAP', null, deltaReply(failVerdict([inside]), [{ index: 0, resolved: false }]))
  await implement('FP-CAP', { fix_diff_lines: 3 })
  assert.equal(lastDispatch('FP-CAP', REVIEW_STEP_INDEX).scope.mode, 'delta')
  await review('FP-CAP', null, deltaReply(failVerdict([inside]), [{ index: 0, resolved: false }]))
  const item = store.getItem('FP-CAP')
  assert.equal(item.review_cycle_count, 3)
  assert.equal(item.cursor, ACCEPT_GATE_INDEX)
  assert.equal(item.fix_pass, 0)
})

test('metric 4: a fix diff over 200 changed lines gets a full review; 200 stays a delta', async () => {
  assert.equal((await toDeltaReview('FP-200', { fix_diff_lines: 200 })).scope.mode, 'delta')
  assert.deepEqual((await toDeltaReview('FP-201', { fix_diff_lines: 201 })).scope, { mode: 'full' })
})

test('metric 4: a merge from main over the PR files gets a full review', async () => {
  const task = await toDeltaReview('FP-MAIN', { scope_fallback: 'main_merged' })
  assert.deepEqual(task.scope, { mode: 'full' })
})

test('an older farm that reports no fix diff size gets a full review', async () => {
  assert.deepEqual((await toDeltaReview('FP-OLD', {})).scope, { mode: 'full' })
})

test('a human send-back clears the fix pass: the next implement is full, on the full budget', async () => {
  startAtReview('FP-HUMAN')
  await review('FP-HUMAN', failVerdict())
  orchestrator.cancel('FP-HUMAN')
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, 'FP-HUMAN')
  store.requestChanges('FP-HUMAN', STEPS[ACCEPT_GATE_INDEX].label, 'redo it', 'You')
  const item = store.getItem('FP-HUMAN')
  assert.equal(item.fix_pass, 0)
  assert.equal(item.last_reviewed_sha, null)
  assert.deepEqual(orchestrator.implementScope(item), { mode: 'full' })
})
