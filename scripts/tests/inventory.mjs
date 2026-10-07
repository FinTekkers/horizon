// HZ-328: the test inventory — one row per test with its HZ-327 history and
// the source it covers — the input of select-blocking.mjs.
//
//   npm run tests:export-history   # the history, from the live DB, read-only
//   npm run tests:inventory        # this script; writes the two files below
//
// Writes tests/inventory.csv (one row per test: INVENTORY_COLUMNS) and
// tests/coverage-map.json ({ "<suite>:<test file>": { "<source>": "1-40,52" } }).
// Coverage is measured here, one test file at a time, and only here — never in
// a gating check:
//   server  node --test --experimental-test-coverage (V8), server/src/** lines
//   ui      vitest --coverage.provider=v8, ui/src/** lines
//   e2e     one spec alone with HORIZON_E2E_COVERAGE_DIR set: the /api/ routes
//           it requests ("route:GET /api/items/:id") and the ui/src components
//           its JS coverage maps to through the build's sourcemaps
//           ("component:ui/src/App.jsx", when one of its functions ran);
//           each counts as one unit, line "1".
// A file whose run fails on its own is marked fails_alone. History is read from
// the --history file and never rerun to build: a row's runs are HZ-327's.
//
// Each run is under `nice -n 10` with its own throwaway HORIZON_DB and
// FARM_HOME (an inherited FARM_HOME is dropped, so nothing reaches the real
// farm) and no HORIZON_TEST_REPORT_DIR, so no run is recorded as history.
// --suites re-collects some suites and keeps the others' entries from the
// committed files. Run it on an idle host: the e2e suite's globalTimeout.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { INVENTORY_COLUMNS, encodeRanges, parseCsv, stableJson, toCsv } from './format.mjs'

export { INVENTORY_COLUMNS }

// The suites with V8 coverage, which select-blocking.mjs can price.
export const V8_SUITES = ['server', 'ui', 'e2e']
export const INVENTORY_CSV = 'tests/inventory.csv'
export const COVERAGE_MAP = 'tests/coverage-map.json'
const SPEC_RE = /\.spec\.[cm]?[jt]sx?$/
const RUN_TIMEOUT_MS = 5 * 60_000

// A history row's inventory suite and repo-relative test file. The server's
// JUnit names the file; vitest's and Playwright's leave file null and put the
// path in the suite name ('src/App.test.jsx', '01-board.spec.js'). A row with
// neither is a whole command (pytest, the shell tests): suite 'command'.
export function classifyTest({ suite, file }) {
  if (file) {
    const top = file.split('/')[0]
    return { suite: V8_SUITES.includes(top) ? top : 'other', file }
  }
  if (suite && SPEC_RE.test(suite)) return { suite: 'e2e', file: `e2e/tests/${suite}` }
  if (suite && suite.startsWith('src/')) return { suite: 'ui', file: `ui/${suite}` }
  return { suite: 'command', file: null }
}

function compareRows(a, b) {
  for (const key of ['suite', 'file', 'test']) {
    if (a[key] < b[key]) return -1
    if (a[key] > b[key]) return 1
  }
  return 0
}

// history: export-test-history.mjs's output. coverage: the coverage map.
// failsAlone: '<suite>:<file>' keys whose run failed alone. exists: whether a
// test file is still in the repo (history keeps deleted files for 90 days).
// Returns the rows sorted by (suite, file, test) and the CSV text.
export function buildInventory({ repo, history, coverage = {}, failsAlone = [], exists = () => true }) {
  const failing = new Set(failsAlone)
  const rows = []
  for (const t of history.tests) {
    const { suite, file } = classifyTest(t)
    if (file && !exists(file)) continue
    const key = `${suite}:${file}`
    // A server test is named by its describe path too: two describes in one
    // file may hold tests of the same name.
    const test = t.file && t.suite ? `${t.suite} > ${t.test}` : t.test
    rows.push({
      repo,
      suite,
      file: file ?? '',
      test,
      runs: t.runs,
      passes: t.passes ?? t.runs - t.failures - t.skips,
      failures: t.failures,
      main_failures: t.main_failures ?? 0,
      flakes: t.flakes,
      median_ms: t.median_ms ?? '',
      p95_ms: t.p95_ms ?? '',
      last_seen: t.last_seen,
      fails_alone: failing.has(key) ? 1 : 0,
      covered_files: Object.hasOwn(coverage, key) ? Object.keys(coverage[key]).length : 0,
    })
  }
  rows.sort(compareRows)
  return { rows, csv: toCsv(INVENTORY_COLUMNS, rows) }
}

// ---- collectors: one test file each, { coverage: {source: ranges}, ok } ----

