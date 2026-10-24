// HZ-570: a deploy restart must not cost an implement run its stored test
// results. Driven through the real Fastify app and the real kick → dispatch
// path; the farm is a captured fetch stub. The restart itself (a SIGKILLed
// server and farmd's retry) is farm/tests/test_test_runs_survive_restart.py;
// the drain helper's wait is deploy-drain-helper.test.mjs.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-upload-ledger-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.STORED_RESULTS_WAIT_MS = '0'
process.env.STORED_RESULTS_RETRY_WINDOW_S = '600'
process.env.STORED_RESULTS_RECHECK_MS = '100'
const HOLD_DIR = mkdtempSync(join(tmpdir(), 'horizon-upload-hold-'))
process.env.HORIZON_TEST_RUNS_HOLD_DIR = HOLD_DIR
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const orchestrator = await import('../src/orchestrator.js')
const deployDrain = await import('../src/deployDrain.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { RESULTS_LOST_TEXT, STORED_RESULTS_INPUT_LABEL, storedResultsUpload } = await import('../src/storedTestResults.js')

store.purgeDemoItems()

const calls = []
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  return { ok: true, json: async () => ({}) }
}
await orchestrator.init({ info: () => {}, warn: () => {} })
const app = buildApp({ logger: false })
// The re-queued implement step needs the repo's check commands to start.
const projectId = db.prepare("INSERT INTO project (name, enabled) VALUES ('Upload ledger', 1)").run().lastInsertRowid
db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(projectId, 'acme/ledger', 'UL')
store.setRepoCheckCommands(projectId, 'acme/ledger', { test: 'npm test' })
const used = []
after(() => {
  used.forEach((id) => orchestrator.cancel(id))
  rmSync(HOLD_DIR, { recursive: true, force: true })
})

const FARM = { 'x-farm-secret': config.FARM_SHARED_SECRET }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const TREE = 'e'.repeat(40)
const CMD = 'npm test'

function item(id, cursor) {
  used.push(id)
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, project_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    `Title ${id}`,
    'Medium',
    cursor,
    'acme/ledger',
    projectId,
  )
}

// A done implement run whose /complete promised `expected` rows, ended at
// `endedAt` (an SQLite datetime() expression).
function implementRun(id, { expected = 500, endedAt = "datetime('now')", status = 'done' } = {}) {
  return Number(
    db
      .prepare(
        `INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, ended_at, test_runs_expected)
         VALUES (?, ?, 1, ?, ?, '1 repo check(s) passed', ${endedAt}, ?)`,
      )
      .run(id, IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent, status, expected).lastInsertRowid,
  )
}

const names = (n, prefix = 'test') => Array.from({ length: n }, (_, i) => `${prefix} ${i}`)
const entry = (checkRun, tests, status = 'pass') => ({
  check_run: checkRun,
  label: 'main',
  commit_sha: 'c'.repeat(40),
  tree_sha: TREE,
  tests: tests.map((test) => ({ suite: 'Suite', file: null, test, status, duration_ms: 1, command: CMD, attempt: 1 })),
  commands: [{ command: CMD, attempt: 1, exit_code: status === 'pass' ? 0 : 1 }],
})

const postTestRuns = (runId, testRuns) =>
  app.inject({ method: 'POST', url: `/api/farm/steps/${runId}/test-runs`, headers: FARM, payload: { test_runs: testRuns } })
