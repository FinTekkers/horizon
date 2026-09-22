// Automated review verdict routing + the 3-cycle loop cap (HZ-30). The cap is
// enforced by the orchestrator itself — driven directly through
// completeFarmRun the same way orchestrator.test.mjs drives persona
// plumbing, no real farm/LLM needed. This is the literal success metric: a
// guardrail-violating item fails with a specific finding, gets sent back to
// implement, and — if it kept failing — would still reach the human gate
// within exactly 3 loops, proven by the review_cycle_count column.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-review-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, REVIEW_STEP_INDEX, IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()
// dispatchToFarm's fire-and-forget POST — none of these tests assert on it,
// just need it to not throw.
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')

function activeRunFor(id, stepIndex, attempt = 1) {
  return db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, ?, ?)')
    .run(id, stepIndex, attempt, STEPS[stepIndex].agent).lastInsertRowid
}

const PASS_VERDICT = {
  code_review: { verdict: 'pass', findings: [] },
  qa_review: {
    verdict: 'pass',
    regression_tests_run: true,
    new_code_unit_coverage: true,
    e2e_test_present: true,
    findings: [],
  },
}
const failVerdict = (detail) => ({
  code_review: { verdict: 'fail', findings: [{ file: 'server/src/x.js', line: 42, severity: 'block', detail }] },
  qa_review: {
    verdict: 'pass',
    regression_tests_run: true,
    new_code_unit_coverage: true,
    e2e_test_present: true,
    findings: [],
  },
})

// ---- validateVerdict ----

test('validateVerdict accepts a well-formed verdict and rejects malformed ones', () => {
  assert.equal(orchestrator.validateVerdict(PASS_VERDICT), true)
  assert.equal(orchestrator.validateVerdict(null), false)
  assert.equal(orchestrator.validateVerdict({}), false)
  assert.equal(orchestrator.validateVerdict({ code_review: PASS_VERDICT.code_review }), false) // missing qa_review
  assert.equal(
    orchestrator.validateVerdict({ code_review: { verdict: 'pass' }, qa_review: { verdict: 'pass' } }),
    false, // missing the three QA booleans
  )
  assert.equal(
    orchestrator.validateVerdict({
      code_review: { verdict: 'passed', findings: [] }, // wrong enum value
      qa_review: PASS_VERDICT.qa_review,
    }),
    false,
  )
})

// ---- formatReviewFeedback ----

test('formatReviewFeedback names the failing sub-pass and its file:line findings', () => {
  const msg = orchestrator.formatReviewFeedback(failVerdict('leaked a secret to the log'), 2)
  assert.match(msg, /cycle 2\/3/)
  assert.match(msg, /Code review findings/)
  assert.match(msg, /server\/src\/x\.js:42/)
  assert.match(msg, /leaked a secret to the log/)
  assert.doesNotMatch(msg, /QA review findings/) // QA passed — only the failing section is listed
})

test('formatReviewFeedback flags missing QA booleans explicitly', () => {
  const verdict = {
    code_review: { verdict: 'pass', findings: [] },
    qa_review: {
      verdict: 'fail',
      regression_tests_run: true,
      new_code_unit_coverage: true,
      e2e_test_present: false,
      findings: [],
    },
  }
  assert.match(orchestrator.formatReviewFeedback(verdict, 1), /missing: e2e_test_present/)
})

// ---- completeFarmRun verdict routing ----

test('a passing verdict advances past the review step to the human gate', async () => {
  insertItem.run('R-PASS', 'Passes review', 'Medium', REVIEW_STEP_INDEX)
  const runId = activeRunFor('R-PASS', REVIEW_STEP_INDEX)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'both passed',
    artifacts: { artifact_md: '# ok', verdict: PASS_VERDICT },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('R-PASS')
  assert.equal(item.cursor, ACCEPT_GATE_INDEX)
  assert.equal(item.review_cycle_count, 0)
})

