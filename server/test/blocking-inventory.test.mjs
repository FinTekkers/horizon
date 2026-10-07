// HZ-328: the test inventory (scripts/tests/inventory.mjs) and its history
// input (server/scripts/export-test-history.mjs). One row per test with HZ-327's
// history and the source it covers; the export reads the DB and writes nothing
// else. The real full inventory is a manual run on the host; its committed
// output is checked in blocking-select.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const INVENTORY = join(REPO_ROOT, 'scripts/tests/inventory.mjs')
const EXPORT = join(REPO_ROOT, 'server/scripts/export-test-history.mjs')
const { buildInventory, collectServerCoverage, INVENTORY_COLUMNS } = await import(INVENTORY)
const { selectBlocking, renderBlocking } = await import(join(REPO_ROOT, 'scripts/tests/select-blocking.mjs'))
const { parseCsv } = await import(join(REPO_ROOT, 'scripts/tests/format.mjs'))

const SEEN = '2026-10-07T12:00:00.000Z'
const hist = (suite, file, testName, extra = {}) => ({
  suite,
  file,
  test: testName,
  runs: 12,
  passes: 12,
  failures: 0,
  main_failures: 0,
  skips: 0,
  flakes: 0,
  last_seen: SEEN,
  median_ms: 40,
  p95_ms: 90,
  ...extra,
})

// The rows as HZ-327 stores them for each runner (seen in the live DB):
// node:test names the file, with the describe path (or null) as suite; vitest
// and Playwright leave file null and put the path in the suite; a command with
// no JUnit (pytest) is one row named by the command.
const HISTORY = {
  repo: 'acme/inv',
  tests: [
    hist(null, 'server/test/a.test.mjs', 'stores a row', { runs: 14, passes: 13, failures: 1, median_ms: 12, p95_ms: 30 }),
    hist('group', 'server/test/a.test.mjs', 'stores a row', { flakes: 1 }),
    hist('src/App.test.jsx', null, 'renders the board', { median_ms: 210 }),
    hist('01-board.spec.js', null, 'board renders phase columns', { median_ms: 774, p95_ms: 900 }),
    hist(null, null, 'sh -c python -m pytest -q', { runs: 3, passes: 3, median_ms: 154184, p95_ms: 167973 }),
    hist(null, 'server/test/deleted.test.mjs', 'gone'),
  ],
}
const COVERAGE = {
  'server:server/test/a.test.mjs': { 'server/src/db.js': '1-20', 'server/src/store.js': '3,5-9' },
  'ui:ui/src/App.test.jsx': { 'ui/src/App.jsx': '1-40' },
  'e2e:e2e/tests/01-board.spec.js': { 'component:ui/src/App.jsx': '1', 'route:GET /api/items': '1', 'route:GET /api/items/:id': '1' },
}

test('the inventory has one row per test with its history, and joins every runner to its coverage', () => {
  const { rows, csv } = buildInventory({
    repo: 'acme/inv',
    history: HISTORY,
    coverage: COVERAGE,
    failsAlone: ['e2e:e2e/tests/01-board.spec.js'],
    exists: (file) => file !== 'server/test/deleted.test.mjs',
  })

  const lines = csv.split('\n')
  assert.equal(lines[0], 'repo,suite,file,test,runs,passes,failures,main_failures,flakes,median_ms,p95_ms,last_seen,fails_alone,covered_files')
  assert.deepEqual(INVENTORY_COLUMNS, lines[0].split(','))
  assert.ok(csv.endsWith('\n') && !csv.includes('\r'))
  assert.deepEqual(
    rows.map((r) => [r.suite, r.file, r.test, r.runs, r.passes, r.failures, r.flakes, r.median_ms, r.p95_ms, r.fails_alone, r.covered_files]),
    [
      ['command', '', 'sh -c python -m pytest -q', 3, 3, 0, 0, 154184, 167973, 0, 0],
      ['e2e', 'e2e/tests/01-board.spec.js', 'board renders phase columns', 12, 12, 0, 0, 774, 900, 1, 3],
      ['server', 'server/test/a.test.mjs', 'group > stores a row', 12, 12, 0, 1, 40, 90, 0, 2],
      ['server', 'server/test/a.test.mjs', 'stores a row', 14, 13, 1, 0, 12, 30, 0, 2],
      ['ui', 'ui/src/App.test.jsx', 'renders the board', 12, 12, 0, 0, 210, 90, 0, 1],
    ],
  )
  // The CSV reads back to the same rows (as strings).
  assert.deepEqual(parseCsv(csv), rows.map((r) => Object.fromEntries(INVENTORY_COLUMNS.map((c) => [c, String(r[c])]))))
})

