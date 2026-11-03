// HZ-349: the step-12 reviewers read test results only from the step record
// (HZ-327's test_result rows), grouped 'main' / 'branch' — never from
// test-output files left in the worktree. Driven through the real
// test-runs route and the real kick → dispatch path; the farm is a captured
// fetch stub.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-stored-results-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.STORED_RESULTS_WAIT_MS = '5000'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, requiredStepIndex } = await import('../../domain/js/lifecycle.js')
const { STORED_RESULTS_INPUT_LABEL, STORED_RESULTS_MAX_CHARS, buildStoredResultsInput, finalCheckRound, reviewCheckGate } = await import(
  '../src/storedTestResults.js'
)
const { REPO_ROOT } = await import('./helpers/repoFiles.mjs')

store.purgeDemoItems()

const calls = []
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  return { ok: true, json: async () => ({}) }
}
orchestrator.init({ info: () => {}, warn: () => {} })
const app = buildApp({ logger: false })
const used = []
after(() => used.forEach((id) => orchestrator.cancel(id)))

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const TREE = 'e'.repeat(40)
const MAIN_CMD = 'sh -c git show origin/main:scripts/checks/test.sh | sh'
const BRANCH_CMD = 'sh -c cat scripts/checks/test.sh | sh'
const FIVE = ['credits post', 'debits post', 'fx converts', 'accruals roll', 'rounding is banker']
const STALE = ['stale cleanIntegrationTest one', 'stale cleanIntegrationTest two']

function item(id, cursor) {
  used.push(id)
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo) VALUES (?, ?, ?, ?, ?)').run(id, `Title ${id}`, 'Medium', cursor, 'acme/ledger')
}

function implementRun(id, status = 'done', output = '1 repo check(s) passed') {
  return Number(
    db
      .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, ended_at) VALUES (?, ?, 1, ?, ?, ?, datetime(\'now\'))')
      .run(id, IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent, status, output).lastInsertRowid,
  )
}

const rows = (names, status, command) =>
  names.map((test) => ({ suite: 'LedgerTest', file: null, test, status, duration_ms: 5, command, attempt: 1 }))

function entry(label, checkRun, tests, command, exitCode) {
  return { check_run: checkRun, label, commit_sha: 'c'.repeat(40), tree_sha: TREE, tests, commands: [{ command, attempt: 1, exit_code: exitCode }] }
}

async function postTestRuns(runId, testRuns) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/test-runs`,
    headers: { 'x-farm-secret': config.FARM_SHARED_SECRET },
    payload: { test_runs: testRuns },
  })
  assert.equal(res.statusCode, 200, res.body)
}

function dispatchOf(id, stepIndex) {
  return calls.filter((c) => c.url.endsWith('/steps/run') && c.body?.item?.id === id && c.body?.step?.index === stepIndex).at(-1)?.body
}

const storedInput = (body) => body.artifacts.find((a) => a.label === STORED_RESULTS_INPUT_LABEL)

test('step 12 gets the 5 stored results and the branch failure, and none of the 2 stale worktree results', async () => {
  item('SR-1', REVIEW_STEP_INDEX)
  const runId = implementRun('SR-1')
  await postTestRuns(runId, [
    entry('main', 'cr-main', rows(FIVE, 'pass', MAIN_CMD), MAIN_CMD, 0),
    entry('branch', 'cr-branch', rows(['fx converts'], 'fail', BRANCH_CMD), BRANCH_CMD, 1),
  ])
  // What LS-98's QA trusted: a worktree test-results/ that a later run rewrote.
  const worktree = mkdtempSync(join(tmpdir(), 'hz-349-worktree-'))
  mkdirSync(join(worktree, 'build', 'test-results', 'test'), { recursive: true })
  writeFileSync(
    join(worktree, 'build', 'test-results', 'test', 'TEST-LedgerTest.xml'),
    `<testsuite name="LedgerTest">${STALE.map((n) => `<testcase name="${n}"/>`).join('')}</testsuite>`,
  )

  orchestrator.kick('SR-1')
  await tick()
  const body = dispatchOf('SR-1', REVIEW_STEP_INDEX)
  assert.ok(body, 'no step-12 dispatch')
  const input = storedInput(body)
  assert.ok(input, `no "${STORED_RESULTS_INPUT_LABEL}" input`)

  const [main, branch] = input.content.split('### branch')
  for (const name of FIVE) assert.match(main, new RegExp(`- LedgerTest › ${name}\\b`))
  assert.match(main, /Totals: 5 passed, 0 failed, 0 skipped\./)
  assert.ok(main.includes(`\`${MAIN_CMD}\` — exit 0`), main)
  assert.match(branch, /Totals: 0 passed, 1 failed, 0 skipped\./)
  assert.match(branch, /Failed:\n- LedgerTest › fx converts/)
  assert.ok(branch.includes(`\`${BRANCH_CMD}\` — exit 1`), branch)
  for (const name of STALE) assert.ok(!input.content.includes(name), `stale result ${name} reached the reviewer`)
})