test('a malformed verdict fails the run without consuming a review cycle', async () => {
  insertItem.run('R-BAD', 'Malformed verdict', 'Medium', REVIEW_STEP_INDEX)
  const runId = activeRunFor('R-BAD', REVIEW_STEP_INDEX)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'oops',
    artifacts: { artifact_md: '# oops', verdict: { code_review: { verdict: 'pass' } } },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('R-BAD')
  assert.equal(item.cursor, REVIEW_STEP_INDEX) // never advanced
  assert.equal(item.review_cycle_count, 0) // not consumed — infra glitch, not a guardrail violation
  assert.equal(item.paused, true) // paused for a human, same as any other malformed step-result
})

test('the loop-cap boundary: 3 consecutive failing verdicts stop at exactly 3, then forward to the human gate', async () => {
  insertItem.run('R-CAP', 'Repeatedly violates a guardrail', 'Medium', REVIEW_STEP_INDEX)
  for (let cycle = 1; cycle <= 3; cycle++) {
    const runId = activeRunFor('R-CAP', REVIEW_STEP_INDEX, cycle)
    const result = await orchestrator.completeFarmRun(runId, {
      summary: `cycle ${cycle} failed`,
      artifacts: { artifact_md: `# cycle ${cycle}`, verdict: failVerdict(`violation #${cycle}`) },
    })
    assert.deepEqual(result, { ok: true })
    const item = store.getItem('R-CAP')
    assert.equal(item.review_cycle_count, cycle)
    if (cycle < 3) {
      assert.equal(item.cursor, IMPLEMENT_STEP_INDEX) // rolled back for another implement attempt
      // The rollback's kick() immediately dispatches the next implement
      // attempt to the (stubbed) farm — cancel it and simulate that attempt
      // handing back to review, so the next cycle starts clean.
      orchestrator.cancel('R-CAP')
      db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(REVIEW_STEP_INDEX, 'R-CAP')
    } else {
      assert.equal(item.cursor, ACCEPT_GATE_INDEX) // cap reached — forwarded with the failing verdict attached
    }
  }
  assert.equal(store.getItem('R-CAP').review_cycle_count, 3) // the cap, never exceeded

  // Feedback was queued for Eng on each of the two under-cap cycles only.
  const engFeedback = db
    .prepare("SELECT COUNT(*) AS n FROM feedback WHERE item_id = 'R-CAP' AND target = 'Eng'")
    .get().n
  assert.equal(engFeedback, 2)

  // A 4th completeFarmRun is never made by the orchestrator: the item now
  // sits at a gate, and kick() never dispatches a gate.
  orchestrator.kick('R-CAP')
  assert.equal(store.getItem('R-CAP').cursor, ACCEPT_GATE_INDEX)
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'R-CAP' AND step_index = ?").get(REVIEW_STEP_INDEX)
      .n,
    3,
  )
})

test('a fail-then-pass recovery within the cap reaches the gate, cycle count reflects the one real failure', async () => {
  insertItem.run('R-RECOVER', 'Fixed after one failure', 'Medium', REVIEW_STEP_INDEX)
  let runId = activeRunFor('R-RECOVER', REVIEW_STEP_INDEX, 1)
  await orchestrator.completeFarmRun(runId, {
    summary: 'first attempt failed',
    artifacts: { artifact_md: '# 1', verdict: failVerdict('missing test') },
  })
  assert.equal(store.getItem('R-RECOVER').cursor, IMPLEMENT_STEP_INDEX)
  assert.equal(store.getItem('R-RECOVER').review_cycle_count, 1)
  orchestrator.cancel('R-RECOVER') // clear the watchdog the rollback's kick() armed

  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(REVIEW_STEP_INDEX, 'R-RECOVER')
  runId = activeRunFor('R-RECOVER', REVIEW_STEP_INDEX, 2)
  await orchestrator.completeFarmRun(runId, {
    summary: 'second attempt passed',
    artifacts: { artifact_md: '# 2', verdict: PASS_VERDICT },
  })
  const item = store.getItem('R-RECOVER')
  assert.equal(item.cursor, ACCEPT_GATE_INDEX)
  assert.equal(item.review_cycle_count, 1) // only the one real failure counted
})
