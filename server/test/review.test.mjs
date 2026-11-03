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
const { STEPS, REVIEW_STEP_INDEX, IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
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

// ---- HZ-751: regression_tests_run comes from the final check round ----
// The stored rows of the latest implement run decide the flag, on both the
// full and the delta review path; the reviewers' value stands only when the
// run had no checks. Rows are inserted straight into test_result.

const CHECKS = ['scripts/checks/test.sh', 'scripts/checks/lint.sh', 'scripts/checks/e2e.sh', 'scripts/checks/smoke.sh']
const SHA_A = 'a'.repeat(40)
const SHA_C = 'c'.repeat(40)
const insertTestRow = db.prepare(
  `INSERT INTO test_result (repo, commit_sha, tree_sha, item_id, run_id, source, check_run, command, test, status, attempt, created_at_ms, run_label, exit_code)
   VALUES ('acme/ledger', ?, ?, ?, ?, 'implement', ?, ?, ?, ?, 1, 0, ?, ?)`,
)

function checkRound(id, runId, checkRun, sha, exits, label = 'main') {
  for (const [command, exit] of Object.entries(exits)) {
    insertTestRow.run(sha, 'e'.repeat(40), id, runId, checkRun, command, `${command} test`, exit === 0 ? 'pass' : 'fail', label, exit)
  }
}

const allExit = (code) => Object.fromEntries(CHECKS.map((c) => [c, code]))

// The four shapes of the metric-4 table: [name, rounds, LLM flag, flag expected].
const FLAG_CASES = [
  ['final round ran every check', (id, run) => {
    checkRound(id, run, `${id}-r1`, SHA_A, { ...allExit(0), [CHECKS[0]]: 1 })
    checkRound(id, run, `${id}-r2`, SHA_C, allExit(0))
  }, false, true],
  ['final round has no main commands', (id, run) => checkRound(id, run, `${id}-b`, SHA_C, { 'scripts/checks/mine.sh': 0 }, 'branch'), true, false],
  ['final round ran 1 of 4 checks', (id, run) => {
    checkRound(id, run, `${id}-r1`, SHA_A, { ...allExit(0), [CHECKS[0]]: 1 })
    checkRound(id, run, `${id}-r2`, SHA_C, { [CHECKS[1]]: 0 })
  }, true, false],
  ['no checks expected', null, true, true],
]

function implementWithChecks(id, rounds) {
  const run = Number(
    db
      .prepare(
        "INSERT INTO step_run (item_id, step_index, attempt, agent, status, ended_at, test_runs_expected) VALUES (?, ?, 1, ?, 'done', datetime('now'), ?)",
      )
      .run(id, IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent, rounds ? 4 : null).lastInsertRowid,
  )
  if (!rounds) return
  rounds(id, run)
  db.prepare("INSERT INTO check_pass (repo, item_id, sha, finished_at, source) VALUES ('acme/ledger', ?, ?, datetime('now'), 'implement')").run(id, SHA_C)
}

// QA fails on a finding of its own either way, so the flag's block shows
// only through the stored findings.
const qaFailVerdict = (flag) => ({
  code_review: { verdict: 'pass', findings: [] },
  qa_review: {
    verdict: 'fail',
    regression_tests_run: flag,
    new_code_unit_coverage: true,
    e2e_test_present: true,
    findings: [{ file: 'server/src/x.js', line: 1, severity: 'block', detail: 'a QA finding' }],
  },
})

const storedBlocks = (id) => JSON.parse(db.prepare('SELECT fix_findings_json AS f FROM work_item WHERE id = ?').get(id).f)
const FLAG_BLOCK = 'QA: regression_tests_run is false'

for (const [i, [name, rounds, llmFlag, expected]] of FLAG_CASES.entries()) {
  test(`HZ-751 full review: ${name} → regression_tests_run ${expected}`, async () => {
    const id = `R-FLAG-F${i}`
    insertItem.run(id, name, 'Medium', REVIEW_STEP_INDEX)
    implementWithChecks(id, rounds)
    const verdict = qaFailVerdict(llmFlag)
    await orchestrator.completeFarmRun(activeRunFor(id, REVIEW_STEP_INDEX), { summary: 'reviewed', artifacts: { artifact_md: '# r', verdict } })
    orchestrator.cancel(id)
    assert.equal(verdict.qa_review.regression_tests_run, expected)
    const details = storedBlocks(id).map((f) => f.detail)
    assert.equal(details.includes(FLAG_BLOCK), !expected, details.join(' | '))
  })

  test(`HZ-751 delta review: ${name} → regression_tests_run ${expected}`, async () => {
    const id = `R-FLAG-D${i}`
    insertItem.run(id, name, 'Medium', REVIEW_STEP_INDEX)
    const previous = [{ file: 'server/src/x.js', line: 1, detail: 'an earlier finding', index: 0 }]
    db.prepare("UPDATE work_item SET fix_pass = 1, last_reviewed_sha = 'aaaaaaa1', fix_findings_json = ? WHERE id = ?").run(JSON.stringify(previous), id)
    implementWithChecks(id, rounds)
    const runId = activeRunFor(id, REVIEW_STEP_INDEX)
    db.prepare('UPDATE step_run SET scope_json = ? WHERE id = ?').run(
      JSON.stringify({ mode: 'delta', base_sha: 'aaaaaaa1', previous_findings: previous }),
      runId,
    )
    const verdict = { ...qaFailVerdict(llmFlag), previous_findings: [{ index: 0, resolved: true }] }
    await orchestrator.completeFarmRun(runId, {
      summary: 'reviewed',
      artifacts: { artifact_md: '# r', verdict, review_mode: 'delta', reviewed_sha: 'bbbbbbb2', delta_files: ['server/src/x.js'] },
    })
    orchestrator.cancel(id)
    assert.equal(verdict.qa_review.regression_tests_run, expected)
    const details = storedBlocks(id).map((f) => f.detail)
    assert.ok(details.includes('a QA finding'), 'the delta rules ran')
    assert.equal(details.includes(FLAG_BLOCK), !expected, details.join(' | '))
  })
}

// The delta rules read QA's flags only on a QA fail, so a computed false flag
// must turn a QA pass into a fail for its block to fire.
test('HZ-751 delta review: QA passes but the final round ran 1 of 4 checks → QA fails on the flag', async () => {
  const id = 'R-FLAG-DPASS'
  insertItem.run(id, 'QA pass, partial round', 'Medium', REVIEW_STEP_INDEX)
  const previous = [{ file: 'server/src/x.js', line: 1, detail: 'an earlier finding', index: 0 }]
  db.prepare("UPDATE work_item SET fix_pass = 1, last_reviewed_sha = 'aaaaaaa1', fix_findings_json = ? WHERE id = ?").run(JSON.stringify(previous), id)
  implementWithChecks(id, FLAG_CASES[2][1])
  const runId = activeRunFor(id, REVIEW_STEP_INDEX)
  db.prepare('UPDATE step_run SET scope_json = ? WHERE id = ?').run(
    JSON.stringify({ mode: 'delta', base_sha: 'aaaaaaa1', previous_findings: previous }),
    runId,
  )
  const verdict = {
    code_review: { verdict: 'pass', findings: [] },
    qa_review: { verdict: 'pass', regression_tests_run: true, new_code_unit_coverage: true, e2e_test_present: true, findings: [] },
    previous_findings: [{ index: 0, resolved: true }],
  }
  await orchestrator.completeFarmRun(runId, {
    summary: 'reviewed',
    artifacts: { artifact_md: '# r', verdict, review_mode: 'delta', reviewed_sha: 'bbbbbbb2', delta_files: ['server/src/x.js'] },
  })
  orchestrator.cancel(id)
  assert.equal(verdict.qa_review.regression_tests_run, false)
  assert.equal(verdict.qa_review.verdict, 'fail')
  const details = storedBlocks(id).map((f) => f.detail)
  assert.ok(details.includes(FLAG_BLOCK), details.join(' | '))
  assert.equal(store.getItem(id).cursor, IMPLEMENT_STEP_INDEX)
})
