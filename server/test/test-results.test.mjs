// HZ-327: every check run's per-test results as data — stored from the farm's
// test_runs, read back as each test's history, and searched for a test that
// both passed and failed on the same tree (a flake found across runs).
// farm/tests/test_checks_flake.py covers how the farm builds the rows.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
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
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { loginFixtureUser } = await import('./helpers/session.mjs')

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
      failures: 1,
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
      failures: 0,
      skips: 0,
      flakes: 0,
      last_seen: new Date(base - DAY).toISOString(),
      median_ms: 10,
      p95_ms: 10,
    },
  ])
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
