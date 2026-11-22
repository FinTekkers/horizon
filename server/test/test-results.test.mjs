// HZ-327: every check run's per-test results as data — stored from the farm's
// test_runs, read back as each test's history, and searched for a test that
// both passed and failed on the same tree (a flake found across runs).
// farm/tests/test_checks_flake.py covers how the farm builds the rows.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-test-results-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
process.env.FARM_STEP_TIMEOUT_MS = '600000'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const testResults = await import('../src/testResults.js')
const checkFlakes = await import('../src/checkFlakes.js')
const { RESULT_ROWS_SQL, UNLABELLED_RESULT_ROWS_SQL, summarizeTestHistory } = await import('../src/testHistorySummary.js')
const { default: Database } = await import('better-sqlite3')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { loginFixtureUser } = await import('./helpers/session.mjs')
const { REPO_ROOT } = await import('./helpers/repoFiles.mjs')

store.purgeDemoItems()
globalThis.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => '' })
after(() => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
const quiet = { info() {}, warn() {}, error() {} }
const DAY = 24 * 3600 * 1000
const TREE = 'e'.repeat(40)
const OTHER_TREE = 'f'.repeat(40)

function item(id, repo) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo) VALUES (?, ?, ?, ?, ?)').run(
    id,
    'history',
    'Medium',
    IMPLEMENT_STEP_INDEX,
    repo,
  )
}

const row = (test, status, extra = {}) => ({
  suite: null,
  file: 'server/test/a.test.mjs',
  test,
  status,
  duration_ms: 10,
  command: 'sh -c npm test',
  attempt: 1,
  ...extra,
})

const run = (checkRun, tests, tree = TREE) => ({ check_run: checkRun, commit_sha: 'c'.repeat(40), tree_sha: tree, tests })

function record(itemId, testRuns, { now = Date.now(), source = 'implement' } = {}) {
  return testResults.recordTestRuns({ itemId, source, testRuns, now: () => now, log: quiet, notify: false })
}

// ---- metric 4: one row per test ----