function childEnv(scratch, extra = {}) {
  const env = { ...process.env }
  // NODE_TEST_CONTEXT is set when this runs under node --test itself; a child
  // that inherits it reports to that parent and writes no lcov.
  for (const name of ['FARM_HOME', 'HORIZON_DB', 'HORIZON_TEST_REPORT_DIR', 'HORIZON_E2E_COVERAGE_DIR', 'NODE_TEST_CONTEXT']) {
    delete env[name]
  }
  return { ...env, FARM_HOME: join(scratch, 'farm-home'), HORIZON_DB: join(scratch, 'test.db'), ...extra }
}

function runNice(command, args, { cwd, env }) {
  return new Promise((done) => {
    const child = spawn('nice', ['-n', '10', command, ...args], { cwd, env, stdio: 'ignore', timeout: RUN_TIMEOUT_MS })
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
  })
}

async function inScratch(fn) {
  const scratch = mkdtempSync(join(tmpdir(), 'horizon-inventory-'))
  try {
    return await fn(scratch)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function addLines(byFile, root, path, prefix, lines) {
  const rel = relative(root, path).split(sep).join('/')
  if (!rel.startsWith(prefix) || lines.length === 0) return
  byFile.set(rel, [...(byFile.get(rel) ?? []), ...lines])
}

function encodeAll(byFile) {
  return Object.fromEntries([...byFile].sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, lines]) => [f, encodeRanges(lines)]))
}

// lcov text -> { 'server/src/x.js': '1-3,7' }: lines run at least once.
// Node writes SF: paths relative to the run's cwd.
export function parseLcov(text, root, prefix, cwd = root) {
  const byFile = new Map()
  let path = null
  let lines = []
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      path = resolve(cwd, line.slice(3))
      lines = []
    } else if (line.startsWith('DA:')) {
      const [n, count] = line.slice(3).split(',').map(Number)
      if (count > 0) lines.push(n)
    } else if (line === 'end_of_record' && path) {
      addLines(byFile, root, path, prefix, lines)
      path = null
    }
  }
  return encodeAll(byFile)
}

// Istanbul JSON (vitest's coverage-final.json, v8-to-istanbul's output) ->
// source -> covered lines, for sources under prefix that are not tests.
function istanbulLines(data, root, prefix) {
  const byFile = new Map()
  for (const [path, fc] of Object.entries(data)) {
    if (/\.test\.[cm]?[jt]sx?$/.test(path)) continue
    const lines = []
    for (const [id, count] of Object.entries(fc.s ?? {})) {
      const loc = fc.statementMap?.[id]
      if (count > 0 && loc) for (let n = loc.start.line; n <= loc.end.line; n++) lines.push(n)
    }
    addLines(byFile, root, path, prefix, lines)
  }
  return byFile
}

export function collectServerCoverage(root, file) {
  return inScratch(async (scratch) => {
    const serverDir = join(root, 'server')
    const lcov = join(scratch, 'lcov.info')
    const ok = await runNice(
      process.execPath,
      ['--test', '--experimental-test-coverage', '--test-reporter=lcov', `--test-reporter-destination=${lcov}`, relative(serverDir, join(root, file))],
      { cwd: serverDir, env: childEnv(scratch) },
    )
    return { coverage: existsSync(lcov) ? parseLcov(readFileSync(lcov, 'utf8'), root, 'server/src/', serverDir) : {}, ok }
  })
}

export function collectUiCoverage(root, file) {
  return inScratch(async (scratch) => {
    const uiDir = join(root, 'ui')
    const reports = join(scratch, 'coverage')
    const ok = await runNice(
      join(uiDir, 'node_modules/.bin/vitest'),
      [
        'run',
        relative(uiDir, join(root, file)),
        '--coverage.enabled',
        '--coverage.provider=v8',
        '--coverage.reporter=json',
        '--coverage.reportOnFailure',
        `--coverage.reportsDirectory=${reports}`,
        '--coverage.include=src/**',
      ],
      { cwd: uiDir, env: childEnv(scratch) },
    )
    const final = join(reports, 'coverage-final.json')
    const data = existsSync(final) ? JSON.parse(readFileSync(final, 'utf8')) : {}
    return { coverage: encodeAll(istanbulLines(data, root, 'ui/src/')), ok }
  })
}

