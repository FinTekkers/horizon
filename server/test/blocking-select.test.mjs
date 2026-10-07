// HZ-328: the blocking test set (scripts/tests/select-blocking.mjs) — chosen
// by rule from the inventory, per suite: only files whose every test has 10
// clean runs, no failure on main and no flake record; cheapest per newly
// covered line first, up to 95% of the lines the suite covers. The committed
// tests/blocking.json must be exactly what the rule gives for the committed
// inventory.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SELECT = join(REPO_ROOT, 'scripts/tests/select-blocking.mjs')
const { ALWAYS_RUN, renderBlocking, selectBlocking } = await import(SELECT)
const { INVENTORY_COLUMNS, parseCsv } = await import(join(REPO_ROOT, 'scripts/tests/format.mjs'))

const row = (suite, file, testName, extra = {}) => ({
  repo: 'acme/sel',
  suite,
  file,
  test: testName,
  runs: 12,
  passes: 12,
  failures: 0,
  main_failures: 0,
  flakes: 0,
  median_ms: 100,
  p95_ms: 100,
  last_seen: '2026-10-07T12:00:00.000Z',
  fails_alone: 0,
  covered_files: 1,
  ...extra,
})
const covers = (ranges) => ({ 'server/src/a.js': ranges })

// Universe: server/src/a.js lines 1-100.
// s1 1-60 at 60 ms (1 ms/line), s2 50-100 at 102 ms (2 ms/line), s3 1-100 at 1000 ms.
const BASE_ROWS = [
  row('server', 'server/test/s1.test.mjs', 'one', { median_ms: 60 }),
  row('server', 'server/test/s2.test.mjs', 'two', { median_ms: 102 }),
  row('server', 'server/test/s3.test.mjs', 'three', { median_ms: 1000 }),
]
const BASE_COVERAGE = {
  'server:server/test/s1.test.mjs': covers('1-60'),
  'server:server/test/s2.test.mjs': covers('50-100'),
  'server:server/test/s3.test.mjs': covers('1-100'),
}
const files = (list) => list.map((e) => e.file)

test('the set reaches the 95% floor cheapest-first and leaves out a file with a flaky test or a failure on main', () => {
  const rows = [
    ...BASE_ROWS,
    // Cheapest of all and covering everything — but one of its six tests flaked.
    ...['a', 'b', 'c', 'd', 'e'].map((t) => row('server', 'server/test/flaky.test.mjs', t, { median_ms: 0 })),
    row('server', 'server/test/flaky.test.mjs', 'f', { median_ms: 1, flakes: 1 }),
    // As cheap — but failed once on main (a post-merge run).
    row('server', 'server/test/main.test.mjs', 'm', { median_ms: 1, failures: 1, main_failures: 1, passes: 11 }),
    // Failures on a branch alone do not make a file ineligible.
    row('server', 'server/test/branchy.test.mjs', 'b', { median_ms: 5000, failures: 3, passes: 10, runs: 13 }),
  ]
  const coverageMap = {
    ...BASE_COVERAGE,
    'server:server/test/flaky.test.mjs': covers('1-100'),
    'server:server/test/main.test.mjs': covers('1-100'),
    'server:server/test/branchy.test.mjs': covers('1-100'),
  }

  const out = selectBlocking({ rows, coverageMap })

  assert.deepEqual(files(out.blocking), ['server/test/s1.test.mjs', 'server/test/s2.test.mjs'])
  assert.deepEqual(out.suites.server, { covered: 100, total: 100, ratio: 1, floor_met: true })
  assert.deepEqual(
    out.excluded.map((e) => [e.file, e.reason]),
    [
      ['server/test/branchy.test.mjs', 'not needed: suite floor reached by cheaper files'],
      ['server/test/flaky.test.mjs', 'flake recorded (1)'],
      ['server/test/main.test.mjs', 'failed on main (1)'],
      ['server/test/s3.test.mjs', 'not needed: suite floor reached by cheaper files'],
    ],
  )
  assert.equal(out.blocking[0].reason, 'greedy: +60 lines at 1.0 ms/line')
  // A suite with nothing measured is no evidence: it runs in full.
  assert.deepEqual(out.suites.ui, { covered: 0, total: 0, ratio: 0, floor_met: false })
})