test('POST /api/farm/steps/:runId/test-runs stores one row per test, repo from the item row', async () => {
  item('TR-1', 'acme/rows')
  const runId = Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')")
      .run('TR-1', IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent).lastInsertRowid,
  )
  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/test-runs`,
    headers: { 'x-farm-secret': config.FARM_SHARED_SECRET },
    payload: {
      test_runs: [
        {
          ...run('cr-rows', [
            row('passes', 'pass', { suite: 'group', duration_ms: 12 }),
            row('fails', 'fail'),
            row('skipped', 'skip', { duration_ms: null }),
            { test: 'no status', command: 'x' },
          ]),
          repo: 'evil/other',
        },
      ],
    },
  })

  assert.equal(res.statusCode, 200, res.body)
  const rows = db
    .prepare('SELECT repo, commit_sha, tree_sha, item_id, run_id, source, suite, file, test, status, duration_ms FROM test_result WHERE item_id = ? ORDER BY id')
    .all('TR-1')
  assert.deepEqual(rows, [
    { repo: 'acme/rows', commit_sha: 'c'.repeat(40), tree_sha: TREE, item_id: 'TR-1', run_id: runId, source: 'implement', suite: 'group', file: 'server/test/a.test.mjs', test: 'passes', status: 'pass', duration_ms: 12 },
    { repo: 'acme/rows', commit_sha: 'c'.repeat(40), tree_sha: TREE, item_id: 'TR-1', run_id: runId, source: 'implement', suite: null, file: 'server/test/a.test.mjs', test: 'fails', status: 'fail', duration_ms: 10 },
    { repo: 'acme/rows', commit_sha: 'c'.repeat(40), tree_sha: TREE, item_id: 'TR-1', run_id: runId, source: 'implement', suite: null, file: 'server/test/a.test.mjs', test: 'skipped', status: 'skip', duration_ms: null },
  ])
})

// HZ-605 metric 4: a failing test's first failure-message line is stored; a
// row from an older farm (no field) stores NULL, and only a fail keeps one.
test('a failing row stores its failure_message; a row without one, or a non-failing row, stores NULL', async () => {
  item('TR-FM', 'acme/messages')
  await record('TR-FM', [
    run('cr-fm', [
      row('fails with a message', 'fail', { failure_message: 'MARKET_VALUE set on the bond' }),
      row('fails from an older farm', 'fail'),
      row('passes', 'pass', { failure_message: 'ignored' }),
      row('fails long', 'fail', { failure_message: 'x'.repeat(1000) }),
    ]),
  ])

  const rows = db.prepare('SELECT test, failure_message FROM test_result WHERE item_id = ? ORDER BY id').all('TR-FM')
  assert.deepEqual(rows, [
    { test: 'fails with a message', failure_message: 'MARKET_VALUE set on the bond' },
    { test: 'fails from an older farm', failure_message: null },
    { test: 'passes', failure_message: null },
    { test: 'fails long', failure_message: 'x'.repeat(300) },
  ])
  const column = db.prepare('PRAGMA table_info(test_result)').all().find((c) => c.name === 'failure_message')
  assert.deepEqual({ type: column.type, notnull: column.notnull, dflt_value: column.dflt_value }, { type: 'TEXT', notnull: 0, dflt_value: null })
})

// HZ-950 metric 5: a token whose received value straddles the 300 cut, POSTed
// raw as an older farm would, is redacted before the cut — never half-stored.
test('a failure_message token across the 300 cut is redacted before the cut, on a direct POST', async () => {
  item('TR-FM-SECRET', 'acme/messages')
  const runId = Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')")
      .run('TR-FM-SECRET', IMPLEMENT_STEP_INDEX, STEPS[IMPLEMENT_STEP_INDEX].agent).lastInsertRowid,
  )
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`
  const head = 'expect(received).toBe(expected) // Object.is equality · Expected: 4242 · Received: '
  const reason = head + 'y'.repeat(289 - head.length) + ' ' + token + ' and more'.repeat(80)
  assert.ok(reason.indexOf(token) < 300 && reason.indexOf(token) + token.length > 300)

  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${runId}/test-runs`,
    headers: { 'x-farm-secret': config.FARM_SHARED_SECRET },
    payload: { test_runs: [run('cr-fm-secret', [row('leaks', 'fail', { failure_message: reason })])] },
  })

  assert.equal(res.statusCode, 200, res.body)
  const { failure_message: stored } = db.prepare('SELECT failure_message FROM test_result WHERE item_id = ?').get('TR-FM-SECRET')
  assert.equal(stored.length, 300)
  assert.ok(!stored.includes('ghp_') && !stored.includes('A1b2C3d4E5'), stored)
  assert.ok(stored.startsWith(head) && stored.includes('[redacted]'), stored)
})

// HZ-950 guardrail: the farm's cap and the server's stay equal. Read as text,
// as the two live in different languages.
test('the farm and server failure-message caps are the same number', () => {
  const read = (file, re) => Number(re.exec(readFileSync(join(REPO_ROOT, file), 'utf8'))?.[1])
  const farm = read('farm/checks.py', /^FAILURE_MESSAGE_MAX_CHARS = (\d+)$/m)
  const server = read('server/src/testResults.js', /^const FAILURE_MESSAGE_MAX = (\d+)$/m)
  assert.equal(farm, 300)
  assert.equal(server, farm)
})

test('the test-runs route refuses a bad farm secret', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/farm/steps/1/test-runs',
    headers: { 'x-farm-secret': 'wrong' },
    payload: { test_runs: [] },
  })
  assert.equal(res.statusCode, 401)
})

test('malformed entries are skipped and recording never throws', async () => {
  item('TR-2', 'acme/malformed')
  const result = await record('TR-2', [null, 'x', { tests: 'no' }, { check_run: '', tests: [] }, run('cr-ok', [row('ok', 'pass')])])
  assert.equal(result.stored, 1)
  assert.deepEqual(await record('NO-SUCH-ITEM', [run('cr-x', [row('ok', 'pass')])]), { stored: 0, flakes: 0, pinged: 0 })
})

// ---- metric 5: flakes from history ----

test('a test that passed in one run and failed in another on the same tree is a flake naming the test', async () => {
  item('TR-3', 'acme/history')
  await record('TR-3', [run('cr-a', [row('flips', 'fail'), row('steady', 'pass')])])
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM check_flake WHERE repo = 'acme/history'").get().n, 0)

  const result = await record('TR-3', [run('cr-b', [row('flips', 'pass'), row('steady', 'pass')])])

  assert.equal(result.flakes, 1)
  const flakes = db.prepare("SELECT test, file, detected_by, tree_sha, check_run FROM check_flake WHERE repo = 'acme/history'").all()
  assert.deepEqual(flakes, [{ test: 'flips', file: 'server/test/a.test.mjs', detected_by: 'history', tree_sha: TREE, check_run: 'cr-b' }])

  await record('TR-3', [run('cr-c', [row('flips', 'fail')])])
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM check_flake WHERE repo = 'acme/history'").get().n, 1, 'one flake per test per tree')
})

test('a pass and a fail on different trees are not a flake', async () => {
  item('TR-4', 'acme/trees')
  await record('TR-4', [run('cr-d', [row('changed', 'fail')], TREE)])
  const result = await record('TR-4', [run('cr-e', [row('changed', 'pass')], OTHER_TREE)])
  assert.equal(result.flakes, 0)
})

test("a run's own rerun pair is left to the farm's rerun flake, never doubled from history", async () => {
  item('TR-5', 'acme/rerun')
  checkFlakes.storeFlakes({
    repo: 'acme/rerun',
    itemId: 'TR-5',
    source: 'implement',
    flakes: [{ test: 'rerun one', file: 'server/test/a.test.mjs', command: 'sh -c npm test', check_run: 'cr-f', tree_sha: TREE }],
    nowMs: Date.now(),
  })
  const result = await record('TR-5', [run('cr-f', [row('rerun one', 'fail'), row('rerun one', 'pass', { attempt: 2 })])])
  assert.equal(result.flakes, 0)

  // A later run of the same tree that fails it again names the same flake.
  await record('TR-5', [run('cr-g', [row('rerun one', 'fail')])])
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM check_flake WHERE repo = 'acme/rerun'").get().n, 1)
})

// ---- HZ-349: main and branch runs are stored apart ----

test("a 'branch' entry is stored as run_label 'branch' with its exit codes, and never makes a flake with main", async () => {
  item('TR-349', 'acme/branch')
  const main = { ...run('cr-main', [row('ledger posts', 'pass')]), label: 'main', commands: [{ command: 'sh -c npm test', attempt: 1, exit_code: 0 }] }
  const branch = {
    ...run('cr-branch', [row('ledger posts', 'fail', { command: 'sh -c cat scripts/checks/test.sh | sh' })]),
    label: 'branch',
    commands: [{ command: 'sh -c cat scripts/checks/test.sh | sh', attempt: 1, exit_code: 1 }],
  }
  const unlabelled = run('cr-old-farm', [row('older farm', 'pass')])

  const result = await record('TR-349', [main, branch, unlabelled])

  assert.equal(result.flakes, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM check_flake WHERE repo = 'acme/branch'").get().n, 0)
  const rows = db.prepare("SELECT check_run, run_label, exit_code FROM test_result WHERE item_id = 'TR-349' ORDER BY id").all()
  assert.deepEqual(rows, [
    { check_run: 'cr-main', run_label: 'main', exit_code: 0 },
    { check_run: 'cr-branch', run_label: 'branch', exit_code: 1 },
    { check_run: 'cr-old-farm', run_label: 'main', exit_code: null },
  ])
  // A later main fail on the same tree flips only against main's pass.
  assert.equal((await record('TR-349', [{ ...run('cr-main-2', [row('ledger posts', 'fail')]), label: 'main' }])).flakes, 1)
  assert.deepEqual(
    testResults.testHistory('acme/branch').tests.map((t) => [t.test, t.runs]).sort(),
    [
      ['ledger posts', 2],
      ['older farm', 1],
    ],
  )
})

// ---- metric 6: the history API ----

test('GET /api/admin/test-history gives each test its runs, failures, flakes, last seen, median and p95', async () => {
  item('TR-6', 'acme/api')
  const base = Date.UTC(2026, 9, 1)
  const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000]
  for (const [i, ms] of durations.entries()) {
    await record('TR-6', [run(`cr-api-${i}`, [row('timed', i === 3 ? 'fail' : 'pass', { duration_ms: ms })], `${i}`.padStart(40, 'a'))], {
      now: base + i * DAY,
    })
  }
  await record('TR-6', [run('cr-api-skip', [row('timed', 'skip', { duration_ms: 5 }), row('other', 'pass', { file: 'b.test.mjs' })], 'b'.repeat(40))], {
    now: base - DAY,
  })
  checkFlakes.storeFlakes({
    repo: 'acme/api',
    itemId: 'TR-6',
    source: 'implement',
    flakes: [{ test: 'timed', file: 'server/test/a.test.mjs', command: 'sh -c npm test' }],
    nowMs: base,
  })

  const res = await app.inject({ method: 'GET', url: '/api/admin/test-history?repo=acme/api', headers: { cookie } })

  assert.equal(res.statusCode, 200, res.body)
  const { repo, tests } = res.json()
  assert.equal(repo, 'acme/api')
  assert.deepEqual(tests, [
    {
      suite: null,
      file: 'server/test/a.test.mjs',
      test: 'timed',
      runs: 11,
      passes: 9,
      failures: 1,
      main_failures: 0,
      skips: 1,
      flakes: 1,
      last_seen: new Date(base + 9 * DAY).toISOString(),
      median_ms: 55,
      p95_ms: 1000,
    },
    {
      suite: null,
      file: 'b.test.mjs',
      test: 'other',
      runs: 1,
      passes: 1,
      failures: 0,
      main_failures: 0,
      skips: 0,
      flakes: 0,
      last_seen: new Date(base - DAY).toISOString(),
      median_ms: 10,
      p95_ms: 10,
    },
  ])
})

// HZ-328: the blocking-set rule reads failures on main only. Those rows come
// from post-merge runs (HZ-328c), which the source CHECK does not allow yet, so
// the counting rule is checked on the pure summary both callers share.
test('summarizeTestHistory counts only postmerge failures as main_failures, and keeps every HZ-327 field', () => {
  const at = Date.UTC(2026, 9, 1)
  const rows = (source) => [
    { suite: null, file: 'f.test.mjs', test: 't', status: 'fail', duration_ms: 30, created_at_ms: at, source },
    { suite: null, file: 'f.test.mjs', test: 't', status: 'pass', duration_ms: 10, created_at_ms: at + DAY, source: 'implement' },
    { suite: null, file: 'f.test.mjs', test: 't', status: 'skip', duration_ms: 1, created_at_ms: at, source: 'premerge' },
  ]
  const hz327 = { suite: null, file: 'f.test.mjs', test: 't', runs: 3, failures: 1, skips: 1, flakes: 2, last_seen: new Date(at + DAY).toISOString(), median_ms: 20, p95_ms: 30 }
  const flakes = [{ suite: null, file: 'f.test.mjs', test: 't', n: 2 }]

  for (const source of ['implement', 'premerge', 'conflict_resolver']) {
    assert.deepEqual(summarizeTestHistory('acme/x', rows(source), flakes).tests, [{ ...hz327, passes: 1, main_failures: 0 }], source)
  }
  assert.deepEqual(summarizeTestHistory('acme/x', rows('postmerge'), flakes).tests, [{ ...hz327, passes: 1, main_failures: 1 }])
})

// ---- HZ-946: report coverage per command ----

test("GET /api/admin/test-history gives each command its runs and no-report runs; an older NULL row is not one, and tests are unchanged", async () => {
  item('TR-946', 'acme/coverage')
  const base = Date.now() - 3 * DAY
  const lint = (status, extra = {}) =>
    row('sh -c npm run lint', status, { file: null, command: 'sh -c npm run lint', no_report: true, ...extra })
  await record('TR-946', [run('cr-cov-1', [lint('pass'), row('adds', 'pass')], '1'.padStart(40, 'c'))], { now: base })
  await record('TR-946', [run('cr-cov-2', [lint('fail'), row('adds', 'pass')], '2'.padStart(40, 'c'))], { now: base + DAY })
  // An older farm's row (no key), and a value that is not exactly true.
  await record('TR-946', [run('cr-cov-3', [lint('pass', { no_report: undefined })], '3'.padStart(40, 'c'))], { now: base + 2 * DAY })
  await record('TR-946', [run('cr-cov-4', [lint('pass', { no_report: 1 })], '4'.padStart(40, 'c'))], { now: base + 2 * DAY })

  const stored = db.prepare("SELECT check_run, test, no_report FROM test_result WHERE repo = 'acme/coverage' ORDER BY id").all()
  assert.deepEqual(
    stored.map((r) => [r.check_run, r.test, r.no_report]),
    [
      ['cr-cov-1', 'sh -c npm run lint', 1],
      ['cr-cov-1', 'adds', null],
      ['cr-cov-2', 'sh -c npm run lint', 1],
      ['cr-cov-2', 'adds', null],
      ['cr-cov-3', 'sh -c npm run lint', null],
      ['cr-cov-4', 'sh -c npm run lint', null],
    ],
  )

  const res = await app.inject({ method: 'GET', url: '/api/admin/test-history?repo=acme/coverage', headers: { cookie } })

  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.deepEqual(body.commands, [
    { command: 'sh -c npm run lint', runs: 4, no_report_runs: 2, last_seen: new Date(base + 2 * DAY).toISOString() },
    { command: 'sh -c npm test', runs: 2, no_report_runs: 0, last_seen: new Date(base + DAY).toISOString() },
  ])
  // tests is what it was before HZ-946: the same summary of the same rows.
  const before = summarizeTestHistory('acme/coverage', db.prepare(RESULT_ROWS_SQL).all('acme/coverage'), []).tests
  assert.deepEqual(body.tests, before)
  assert.ok(body.tests.every((t) => !('no_report' in t) && !('command' in t)))
})

test('an unknown repo has no commands, and the export’s unlabelled query still runs on a DB with no no_report column', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/admin/test-history?repo=acme/none', headers: { cookie } })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { repo: 'acme/none', tests: [], commands: [] })

  const old = new Database(':memory:')
  try {
    old.exec(`CREATE TABLE test_result (repo TEXT, command TEXT, suite TEXT, file TEXT, test TEXT, status TEXT,
                                        duration_ms INTEGER, created_at_ms INTEGER, source TEXT)`)
    old.prepare('INSERT INTO test_result VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('acme/old', 'npm test', null, 'a.test.mjs', 't', 'pass', 3, 1, 'implement')
    const history = summarizeTestHistory('acme/old', old.prepare(UNLABELLED_RESULT_ROWS_SQL).all('acme/old'), [])
    assert.equal(history.tests.length, 1)
    assert.deepEqual(history.commands, [])
  } finally {
    old.close()
  }
})

test('GET /api/admin/test-history needs a repo', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/admin/test-history', headers: { cookie } })
  assert.equal(res.statusCode, 400)
})

// ---- guardrail: rows older than 90 days are pruned ----

test('recording prunes test rows and flakes older than 90 days', async () => {
  item('TR-7', 'acme/prune')
  const now = Date.now()
  await record('TR-7', [run('cr-old', [row('old', 'pass')], 'd'.repeat(40))], { now: now - testResults.TEST_RESULT_RETENTION_MS - 1 })
  checkFlakes.storeFlakes({
    repo: 'acme/prune',
    itemId: 'TR-7',
    source: 'implement',
    flakes: [{ test: 'old', command: 'c' }],
    nowMs: now - testResults.TEST_RESULT_RETENTION_MS - 1,
  })
  await record('TR-7', [run('cr-new', [row('new', 'pass')], 'd'.repeat(40))], { now })

  const left = db.prepare("SELECT test FROM test_result WHERE repo = 'acme/prune'").all()
  assert.deepEqual(left, [{ test: 'new' }])
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM check_flake WHERE repo = 'acme/prune'").get().n, 0)
})
