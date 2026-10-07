// HZ-328: picks the blocking test set from tests/inventory.csv and
// tests/coverage-map.json (inventory.mjs) and writes tests/blocking.json.
//
//   npm run tests:select
//
// By rule, never by hand. The unit is the test file — the unit coverage is
// measured in. Per suite (server, ui, e2e, each with its own floor, so unit
// lines never swamp e2e):
//   eligible  every test in the file has >= 10 clean runs (passes), 0 failures
//             on main, no flake record, and the file did not fail alone;
//   greedy    add the eligible file with the lowest cost (sum of its tests'
//             median ms) per newly covered line, ties broken on the path, until
//             the set covers >= 95% of the lines the whole suite covers;
//   floor     only eligible files are ever added. When they cannot reach 95%
//             the suite says floor_met: false, and the gate runs it in full
//             (HZ-328b) — a test with fewer than 10 clean runs is never
//             promoted to keep the floor.
// A file that was blocking (or demoted) and is now ineligible is listed under
// demoted with its reason ("flake recorded (n)"); every other non-blocking
// file is under excluded with its reason. Suites with no V8 coverage, and
// whole-command rows, are under always_run: they are never reduced.
//
// Staleness, for HZ-328b's fail-safe: the file is stale when history_through
// is more than max_age_days old, or inputs_sha256 is not the hash of the
// committed inventory.csv and coverage-map.json (see inputsSha256). A stale,
// missing or unparsable file, or one with floor_met: false, runs the suite in
// full.
//
// Pure and reproducible: the same inputs, in any row order, give the same
// bytes; no wall-clock time is written. This module runs no processes and
// commits nothing — a recomputed tests/blocking.json reaches main only as a
// PR diff.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { INVENTORY_COLUMNS, decodeRanges, parseCsv, stableJson, toCsv } from './format.mjs'

export const SCHEMA_VERSION = 1
export const FLOOR = 0.95
export const MIN_CLEAN_RUNS = 10
export const MAX_AGE_DAYS = 14
const V8_SUITES = ['server', 'ui', 'e2e']
// The checks with no V8 coverage source: the rule cannot price them, so they
// always run in full.
export const ALWAYS_RUN = [
  { suite: 'pytest', command: 'farm/tests' },
  { suite: 'shell', command: 'infra/host/test/*.test.sh' },
  { suite: 'shell', command: 'infra/whatsapp-bridge/run-checks.sh' },
  { suite: 'node', command: 'ui/scripts/verify-base-build.mjs' },
  { suite: 'node', command: 'e2e/fixtures/test-base.test.mjs' },
  { suite: 'node', command: 'e2e/smoke/check.test.mjs' },
]

const num = (value) => (value === '' || value === null || value === undefined ? 0 : Number(value) || 0)
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const byKey = (...keys) => (a, b) => keys.reduce((r, k) => r || cmp(a[k] ?? '', b[k] ?? ''), 0)

// The hash of the inputs in canonical form: sorted rows, sorted keys.
export function inputsSha256(rows, coverageMap) {
  const sorted = [...rows].sort(byKey('suite', 'file', 'test'))
  return createHash('sha256').update(toCsv(INVENTORY_COLUMNS, sorted)).update('\0').update(stableJson(coverageMap)).digest('hex')
}

function ineligibleReason(file, minCleanRuns) {
  const flakes = file.tests.reduce((n, t) => n + num(t.flakes), 0)
  if (flakes > 0) return `flake recorded (${flakes})`
  const mainFailures = file.tests.reduce((n, t) => n + num(t.main_failures), 0)
  if (mainFailures > 0) return `failed on main (${mainFailures})`
  if (file.tests.some((t) => num(t.fails_alone) > 0)) return 'fails_alone'
  const clean = file.tests.length === 0 ? 0 : Math.min(...file.tests.map((t) => num(t.passes)))
  if (clean < minCleanRuns) return `${clean} of ${minCleanRuns} clean runs`
  return null
}

