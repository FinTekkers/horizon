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
const { STORED_RESULTS_INPUT_LABEL, STORED_RESULTS_MAX_CHARS } = await import('../src/storedTestResults.js')
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