const drainStatus = async () => (await app.inject({ method: 'GET', url: '/api/farm/deploy-drain', headers: FARM, remoteAddress: '127.0.0.1' })).json()
const rowCount = (runId) => db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT test) AS d FROM test_result WHERE run_id = ? AND source = 'implement'").get(runId)
const ledger = (runId) => db.prepare('SELECT test_runs_expected, test_runs_stored, test_runs_stored_at, test_runs_abandoned FROM step_run WHERE id = ?').get(runId)
const dispatchOf = (id, stepIndex) => calls.filter((c) => c.url.endsWith('/steps/run') && c.body?.item?.id === id && c.body?.step?.index === stepIndex).at(-1)?.body
const storedInput = (body) => body.artifacts.find((a) => a.label === STORED_RESULTS_INPUT_LABEL)?.content
const itemRow = (id) => db.prepare('SELECT cursor, paused, rejected, review_cycle_count FROM work_item WHERE id = ?').get(id)
const reviewRuns = (id) => db.prepare('SELECT status, output FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id').all(id, REVIEW_STEP_INDEX)

async function waitFor(what, check, ms = 3000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return
    await tick(20)
  }
  assert.fail(`gave up waiting for ${what}`)
}

test('guardrail 1: the same run posted twice keeps 500 rows, not 1000, and one flake', async () => {
  item('UL-1', IMPLEMENT_STEP_INDEX)
  // An earlier run of the same tree where "test 0" failed: this run's pass is a flake.
  const earlier = implementRun('UL-1')
  assert.equal((await postTestRuns(earlier, [entry('cr-earlier', ['test 0'], 'fail')])).statusCode, 200)
  const runId = implementRun('UL-1')
  const first = await postTestRuns(runId, [entry('cr-a', names(500))])
  assert.equal(first.statusCode, 200, first.body)
  assert.deepEqual(first.json(), { ok: true, stored: 500 })
  // farmd's retry after a restart cut off its first reply.
  const retry = await postTestRuns(runId, [entry('cr-a', names(500))])
  assert.deepEqual(retry.json(), { ok: true, stored: 500 })

  assert.deepEqual({ ...rowCount(runId) }, { n: 500, d: 500 })
  const row = ledger(runId)
  assert.equal(row.test_runs_stored, 500)
  assert.ok(row.test_runs_stored_at, 'the ledger is closed')
  const flakes = db.prepare("SELECT COUNT(*) AS n FROM check_flake WHERE repo = 'acme/ledger' AND test = 'test 0'").get().n
  assert.equal(flakes, 1, 'the retry adds no second flake')
})

test('a run the server never had is answered unknown_run, so farmd drops it', async () => {
  const res = await postTestRuns(999999, [entry('cr-x', names(3))])
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, stored: 0, unknown_run: true })
})