// The fixture (e2e/fixtures/test-base.js) writes one JSON file per test:
// { spec, routes, js: [{ url, functions }] }. Its JS is the production bundle
// under ui/dist; v8-to-istanbul maps it to ui/src through the sourcemap the
// build writes when HORIZON_E2E_COVERAGE_DIR is set. v8-to-istanbul is
// installed only by scripts/tests/package.json (npm run tests:inventory), so it
// is imported here, never at the top: the server suite imports this module.
export function collectE2eCoverage(root, spec) {
  return inScratch(async (scratch) => {
    const e2eDir = join(root, 'e2e')
    const dumps = join(scratch, 'e2e-coverage')
    const ok = await runNice(join(e2eDir, 'node_modules/.bin/playwright'), ['test', relative(e2eDir, join(root, spec))], {
      cwd: e2eDir,
      env: childEnv(scratch, { HORIZON_E2E_COVERAGE_DIR: dumps, HORIZON_E2E_RUN_KEY: scratch }),
    })
    const { default: v8toIstanbul } = await import('v8-to-istanbul')
    const units = {}
    const components = new Set()
    for (const name of existsSync(dumps) ? readdirSync(dumps).sort() : []) {
      const dump = JSON.parse(readFileSync(join(dumps, name), 'utf8'))
      for (const route of dump.routes ?? []) units[route] = '1'
      for (const { url, functions } of dump.js ?? []) {
        const bundle = join(root, 'ui/dist', new URL(url).pathname)
        if (!existsSync(bundle) || !existsSync(`${bundle}.map`)) continue
        const converter = v8toIstanbul(bundle, 0, {
          source: readFileSync(bundle, 'utf8'),
          sourceMap: { sourcemap: JSON.parse(readFileSync(`${bundle}.map`, 'utf8')) },
        })
        await converter.load()
        converter.applyCoverage(functions)
        // One bundle evaluates every module's top level on load, so a
        // component counts only when one of its functions ran.
        for (const [path, fc] of Object.entries(converter.toIstanbul())) {
          const source = relative(root, path).split(sep).join('/')
          if (source.startsWith('ui/src/') && Object.values(fc.f ?? {}).some((n) => n > 0)) components.add(source)
        }
        converter.destroy()
      }
    }
    for (const source of components) units[`component:${source}`] = '1'
    return { coverage: Object.fromEntries(Object.keys(units).sort().map((k) => [k, units[k]])), ok }
  })
}

const COLLECTORS = { server: collectServerCoverage, ui: collectUiCoverage, e2e: collectE2eCoverage }

// The test files of one suite, repo-relative, sorted.
export function discoverTestFiles(root, suite) {
  const list = (dir, re, recursive = false) =>
    existsSync(join(root, dir))
      ? readdirSync(join(root, dir), { recursive })
          .map((f) => `${dir}/${String(f).split(sep).join('/')}`)
          .filter((f) => re.test(f) && !f.includes('/node_modules/'))
          .sort()
      : []
  if (suite === 'server') return list('server/test', /\.test\.mjs$/)
  if (suite === 'ui') return list('ui/src', /\.test\.[jt]sx?$/, true)
  if (suite === 'e2e') return list('e2e/tests', SPEC_RE)
  return []
}

async function main() {
  const { values } = parseArgs({
    options: { history: { type: 'string' }, root: { type: 'string', default: '.' }, suites: { type: 'string', default: V8_SUITES.join(',') } },
  })
  if (!values.history) {
    console.error('usage: node scripts/tests/inventory.mjs --history <file> [--suites server,ui,e2e] [--root .]')
    process.exit(2)
  }
  const root = realpathSync(resolve(values.root))
  const suites = values.suites.split(',').filter((s) => V8_SUITES.includes(s))
  const history = JSON.parse(readFileSync(values.history, 'utf8'))
  const mapPath = join(root, COVERAGE_MAP)
  const csvPath = join(root, INVENTORY_CSV)
  const suiteOf = (key) => key.slice(0, key.indexOf(':'))
  // Suites not collected now keep their committed coverage and fails_alone.
  const kept = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf8')) : {}
  const coverage = Object.fromEntries(Object.entries(kept).filter(([key]) => !suites.includes(suiteOf(key))))
  const failsAlone = existsSync(csvPath)
    ? parseCsv(readFileSync(csvPath, 'utf8'))
        .filter((r) => r.fails_alone === '1' && !suites.includes(r.suite))
        .map((r) => `${r.suite}:${r.file}`)
    : []
  for (const suite of suites) {
    for (const file of discoverTestFiles(root, suite)) {
      const started = Date.now()
      const { coverage: covered, ok } = await COLLECTORS[suite](root, file)
      coverage[`${suite}:${file}`] = covered
      if (!ok) failsAlone.push(`${suite}:${file}`)
      console.log(`inventory: ${file} ${ok ? 'ok' : 'FAILED alone'} — ${Object.keys(covered).length} sources, ${Date.now() - started} ms`)
    }
  }
  const exists = (file) => existsSync(join(root, file))
  for (const key of Object.keys(coverage)) if (!exists(key.slice(key.indexOf(':') + 1))) delete coverage[key]
  const { rows, csv } = buildInventory({ repo: history.repo, history, coverage, failsAlone, exists })
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(csvPath, csv)
  writeFileSync(mapPath, stableJson(coverage))
  console.log(`inventory: ${rows.length} tests -> ${INVENTORY_CSV}, ${Object.keys(coverage).length} test files -> ${COVERAGE_MAP}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
