// HZ-949: jsonl-reporter.js streams one line per test attempt next to `list`
// and `junit`. Each case runs the browser-free fixture project in
// reporter-fixture/ with its own HORIZON_TEST_REPORT_DIR, never the farm's:
// the fixture fails on purpose, and that must not land in a real check's
// report.
//
// Plain node:test, run outside Playwright's test runner (same pattern as
// smoke/check.test.mjs) — see package.json's "test" script.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JsonlReporter from './jsonl-reporter.js'
import { e2eReporters } from './reporters.js'

const E2E = dirname(fileURLToPath(import.meta.url))
const PLAYWRIGHT = join(E2E, 'node_modules', '.bin', 'playwright')
const FIXTURE_CONFIG = join(E2E, 'reporter-fixture', 'playwright.config.js')

const temps = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hz949-reporter-'))
  temps.push(dir)
  return dir
}

// R1: a sentinel stands in for the farm's report dir. Every child gets its
// own dir explicitly, so this one must stay empty.
const SENTINEL = tempDir()
process.env.HORIZON_TEST_REPORT_DIR = SENTINEL

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function childEnv(reportDir, extra = {}) {
  const env = { ...process.env, ...extra }
  if (reportDir) {
    env.HORIZON_TEST_REPORT_DIR = reportDir
    env.FIXTURE_OUTPUT_DIR = join(reportDir, '..', 'results')
  } else {
    delete env.HORIZON_TEST_REPORT_DIR
  }
  return env
}

function runFixture(spec, { reportDir, env = {}, args = [], detached = false } = {}) {
  const child = spawn(PLAYWRIGHT, ['test', '-c', FIXTURE_CONFIG, spec, ...args], {
    cwd: E2E,
    env: childEnv(reportDir, env),
    detached,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })))
  return { child, done }
}

function reportDir() {
  const dir = join(tempDir(), 'report')
  mkdirSync(dir)
  return dir
}

function lines(dir) {
  const path = join(dir, 'e2e.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
}

// junit's [name, 'pass' | 'fail' | 'skip'] per <testcase>, as farm/checks.py reads it.
function junitCases(dir) {
  const xml = readFileSync(join(dir, 'e2e.xml'), 'utf8')
  return [...xml.matchAll(/<testcase name="([^"]*)"[^>]*>([\s\S]*?)<\/testcase>/g)].map(([, name, body]) => [
    name.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
    /<(failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass',
  ])
}

function forName(all, name) {
  return all.filter((line) => line.name === name)
}

// One healthy outcomes.spec.js run, shared by the cases that read it.
let healthy
async function healthyRun() {
  if (!healthy) {
    const dir = reportDir()
    healthy = runFixture('outcomes', { reportDir: dir }).done.then((result) => ({ ...result, dir }))
  }
  return healthy
}

test('metric 1: pass, fail and skip each get one started and one finished line with the right status', async () => {
  const { code, dir } = await healthyRun()
  assert.equal(code, 1)
  const all = lines(dir)
  for (const [name, status] of [
    ['passes', 'pass'],
    ['fails', 'fail'],
    ['skipped', 'skip'],
  ]) {
    const mine = forName(all, name)
    assert.deepEqual(
      mine.map((line) => line.event),
      ['started', 'finished'],
      name,
    )
    assert.equal(mine[1].status, status, name)
    assert.equal(mine[1].file, 'outcomes.spec.js')
  }
})

test('guardrail 2: a retried test writes a pair per attempt and the last finished line is final', async () => {
  const { dir } = await healthyRun()
  const flaky = forName(lines(dir), 'retried › flaky')
  assert.deepEqual(
    flaky.map((line) => [line.event, line.retry]),
    [
      ['started', 0],
      ['finished', 0],
      ['started', 1],
      ['finished', 1],
    ],
  )
  assert.equal(flaky[1].status, 'fail')
  assert.equal(flaky[3].status, 'pass')
  assert.equal(flaky[3].outcome, 'flaky')
})

test('metric 5: one testId with a finished line per junit testcase, the last status matching it', async () => {
  const { dir } = await healthyRun()
  const last = new Map()
  for (const line of lines(dir)) if (line.event === 'finished') last.set(line.testId, line)
  const cases = junitCases(dir)
  assert.equal(last.size, cases.length)
  assert.deepEqual(
    [...last.values()].map((line) => [line.name, line.status]).sort(),
    [...cases].sort(),
  )
})