test('metric 2 (HZ-556 gap): /complete promising 500 rows lists the run as an upload before any test-runs post', async () => {
  item('UL-2', IMPLEMENT_STEP_INDEX)
  const runId = Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')")
      .run('UL-2', IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent).lastInsertRowid,
  )
  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/complete`,
    headers: FARM,
    payload: { summary: 'done', patch: {}, test_runs_expected: 500 },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(ledger(runId).test_runs_expected, 500)

  const status = deployDrain.drainStatus()
  assert.equal(status.uploadsInFlight, 0)
  assert.deepEqual(
    status.uploads.filter((u) => u.runId === runId).map(({ runId: r, itemId, expected }) => ({ runId: r, itemId, expected })),
    [{ runId, itemId: 'UL-2', expected: 500 }],
  )

  await postTestRuns(runId, [entry('cr-ul2', names(500))])
  assert.ok(!deployDrain.drainStatus().uploads.some((u) => u.runId === runId), 'stored: no longer waited for')
})

test('metric 2: a held upload shows in the drain status, and clears only once its rows are stored', async () => {
  item('UL-3', IMPLEMENT_STEP_INDEX)
  const runId = implementRun('UL-3')
  const gate = join(HOLD_DIR, `before-${runId}`)
  writeFileSync(gate, '')
  const posting = postTestRuns(runId, [entry('cr-ul3', names(500))])
  await waitFor('the upload to reach its hold', () => existsSync(`${gate}.reached`))

  const held = await drainStatus()
  assert.equal(held.uploadsInFlight, 1)
  assert.ok(held.uploads.some((u) => u.runId === runId && u.itemId === 'UL-3'), JSON.stringify(held.uploads))
  assert.equal(ledger(runId).test_runs_stored_at, null)

  rmSync(gate)
  const res = await posting
  assert.deepEqual(res.json(), { ok: true, stored: 500 })
  assert.ok(ledger(runId).test_runs_stored_at, 'stored before the drain clears')
  const cleared = await drainStatus()
  assert.equal(cleared.uploadsInFlight, 0)
  assert.ok(!cleared.uploads.some((u) => u.runId === runId))
})

test('metric 4: results a restart lost, past the retry window, re-queue the checks; the item is not failed', async () => {
  item('UL-4', REVIEW_STEP_INDEX)
  db.prepare('UPDATE work_item SET review_cycle_count = 1 WHERE id = ?').run('UL-4')
  // Ended 20 min ago (before this server booted), past the 10 min window.
  implementRun('UL-4', { endedAt: "datetime('now', '-20 minutes')" })

  orchestrator.kick('UL-4')
  await tick(50)

  const runs = reviewRuns('UL-4')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'superseded')
  assert.ok(runs[0].output.includes(RESULTS_LOST_TEXT), runs[0].output)
  assert.equal(dispatchOf('UL-4', REVIEW_STEP_INDEX), undefined, 'review was not sent to the farm')
  const row = itemRow('UL-4')
  assert.equal(row.cursor, IMPLEMENT_STEP_INDEX)
  assert.equal(row.paused, 0)
  assert.equal(row.rejected, 0)
  assert.equal(row.review_cycle_count, 1, 'the review cycle count is unchanged')
  const events = db.prepare('SELECT text FROM event WHERE item_id = ?').all('UL-4').map((e) => e.text)
  assert.ok(events.some((t) => t.includes('checks re-queued')), events.join('\n'))
  const feedback = db.prepare('SELECT message FROM feedback WHERE item_id = ?').all('UL-4')
  assert.ok(feedback.some((f) => f.message.includes(RESULTS_LOST_TEXT)))
  assert.ok(dispatchOf('UL-4', IMPLEMENT_STEP_INDEX), 'the checks were re-queued: implement dispatched again')
})

test('metric 4: a retry that lands before review is used; nothing is re-queued', async () => {
  item('UL-5', REVIEW_STEP_INDEX)
  // Ended 2 min ago, before this boot, inside the retry window: farmd may still deliver.
  const runId = implementRun('UL-5', { expected: 5, endedAt: "datetime('now', '-2 minutes')" })

  orchestrator.kick('UL-5')
  await tick(300)
  assert.equal(dispatchOf('UL-5', REVIEW_STEP_INDEX), undefined, 'review is held while the upload can still land')
  assert.deepEqual(reviewRuns('UL-5'), [], 'no review run while held')

  await postTestRuns(runId, [entry('cr-ul5', names(5, 'landed'))])
  await waitFor('review to dispatch', () => dispatchOf('UL-5', REVIEW_STEP_INDEX))

  const content = storedInput(dispatchOf('UL-5', REVIEW_STEP_INDEX))
  assert.match(content, /Totals: 5 passed, 0 failed, 0 skipped\./)
  assert.ok(!content.includes(RESULTS_LOST_TEXT))
  assert.ok(reviewRuns('UL-5').every((r) => r.status !== 'superseded'), 'nothing re-queued')
  assert.equal(itemRow('UL-5').review_cycle_count, 0)
})

test('guardrail 3: past the re-queue cap review runs, its input still says the results were lost, never a pass', async () => {
  item('UL-6', REVIEW_STEP_INDEX)
  implementRun('UL-6', { endedAt: "datetime('now', '-20 minutes')" })
  for (let i = 1; i <= orchestrator.LOST_RESULTS_REQUEUE_CAP; i++) {
    db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, ended_at) VALUES (?, ?, ?, ?, 'superseded', ?, datetime('now'))").run(
      'UL-6',
      REVIEW_STEP_INDEX,
      i,
      STEPS[REVIEW_STEP_INDEX].agent,
      `earlier input: ${RESULTS_LOST_TEXT}`,
    )
  }

  orchestrator.kick('UL-6')
  await tick(50)

  const body = dispatchOf('UL-6', REVIEW_STEP_INDEX)
  assert.ok(body, 'review dispatched once the cap is reached')
  const content = storedInput(body)
  assert.ok(content.includes(RESULTS_LOST_TEXT), content)
  assert.ok(content.includes('This is not evidence of a pass or a fail'), content)
  assert.ok(!/Totals: \d+ passed/.test(content), 'no results are presented as evidence')
  assert.equal(itemRow('UL-6').cursor, REVIEW_STEP_INDEX)
})

test('guardrail 4: a run that ended after this boot on the same day is not lost (times are parsed, not compared as text)', async () => {
  // Pure: "2026-10-24 10:00:00" sorts before "2026-10-24T09:00:00.000Z" as text.
  item('UL-7a', REVIEW_STEP_INDEX)
  db.prepare(
    `INSERT INTO step_run (item_id, step_index, attempt, agent, status, ended_at, test_runs_expected, test_runs_abandoned)
     VALUES ('UL-7a', ?, 1, ?, 'done', '2026-10-24 10:00:00', 500, 'gave_up')`,
  ).run(IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent)
  const nowMs = Date.parse('2026-10-24T11:00:00Z')
  assert.equal(storedResultsUpload('UL-7a', { nowMs, bootedAt: '2026-10-24T09:00:00.000Z' }).state, 'none', 'ended an hour after the boot')
  assert.equal(storedResultsUpload('UL-7a', { nowMs, bootedAt: '2026-10-24T10:00:00.500Z' }).state, 'none', 'ended in the boot second')
  assert.equal(storedResultsUpload('UL-7a', { nowMs, bootedAt: '2026-10-24T10:30:00.000Z' }).state, 'lost', 'ended before the boot')

  // Through review: ended now, after this server booted; farmd gave up.
  item('UL-7', REVIEW_STEP_INDEX)
  const runId = implementRun('UL-7')
  db.prepare("UPDATE step_run SET test_runs_abandoned = 'gave_up' WHERE id = ?").run(runId)
  orchestrator.kick('UL-7')
  await tick(50)
  const content = storedInput(dispatchOf('UL-7', REVIEW_STEP_INDEX))
  assert.match(content, /No per-test results were stored for this run\./)
  assert.ok(!content.includes(RESULTS_LOST_TEXT))
  assert.deepEqual(
    reviewRuns('UL-7').map((r) => r.status),
    ['active'],
    'review runs as today; nothing re-queued',
  )
})

test('guardrail 4: an upload the server rejected (a 400), with no restart, is reviewed as today', async () => {
  item('UL-8', REVIEW_STEP_INDEX)
  const runId = implementRun('UL-8')
  // The post farmd sends after a 4xx.
  const res = await app.inject({ method: 'POST', url: `/api/farm/steps/${runId}/test-runs/abandon`, headers: FARM, payload: { why: 'rejected' } })
  assert.deepEqual(res.json(), { ok: true, changed: true })
  assert.equal(ledger(runId).test_runs_abandoned, 'rejected')
  assert.ok(!deployDrain.drainStatus().uploads.some((u) => u.runId === runId), 'no longer held by a drain')

  orchestrator.kick('UL-8')
  await tick(50)
  const content = storedInput(dispatchOf('UL-8', REVIEW_STEP_INDEX))
  assert.match(content, /No per-test results were stored for this run\./)
  assert.ok(!content.includes(RESULTS_LOST_TEXT))
  assert.equal(itemRow('UL-8').cursor, REVIEW_STEP_INDEX)
})