// rows: inventory rows (CSV strings or numbers). coverageMap: coverage-map.json.
// previous: the last tests/blocking.json, or null. Returns the BlockingFile.
export function selectBlocking({ rows, coverageMap, previous = null, floor = FLOOR, minCleanRuns = MIN_CLEAN_RUNS }) {
  const files = new Map()
  const fileOf = (suite, file) => {
    const key = `${suite}:${file}`
    if (!files.has(key)) files.set(key, { suite, file, tests: [], units: [] })
    return files.get(key)
  }
  const alwaysRun = ALWAYS_RUN.map((a) => ({ ...a, reason: 'no_v8_coverage' }))
  let historyThrough = ''
  for (const row of rows) {
    if (row.last_seen > historyThrough) historyThrough = row.last_seen
    if (V8_SUITES.includes(row.suite) && row.file) fileOf(row.suite, row.file).tests.push(row)
    else if (!alwaysRun.some((a) => a.suite === row.suite && a.command === (row.file || row.test))) {
      alwaysRun.push({ suite: row.suite, command: row.file || row.test, reason: 'no_v8_coverage' })
    }
  }
  // Each covered unit ('<source>:<line>') gets an integer id, so the greedy
  // loop counts new lines over typed arrays, not string sets.
  const ids = new Map()
  for (const key of Object.keys(coverageMap).sort()) {
    const at = key.indexOf(':')
    const suite = key.slice(0, at)
    if (!V8_SUITES.includes(suite)) continue
    const file = fileOf(suite, key.slice(at + 1))
    for (const source of Object.keys(coverageMap[key]).sort()) {
      for (const line of decodeRanges(coverageMap[key][source])) {
        const unit = `${suite}\0${source}:${line}`
        if (!ids.has(unit)) ids.set(unit, ids.size)
        file.units.push(ids.get(unit))
      }
    }
  }
  const wasBlocking = new Set(
    [...(previous?.blocking ?? []), ...(previous?.demoted ?? [])].map((p) => `${p.suite}:${p.file}`),
  )

  const blocking = []
  const excluded = []
  const demoted = []
  const suites = {}
  for (const suite of V8_SUITES) {
    const pool = [...files.values()].filter((f) => f.suite === suite).sort(byKey('file'))
    const universe = new Set(pool.flatMap((f) => f.units))
    const target = Math.ceil(floor * universe.size)
    const isCovered = new Uint8Array(ids.size)
    let covered = 0
    const picked = new Set()
    const candidates = []
    for (const f of pool) {
      f.cost = f.tests.reduce((n, t) => n + num(t.median_ms), 0)
      const reason = ineligibleReason(f, minCleanRuns)
      if (reason === null) candidates.push(f)
      else (wasBlocking.has(`${suite}:${f.file}`) ? demoted : excluded).push({ suite, file: f.file, reason })
    }
    while (covered < target) {
      let best = null
      for (const f of candidates) {
        if (picked.has(f)) continue
        let gain = 0
        for (const u of f.units) gain += isCovered[u] ? 0 : 1
        if (gain === 0) continue
        // Lower cost per new line wins; compared as cross products, so no
        // float rounding can change the pick. Candidates are in path order,
        // so a tie keeps the earlier path.
        if (best === null || f.cost * best.gain < best.f.cost * gain) best = { f, gain }
      }
      if (best === null) break
      picked.add(best.f)
      for (const u of best.f.units) {
        if (!isCovered[u]) covered += 1
        isCovered[u] = 1
      }
      const unit = suite === 'e2e' ? 'units' : 'lines'
      blocking.push({
        suite,
        file: best.f.file,
        median_ms: best.f.cost,
        reason: `greedy: +${best.gain} ${unit} at ${(best.f.cost / best.gain).toFixed(1)} ms/${unit.slice(0, -1)}`,
      })
    }
    // An empty universe is no evidence: that suite runs in full.
    const floorMet = universe.size > 0 && covered >= target
    const unneeded = floorMet ? 'not needed: suite floor reached by cheaper files' : 'not needed: adds no new lines'
    for (const f of candidates) if (!picked.has(f)) excluded.push({ suite, file: f.file, reason: unneeded })
    const ratio = universe.size === 0 ? 0 : covered / universe.size
    suites[suite] = {
      covered,
      total: universe.size,
      ratio: Math.round(ratio * 10000) / 10000,
      floor_met: floorMet,
    }
  }
  const order = byKey('suite', 'file')
  return {
    schema_version: SCHEMA_VERSION,
    repo: rows[0]?.repo ?? previous?.repo ?? '',
    floor,
    min_clean_runs: minCleanRuns,
    max_age_days: MAX_AGE_DAYS,
    history_through: historyThrough,
    inputs_sha256: inputsSha256(rows, coverageMap),
    suites,
    blocking: blocking.sort(order),
    always_run: alwaysRun.sort(byKey('suite', 'command')),
    excluded: excluded.sort(order),
    demoted: demoted.sort(order),
  }
}

export function renderBlocking(blockingFile) {
  return stableJson(blockingFile)
}

function main() {
  const { values } = parseArgs({
    options: {
      inventory: { type: 'string', default: 'tests/inventory.csv' },
      coverage: { type: 'string', default: 'tests/coverage-map.json' },
      previous: { type: 'string', default: 'tests/blocking.json' },
      out: { type: 'string', default: 'tests/blocking.json' },
    },
  })
  const rows = parseCsv(readFileSync(values.inventory, 'utf8'))
  const coverageMap = JSON.parse(readFileSync(values.coverage, 'utf8'))
  const previous = existsSync(values.previous) ? JSON.parse(readFileSync(values.previous, 'utf8')) : null
  const result = selectBlocking({ rows, coverageMap, previous })
  writeFileSync(values.out, renderBlocking(result))
  for (const [suite, s] of Object.entries(result.suites)) {
    console.log(`select-blocking: ${suite} ${s.covered}/${s.total} (${s.ratio}) floor_met=${s.floor_met}`)
  }
  console.log(`select-blocking: ${result.blocking.length} blocking files -> ${values.out}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