test('metric 4: e2e.xml has the same testcases and results with and without the reporter', async () => {
  const { dir } = await healthyRun()
  const baselineDir = reportDir()
  const baseline = await runFixture('outcomes', { reportDir: baselineDir, env: { FIXTURE_NO_JSONL: '1' } }).done
  assert.equal(baseline.code, 1)
  assert.equal(existsSync(join(baselineDir, 'e2e.jsonl')), false)
  assert.deepEqual(junitCases(dir).sort(), junitCases(baselineDir).sort())
})

test('metric 2: a SIGKILL while the second test hangs leaves whole lines and no finish for it', async () => {
  const dir = reportDir()
  const { child, done } = runFixture('hang', { reportDir: dir, detached: true })
  const path = join(dir, 'e2e.jsonl')
  try {
    const deadline = Date.now() + 30_000
    while (!(existsSync(path) && readFileSync(path, 'utf8').includes('"event":"started","file":"hang.spec.js","name":"second"'))) {
      assert.ok(Date.now() < deadline, 'the second test never started')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    process.kill(-child.pid, 'SIGKILL')
    await done
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }

  const raw = readFileSync(path, 'utf8')
  assert.ok(raw.endsWith('\n'), 'no half-written last line')
  const all = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.deepEqual(
    all.map((line) => [line.event, line.name]),
    [
      ['started', 'first'],
      ['finished', 'first'],
      ['started', 'second'],
    ],
  )
  assert.equal(all[1].status, 'pass')
})

test('guardrail 4: a reporter that cannot write keeps the exit code and e2e.xml, and warns once', async () => {
  const { code, dir } = await healthyRun()
  for (const [args, expectedCode, expectedCases] of [
    [['--grep', 'passes'], 0, [['passes', 'pass']]],
    [[], code, junitCases(dir)],
  ]) {
    const brokenDir = reportDir()
    // A directory where the file should be: appendFileSync fails with EISDIR, even as root.
    mkdirSync(join(brokenDir, 'e2e.jsonl'))
    const result = await runFixture('outcomes', { reportDir: brokenDir, args }).done
    assert.equal(result.code, expectedCode, result.stderr)
    assert.deepEqual(junitCases(brokenDir).sort(), [...expectedCases].sort())
    assert.equal(result.stderr.match(/jsonl-reporter: stopped writing/g)?.length, 1, result.stderr)
  }
})

function importRealConfig(reportDir) {
  const script = `const c = (await import(${JSON.stringify(join(E2E, 'playwright.config.js'))})).default
process.stdout.write(JSON.stringify({ globalTimeout: c.globalTimeout, reporter: c.reporter }))`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: E2E,
    env: childEnv(reportDir),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  return new Promise((resolve, reject) =>
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)))),
  )
}

test('metrics 3 and 4: the real config keeps list and junit, adds the reporter, and ends under the farm budget', async () => {
  const dir = reportDir()
  const config = await importRealConfig(dir)
  assert.equal(typeof config.globalTimeout, 'number')
  // FARM_CHECK_TIMEOUT_S's default, 600s, bounds the whole `npm run test:e2e`.
  assert.ok(config.globalTimeout < 600_000, `globalTimeout ${config.globalTimeout}`)
  assert.deepEqual(config.reporter, [
    ['list'],
    ['junit', { outputFile: join(dir, 'e2e.xml') }],
    [join(E2E, 'jsonl-reporter.js'), { outputFile: join(dir, 'e2e.jsonl') }],
  ])
})

test('guardrail 3: with no report dir the real config runs list only and the reporter writes nothing', async () => {
  const config = await importRealConfig(undefined)
  assert.deepEqual(config.reporter, [['list']])
  assert.deepEqual(e2eReporters(undefined), [['list']])

  const dir = tempDir()
  const cwd = process.cwd()
  process.chdir(dir)
  const reporter = new JsonlReporter({})
  try {
    reporter.onBegin()
    const fakeTest = { title: 't', parent: { type: 'file', title: 'a.spec.js' }, id: 'x', location: {}, outcome: () => 'expected' }
    reporter.onTestBegin(fakeTest, { retry: 0 })
    reporter.onTestEnd(fakeTest, { retry: 0, status: 'passed', duration: 1 })
  } finally {
    process.chdir(cwd)
  }
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(reporter.broken, false)
})

test('R1: no fixture run wrote into the inherited report dir', async () => {
  await healthyRun()
  assert.deepEqual(readdirSync(SENTINEL), [])
})