test('collectServerCoverage runs one test file under V8 and keeps the server/src lines it ran', async () => {
  const root = mkdtempSync(join(tmpdir(), 'horizon-inventory-fixture-'))
  mkdirSync(join(root, 'server/src'), { recursive: true })
  mkdirSync(join(root, 'server/test'), { recursive: true })
  writeFileSync(join(root, 'server/package.json'), '{ "type": "module" }\n')
  writeFileSync(
    join(root, 'server/src/lib.js'),
    ['export function used() {', '  return 1', '}', '', 'export function unused() {', '  const x = 2', '  return x', '}', ''].join('\n'),
  )
  writeFileSync(
    join(root, 'server/test/lib.test.mjs'),
    "import { test } from 'node:test'\nimport { used } from '../src/lib.js'\ntest('used', () => { if (used() !== 1) throw new Error('no') })\n",
  )

  const { coverage, ok } = await collectServerCoverage(root, 'server/test/lib.test.mjs')

  assert.equal(ok, true)
  assert.deepEqual(Object.keys(coverage), ['server/src/lib.js'], 'only server/src, never the test file')
  const lines = coverage['server/src/lib.js']
  const covered = new Set(lines.split(',').flatMap((r) => {
    const [a, b = a] = r.split('-').map(Number)
    return Array.from({ length: b - a + 1 }, (_, i) => a + i)
  }))
  assert.ok(covered.has(2), `the called function's body is covered: ${lines}`)
  assert.ok(!covered.has(6) && !covered.has(7), `the uncalled function's body is not: ${lines}`)
})

// ---- the history export ----

function historyDb(dir) {
  const path = join(dir, 'horizon.db')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE test_result (repo TEXT, command TEXT, suite TEXT, file TEXT, test TEXT, status TEXT,
                              duration_ms INTEGER, created_at_ms INTEGER, source TEXT);
    CREATE TABLE check_flake (repo TEXT, test TEXT, suite TEXT, file TEXT, command TEXT, first_output TEXT, rerun_output TEXT);
  `)
  const insert = db.prepare('INSERT INTO test_result VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (let i = 0; i < 11; i++) {
    insert.run('acme/x', 'GITHUB_TOKEN=ghp_fakeSecretToken123 npm test', null, 'server/test/a.test.mjs', 'works', 'pass', 10 + i, 1_760_000_000_000 + i, 'implement')
  }
  insert.run('acme/x', 'npm test', 'src/A.test.jsx', null, 'flaky one', 'fail', 5, 1_760_000_000_000, 'premerge')
  db.prepare('INSERT INTO check_flake VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'acme/x',
    'flaky one',
    'src/A.test.jsx',
    null,
    'npm test',
    'Error: token ghp_fakeSecretToken123 rejected',
    'ok',
  )
  db.close()
  return path
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

test('the export is read-only, and no test output, command or env value reaches any output file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'horizon-export-'))
  const dbPath = historyDb(dir)
  const before = sha(dbPath)
  const out = join(dir, 'history.json')

  execFileSync(process.execPath, [EXPORT, '--repo', 'acme/x', '--out', out, '--db', dbPath], {
    env: { ...process.env, FAKE_SECRET_ENV: 'envSecretValue987' },
    stdio: 'pipe',
  })

  assert.equal(sha(dbPath), before, 'the DB file is unchanged')
  assert.ok(!existsSync(`${dbPath}-wal`), 'no WAL was created')
  const history = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(
    history.tests.map((t) => [t.suite, t.file, t.test, t.runs, t.passes, t.failures, t.flakes]),
    [
      [null, 'server/test/a.test.mjs', 'works', 11, 11, 0, 0],
      ['src/A.test.jsx', null, 'flaky one', 1, 0, 1, 1],
    ],
  )

  const { csv } = buildInventory({ repo: history.repo, history, coverage: { 'server:server/test/a.test.mjs': { 'server/src/a.js': '1-3' } } })
  const blocking = renderBlocking(selectBlocking({ rows: parseCsv(csv), coverageMap: { 'server:server/test/a.test.mjs': { 'server/src/a.js': '1-3' } } }))
  for (const text of [readFileSync(out, 'utf8'), csv, blocking]) {
    assert.ok(!text.includes('ghp_'), 'no token')
    assert.ok(!text.includes('envSecretValue987'), 'no env value')
    assert.ok(!text.includes('GITHUB_TOKEN'), 'no command line')
  }
})

test('the export of a missing DB exits non-zero and creates neither the DB nor the output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'horizon-export-missing-'))
  const dbPath = join(dir, 'nope.db')
  const out = join(dir, 'history.json')

  const res = spawnSync(process.execPath, [EXPORT, '--repo', 'acme/x', '--out', out, '--db', dbPath], { encoding: 'utf8' })

  assert.notEqual(res.status, 0)
  assert.ok(!existsSync(dbPath))
  assert.ok(!existsSync(out))
})

// ---- guardrails: coverage only in the inventory ----

test('v8-to-istanbul is only imported dynamically, so the server suite never needs it', () => {
  const source = readFileSync(INVENTORY, 'utf8')
  assert.doesNotMatch(source, /^\s*import\s[^(]*['"]v8-to-istanbul['"]/m)
  assert.match(source, /await import\('v8-to-istanbul'\)/)
})

test('no gating test script turns on coverage, and the UI build has sourcemaps only for the inventory', () => {
  const scripts = (dir) => JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8')).scripts
  const gating = [scripts('.').test, scripts('.')['test:e2e'], scripts('server').test, scripts('ui').test, scripts('e2e').test]
  for (const command of gating) {
    assert.ok(command, 'script exists')
    for (const flag of ['--experimental-test-coverage', '--coverage', 'HORIZON_E2E_COVERAGE_DIR', 'c8 ']) {
      assert.ok(!command.includes(flag), `${flag} in ${command}`)
    }
  }
  const vite = readFileSync(join(REPO_ROOT, 'ui/vite.config.js'), 'utf8')
  assert.match(vite, /const sourcemap = Boolean\(process\.env\.HORIZON_E2E_COVERAGE_DIR\)/)
  assert.match(vite, /build: \{ sourcemap \}/)
})