test('the same inputs in any order give byte-identical output, and a cost tie breaks on the path', () => {
  const rows = [
    row('server', 'server/test/b.test.mjs', 'x', { median_ms: 50 }),
    row('server', 'server/test/a.test.mjs', 'x', { median_ms: 50 }),
    row('e2e', 'e2e/tests/02-b.spec.js', 'y', { median_ms: 900 }),
    row('e2e', 'e2e/tests/01-a.spec.js', 'y', { median_ms: 800 }),
    row('command', '', 'sh -c python -m pytest -q'),
  ]
  const coverageMap = {
    'server:server/test/b.test.mjs': covers('1-100'),
    'server:server/test/a.test.mjs': covers('1-100'),
    'e2e:e2e/tests/02-b.spec.js': { 'route:GET /api/items': '1', 'component:ui/src/App.jsx': '1' },
    'e2e:e2e/tests/01-a.spec.js': { 'route:GET /api/items/:id': '1' },
  }
  const shuffledMap = Object.fromEntries(Object.entries(coverageMap).reverse())

  const first = renderBlocking(selectBlocking({ rows, coverageMap }))
  const second = renderBlocking(selectBlocking({ rows: [...rows].reverse(), coverageMap: shuffledMap }))
  const third = renderBlocking(selectBlocking({ rows: [rows[2], rows[0], rows[4], rows[3], rows[1]], coverageMap }))

  assert.equal(second, first)
  assert.equal(third, first)
  const out = JSON.parse(first)
  assert.deepEqual(files(out.blocking), ['e2e/tests/01-a.spec.js', 'e2e/tests/02-b.spec.js', 'server/test/a.test.mjs'])
  assert.deepEqual(out.suites.e2e, { covered: 3, total: 3, ratio: 1, floor_met: true })
  assert.ok(first.endsWith('}\n') && !first.includes('\r'))
})

test('a file with 9 clean runs never blocks, even when it would close the floor gap; with 10 it is eligible', () => {
  const rows = (passes) => [
    row('server', 'server/test/s1.test.mjs', 'one', { median_ms: 60 }),
    row('server', 'server/test/new.test.mjs', 'n', { median_ms: 100, runs: passes, passes }),
  ]
  const coverageMap = { 'server:server/test/s1.test.mjs': covers('1-90'), 'server:server/test/new.test.mjs': covers('1-100') }

  const nine = selectBlocking({ rows: rows(9), coverageMap })
  assert.deepEqual(files(nine.blocking), ['server/test/s1.test.mjs'])
  assert.deepEqual(nine.excluded, [{ suite: 'server', file: 'server/test/new.test.mjs', reason: '9 of 10 clean runs' }])
  assert.deepEqual(nine.suites.server, { covered: 90, total: 100, ratio: 0.9, floor_met: false })

  const ten = selectBlocking({ rows: rows(10), coverageMap })
  assert.deepEqual(files(ten.blocking), ['server/test/new.test.mjs', 'server/test/s1.test.mjs'])
  assert.equal(ten.suites.server.floor_met, true)
})

test('a blocking file that gets a flake record is demoted with its reason, and the next-cheapest eligible file keeps the floor', () => {
  const before = selectBlocking({ rows: BASE_ROWS, coverageMap: BASE_COVERAGE })
  assert.deepEqual(files(before.blocking), ['server/test/s1.test.mjs', 'server/test/s2.test.mjs'])

  const rows = BASE_ROWS.map((r) => (r.file === 'server/test/s1.test.mjs' ? { ...r, flakes: 2 } : r))
  const after = selectBlocking({ rows, coverageMap: BASE_COVERAGE, previous: before })

  assert.deepEqual(after.demoted, [{ suite: 'server', file: 'server/test/s1.test.mjs', reason: 'flake recorded (2)' }])
  // s2 alone covers 51 lines; s3, the next-cheapest per line, closes the gap.
  assert.deepEqual(files(after.blocking), ['server/test/s2.test.mjs', 'server/test/s3.test.mjs'])
  assert.equal(after.suites.server.floor_met, true)
  // Still flaky at the next recompute: it stays demoted, not merely excluded.
  const again = selectBlocking({ rows, coverageMap: BASE_COVERAGE, previous: after })
  assert.deepEqual(again.demoted, after.demoted)
})