test('the latest done implement run wins; a newer run that did not finish is ignored', async () => {
  item('SR-2', REVIEW_STEP_INDEX)
  const old = implementRun('SR-2')
  await postTestRuns(old, [entry('main', 'cr-old', rows(['old one', 'old two'], 'pass', MAIN_CMD), MAIN_CMD, 0)])
  const current = implementRun('SR-2')
  await postTestRuns(current, [entry('main', 'cr-new', rows(FIVE, 'pass', MAIN_CMD), MAIN_CMD, 0)])
  const unfinished = implementRun('SR-2', 'superseded')
  await postTestRuns(unfinished, [entry('main', 'cr-unfinished', rows(['never finished'], 'fail', MAIN_CMD), MAIN_CMD, 1)])

  orchestrator.kick('SR-2')
  await tick()
  const content = storedInput(dispatchOf('SR-2', REVIEW_STEP_INDEX)).content

  assert.ok(content.includes(`run #${current}`), content)
  for (const name of FIVE) assert.ok(content.includes(name), name)
  for (const name of ['old one', 'old two', 'never finished']) assert.ok(!content.includes(name), name)
  assert.match(content, /### branch\nNo branch run was recorded/)
})

test('dispatch waits for the rows of an implement run that just passed its checks', async () => {
  item('SR-3', REVIEW_STEP_INDEX)
  const runId = implementRun('SR-3')
  db.prepare("INSERT INTO check_pass (repo, item_id, sha, finished_at, source) VALUES ('acme/ledger', 'SR-3', ?, datetime('now'), 'implement')").run(
    'a'.repeat(40),
  )

  orchestrator.kick('SR-3')
  await tick(300)
  assert.equal(dispatchOf('SR-3', REVIEW_STEP_INDEX), undefined, 'dispatched before the rows arrived')
  await postTestRuns(runId, [entry('main', 'cr-late', rows(FIVE, 'pass', MAIN_CMD), MAIN_CMD, 0)])
  await tick(500)

  const content = storedInput(dispatchOf('SR-3', REVIEW_STEP_INDEX)).content
  for (const name of FIVE) assert.ok(content.includes(name), name)
})

test('other steps get no stored-results input', async () => {
  item('SR-4', requiredStepIndex('Draft implementation plan'))
  orchestrator.kick('SR-4')
  await tick()
  const body = calls.filter((c) => c.url.endsWith('/steps/run') && c.body?.item?.id === 'SR-4').at(-1)?.body
  assert.ok(body)
  assert.equal(storedInput(body), undefined)
})

test('a huge run stays under the cap, failures listed first and totals exact', async () => {
  item('SR-5', REVIEW_STEP_INDEX)
  const runId = implementRun('SR-5')
  const many = Array.from({ length: 5000 }, (_, i) => `passing test number ${i}`)
  await postTestRuns(runId, [
    entry('main', 'cr-big', [...rows(many, 'pass', MAIN_CMD), ...rows(['the one that broke'], 'fail', MAIN_CMD)], MAIN_CMD, 1),
  ])

  orchestrator.kick('SR-5')
  await tick()
  const content = storedInput(dispatchOf('SR-5', REVIEW_STEP_INDEX)).content

  assert.ok(content.length <= STORED_RESULTS_MAX_CHARS, String(content.length))
  assert.match(content, /Totals: 5000 passed, 1 failed, 0 skipped\./)
  assert.ok(content.indexOf('the one that broke') < content.indexOf('passing test number 0'))
  assert.match(content, /more result\(s\) not listed for space — the totals above are exact/)
})

test('both reviewer prompts name the stored-results input as their only test evidence', () => {
  for (const role of ['qa_review.md', 'code_review.md']) {
    const prompt = readFileSync(join(REPO_ROOT, 'farm', 'roles', role), 'utf8')
    assert.ok(prompt.includes(`\`${STORED_RESULTS_INPUT_LABEL}\``), `${role} does not name ${STORED_RESULTS_INPUT_LABEL}`)
    assert.match(prompt, /are \*\*not\*\* evidence/)
  }
})

// ---- HZ-751: review judges the final check round only ----
// US-305: implement's rounds 1 and 2 failed test.sh, fix turn 2 fixed it, and
// round 3 passed all four checks at the sha it pushed. Each round is its own
// check_run and commit_sha under the one implement run_id.

const CHECKS = ['scripts/checks/test.sh', 'scripts/checks/lint.sh', 'scripts/checks/e2e.sh', 'scripts/checks/smoke.sh']
const SHA = { A: 'a'.repeat(40), B: 'b'.repeat(40), C: 'c'.repeat(40), D: 'd'.repeat(40) }
const allExit = (code) => Object.fromEntries(CHECKS.map((c) => [c, code]))
const TEST_SH_FAILS = { ...allExit(0), [CHECKS[0]]: 1 }

// One check round: `exits` maps each command to its exit code, or to a list
// of them for the farm's rerun (attempt 1, attempt 2).
function round(checkRun, commitSha, exits, label = 'main') {
  const runs = Object.entries(exits).flatMap(([command, codes]) =>
    [].concat(codes).map((code, i) => ({ command, attempt: i + 1, code })),
  )
  return {
    check_run: checkRun,
    label,
    commit_sha: commitSha,
    tree_sha: TREE,
    tests: runs.map(({ command, attempt, code }) => ({
      suite: 'Checks',
      file: null,
      test: `${command.split('/').at(-1)} suite`,
      status: code === 0 || code === null ? 'pass' : 'fail',
      duration_ms: 1,
      command,
      attempt,
    })),
    commands: runs.map(({ command, attempt, code }) => ({ command, attempt, exit_code: code })),
  }
}

function checkPass(id, sha, recordedAt = "datetime('now')") {
  db.prepare(
    `INSERT INTO check_pass (repo, item_id, sha, finished_at, source, recorded_at) VALUES ('acme/ledger', ?, ?, datetime('now'), 'implement', ${recordedAt})`,
  ).run(id, sha)
}

// An implement run that expected checks, with US-305's two failed rounds,
// then `final` (entries; none for no final round) and the pushed sha.
async function us305(id, { cursor = REVIEW_STEP_INDEX, final = [round(`${id}-r3`, SHA.C, allExit(0))], pushed = SHA.C, early = true } = {}) {
  item(id, cursor)
  const runId = implementRun(id, 'done', '4 repo check(s) passed')
  db.prepare('UPDATE step_run SET test_runs_expected = 8 WHERE id = ?').run(runId)
  const earlier = early ? [round(`${id}-r1`, SHA.A, TEST_SH_FAILS), round(`${id}-r2`, SHA.B, TEST_SH_FAILS)] : []
  if (earlier.length + final.length > 0) await postTestRuns(runId, [...earlier, ...final])
  if (pushed) checkPass(id, pushed)
  return runId
}

const section = (content, label) => {
  const from = content.indexOf(`### ${label}\n`)
  assert.ok(from >= 0, `no ### ${label} section`)
  const next = content.indexOf('\n### ', from + 1)
  return content.slice(from, next < 0 ? undefined : next)
}

const reviewRunOf = (id) =>
  db.prepare('SELECT id FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id DESC LIMIT 1').get(id, REVIEW_STEP_INDEX).id

// Polls the captured fetch stub, never a timer.
async function reviewDispatch(id) {
  for (let i = 0; i < 2000; i++) {
    const body = dispatchOf(id, REVIEW_STEP_INDEX)
    if (body) return body
    await new Promise((r) => setImmediate(r))
  }
  assert.fail(`no step-12 dispatch for ${id}`)
}

const verdictOf = (qaFlag) => ({
  code_review: { verdict: 'pass', findings: [] },
  qa_review: { verdict: 'pass', regression_tests_run: qaFlag, new_code_unit_coverage: true, e2e_test_present: true, findings: [] },
})

test('metric 1: current evidence is round 3 only; the failed rounds are history, fixed in a later round', async () => {
  const branchOld = round('SR-10-b2', SHA.B, { 'scripts/checks/mine.sh': 0 }, 'branch')
  item('SR-10', REVIEW_STEP_INDEX)
  const runId = implementRun('SR-10')
  await postTestRuns(runId, [
    round('SR-10-r1', SHA.A, TEST_SH_FAILS),
    round('SR-10-r2', SHA.B, TEST_SH_FAILS),
    branchOld,
    round('SR-10-r3', SHA.C, allExit(0)),
  ])
  checkPass('SR-10', SHA.C)

  assert.equal(finalCheckRound('SR-10', runId).state, 'green')
  const { content } = buildStoredResultsInput('SR-10')
  const main = section(content, 'main')
  assert.match(main, /Totals: 4 passed, 0 failed, 0 skipped\./)
  for (const c of CHECKS) assert.ok(main.includes(`\`${c}\` — exit 0`), main)
  assert.ok(!main.includes('exit 1'), main)
  assert.match(section(content, 'branch'), /No branch run was recorded in the final round/)
  const history = section(content, 'History (earlier fix rounds)')
  const testSh = history.split('\n').filter((l) => l.includes(`\`${CHECKS[0]}\``))
  assert.equal(testSh.length, 2, history)
  for (const line of testSh) assert.match(line, /exit 1 — fixed in a later round$/)
  assert.ok(history.includes('- branch round at `bbbbbbbbbbbb`: all 1 command(s) passed'), history)
})

test('metric 1: a final-round command that failed and passed on its rerun is green and still marked (rerun)', async () => {
  const runId = await us305('SR-11', { final: [round('SR-11-r3', SHA.C, { ...allExit(0), [CHECKS[0]]: [1, 0] })] })
  assert.equal(finalCheckRound('SR-11', runId).state, 'green')
  const main = section(buildStoredResultsInput('SR-11').content, 'main')
  assert.ok(main.includes(`\`${CHECKS[0]}\` (rerun) — exit 0`), main)
})

test('metric 2: the US-305 replay reaches review green, and a passing review starts no fix pass', async () => {
  await us305('SR-12')
  orchestrator.kick('SR-12')
  const { content } = storedInput(await reviewDispatch('SR-12'))
  assert.match(section(content, 'Final check round'), /The final check round passed at `cccccccccccc`, the commit implement pushed/)
  assert.doesNotMatch(content, /check failure/i)

  // Review run 8881's QA shape: regression_tests_run false.
  const verdict = verdictOf(false)
  const result = await orchestrator.completeFarmRun(reviewRunOf('SR-12'), { summary: 'reviewed', artifacts: { artifact_md: '# review', verdict } })
  assert.deepEqual(result, { ok: true })
  assert.equal(verdict.qa_review.regression_tests_run, true)
  const after = store.getItem('SR-12')
  assert.ok(after.cursor > REVIEW_STEP_INDEX, `cursor ${after.cursor}`)
  assert.equal(after.fix_pass, 0)
  assert.equal(after.review_cycle_count, 0)
  const implementRuns = db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ?').get('SR-12', IMPLEMENT_STEP_INDEX).n
  assert.equal(implementRuns, 1, 'an implement step was queued')
})

// [id, how the final round goes, expected state, text the reason must hold]
const NOT_GREEN = [
  ['SR-20', { final: [round('SR-20-r3', SHA.C, TEST_SH_FAILS)] }, 'red', /failed: main `scripts\/checks\/test\.sh` exit 1/],
  ['SR-21', { final: [round('SR-21-r3', SHA.D, allExit(0))] }, 'other_sha', /passed at `dddddddddddd`, but implement pushed `cccccccccccc`/],
  ['SR-22', { final: [], early: false, pushed: null }, 'missing', /No final check round was stored/],
  [
    'SR-23',
    { final: [round('SR-23-r3', SHA.C, allExit(0)), round('SR-23-b3', SHA.C, { 'scripts/checks/mine.sh': 1 }, 'branch')] },
    'red',
    /failed: branch `scripts\/checks\/mine\.sh` exit 1/,
  ],
  ['SR-24', { final: [round('SR-24-r3', SHA.C, { ...allExit(0), [CHECKS[2]]: null })] }, 'red', /`scripts\/checks\/e2e\.sh` exit status not recorded/],
]

for (const [id, shape, state, reason] of NOT_GREEN) {
  test(`metric 3: a ${state} final round (${id}) fails review through a server block, though the reviewers passed`, async () => {
    const runId = await us305(id, shape)
    assert.equal(finalCheckRound(id, runId).state, state)
    const { content } = buildStoredResultsInput(id)
    assert.match(content, /this is a check failure/)
    assert.match(content, reason)

    await orchestrator.completeFarmRun(
      Number(
        db.prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)').run(id, REVIEW_STEP_INDEX, STEPS[REVIEW_STEP_INDEX].agent)
          .lastInsertRowid,
      ),
      { summary: 'reviewed', artifacts: { artifact_md: '# review', verdict: verdictOf(true) } },
    )
    orchestrator.cancel(id)
    const after = store.getItem(id)
    assert.equal(after.cursor, IMPLEMENT_STEP_INDEX)
    const blocks = JSON.parse(db.prepare('SELECT fix_findings_json AS f FROM work_item WHERE id = ?').get(id).f)
    const block = blocks.find((b) => b.detail.startsWith('Checks: '))
    assert.ok(block, JSON.stringify(blocks))
    assert.match(block.detail, /this is a check failure/)
    assert.match(block.detail, reason)
  })
}

test('guardrail 1: a green round with only a check pass from before the run is not at the pushed sha', async () => {
  const runId = await us305('SR-25', { pushed: null })
  checkPass('SR-25', SHA.C, "datetime('now', '-1 hour')")
  assert.equal(finalCheckRound('SR-25', runId).state, 'other_sha')
  const gate = reviewCheckGate('SR-25')
  assert.equal(gate.state, 'other_sha')
  assert.match(gate.failure, /implement recorded no checked-and-pushed commit during this run .*this is a check failure/)
})

test('guardrail 2: reading the final round leaves test_result and check_pass untouched', async () => {
  await us305('SR-26')
  const snapshot = () => ({
    rows: db.prepare('SELECT * FROM test_result ORDER BY id').all(),
    passes: db.prepare('SELECT * FROM check_pass ORDER BY id').all(),
  })
  const before = snapshot()
  buildStoredResultsInput('SR-26')
  reviewCheckGate('SR-26')
  assert.deepEqual(snapshot(), before)
})