test('every test file lands in exactly one list, and every check with no V8 coverage always runs', () => {
  const rows = [
    ...BASE_ROWS,
    row('server', 'server/test/flaky.test.mjs', 'f', { flakes: 1 }),
    row('ui', 'ui/src/App.test.jsx', 'renders', { median_ms: 200 }),
    row('e2e', 'e2e/tests/01-board.spec.js', 'board', { fails_alone: 1 }),
    row('command', '', 'sh -c python -m pytest -q'),
    row('other', 'farm/tests/test_x.py', 'x'),
  ]
  const coverageMap = {
    ...BASE_COVERAGE,
    'server:server/test/flaky.test.mjs': covers('1-10'),
    'ui:ui/src/App.test.jsx': { 'ui/src/App.jsx': '1-40' },
    'e2e:e2e/tests/01-board.spec.js': { 'route:GET /api/items': '1' },
    // Measured but not yet in any run's history: a brand-new test file.
    'ui:ui/src/New.test.jsx': { 'ui/src/New.jsx': '1-5' },
  }

  const out = selectBlocking({ rows, coverageMap, previous: { blocking: [{ suite: 'server', file: 'server/test/flaky.test.mjs' }] } })

  const listed = [...out.blocking, ...out.excluded, ...out.demoted].map((e) => `${e.suite}:${e.file}`)
  const expected = [...new Set([...rows.filter((r) => ['server', 'ui', 'e2e'].includes(r.suite)).map((r) => `${r.suite}:${r.file}`), ...Object.keys(coverageMap)])]
  assert.deepEqual([...listed].sort(), [...expected].sort(), 'each file exactly once')
  assert.deepEqual(out.excluded.find((e) => e.file === 'ui/src/New.test.jsx').reason, '0 of 10 clean runs')
  assert.deepEqual(out.excluded.find((e) => e.file === 'e2e/tests/01-board.spec.js').reason, 'fails_alone')
  const always = out.always_run.map((a) => a.command)
  for (const a of ALWAYS_RUN) assert.ok(always.includes(a.command), a.command)
  assert.ok(always.includes('sh -c python -m pytest -q'))
  assert.ok(always.includes('farm/tests/test_x.py'))
  assert.ok(out.always_run.every((a) => a.reason === 'no_v8_coverage'))
})

test('the selection runs no process and writes only its --out file: a new set reaches main only as a PR diff', () => {
  for (const file of ['scripts/tests/select-blocking.mjs', 'scripts/tests/format.mjs']) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8')
    assert.doesNotMatch(source, /child_process|\bspawn(Sync)?\(|\bexecFile|\bexecSync/, file)
  }
})

test('the committed tests/blocking.json is exactly what the rule gives for the committed inventory', () => {
  const csv = readFileSync(join(REPO_ROOT, 'tests/inventory.csv'), 'utf8')
  const map = readFileSync(join(REPO_ROOT, 'tests/coverage-map.json'), 'utf8')
  const committed = readFileSync(join(REPO_ROOT, 'tests/blocking.json'), 'utf8')
  const rows = parseCsv(csv)

  assert.equal(csv.split('\n')[0], INVENTORY_COLUMNS.join(','))
  const keys = rows.map((r) => JSON.stringify([r.suite, r.file, r.test]))
  assert.deepEqual(keys, [...keys].sort((a, b) => {
    const [x, y] = [JSON.parse(a), JSON.parse(b)]
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    return 0
  }), 'rows sorted by (suite, file, test)')

  const out = selectBlocking({ rows, coverageMap: JSON.parse(map), previous: JSON.parse(committed) })
  assert.equal(renderBlocking(out), committed)
  // HZ-328b's staleness check: the hash of the committed input files as they are.
  assert.equal(out.inputs_sha256, createHash('sha256').update(csv).update('\0').update(map).digest('hex'))
})
