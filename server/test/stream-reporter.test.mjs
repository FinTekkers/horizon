// HZ-951: server/scripts/stream-reporter.mjs streams one JSON line per test
// start and finish to $HORIZON_TEST_REPORT_DIR/server.jsonl. Each fixture
// run uses the reporter flags package.json's test script ships, so
// junit-reporter.mjs still writes server.xml beside it. A run killed
// mid-test keeps every finished test and names the running one; a missing or
// broken stream never changes the exit code or server.xml.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const SERVER = join(REPO_ROOT, 'server')
const FIXTURES = join(SERVER, 'test/fixtures/stream-reporter')
const PASS_FAIL = join(FIXTURES, 'pass-fail.fixture.mjs')
const SLEEP = join(FIXTURES, 'sleep.fixture.mjs')
const OUTER_DIR = process.env.HORIZON_TEST_REPORT_DIR

// The reporter flags `npm test` passes for `dir`, read from package.json's
// test script and expanded as the shell does: none when `dir` is unset.
function shippedFlags(dir) {
  const script = JSON.parse(readFileSync(join(SERVER, 'package.json'), 'utf8')).scripts.test
  const block = /\$\{HORIZON_TEST_REPORT_DIR:\+([^}]*)\}/.exec(script)?.[1]
  assert.ok(block, `no HORIZON_TEST_REPORT_DIR block in ${script}`)
  return dir ? block.trim().split(/\s+/).map((flag) => flag.replaceAll('$HORIZON_TEST_REPORT_DIR', dir)) : []
}

// The child gets only the report dir given: never this run's own, and never
// this runner's context (the child would report to it).
function childEnv(dir) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.HORIZON_TEST_REPORT_DIR
  if (dir) env.HORIZON_TEST_REPORT_DIR = dir
  return env
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'horizon-stream-reporter-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function runShipped(fixture, dir) {
  return spawnSync(process.execPath, ['--test', ...shippedFlags(dir), fixture], {
    cwd: SERVER,
    env: childEnv(dir),
    encoding: 'utf8',
    timeout: 60_000,
  })
}

const lines = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((raw) => JSON.parse(raw))

// <testcase name> -> 'fail' | 'pass' in a server.xml.
function xmlCases(path) {
  const found = {}
  for (const [, name, body] of readFileSync(path, 'utf8').matchAll(/<testcase name="([^"]*)"[^>]*>(.*?)<\/testcase>/gs)) {
    found[name] = body.startsWith('<failure') ? 'fail' : 'pass'
  }
  return found
}

function jsonlFiles(dir) {
  return readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith('.jsonl'))
}

test('the shipped flags stream a start and finish line per test and still write server.xml', (t) => {
  const dir = tempDir(t)
  const proc = runShipped(PASS_FAIL, dir)

  assert.equal(proc.status, 1, proc.stdout + proc.stderr)
  assert.deepEqual(jsonlFiles(dir), ['server.jsonl'])
  const got = lines(join(dir, 'server.jsonl'))
  assert.deepEqual(
    got.map((e) => [e.event, e.name, e.suite]),
    [
      ['started', 'passes', ''],
      ['finished', 'passes', ''],
      ['started', 'fails', 'outer > inner'],
      ['finished', 'fails', 'outer > inner'],
    ],
  )
  assert.ok(got.every((e) => e.file === PASS_FAIL))
  const finished = Object.fromEntries(got.filter((e) => e.event === 'finished').map((e) => [e.name, e]))
  assert.equal(finished.passes.status, 'pass')
  assert.equal(finished.fails.status, 'fail')
  assert.match(finished.fails.failure, /strictly equal/)
  assert.ok(Object.values(finished).every((e) => Number.isInteger(e.duration_ms) && e.duration_ms >= 0))
  // server.xml holds the same 2 cases under the same names.
  assert.deepEqual(xmlCases(join(dir, 'server.xml')), { passes: 'pass', fails: 'fail' })
  assert.match(readFileSync(join(dir, 'server.xml'), 'utf8'), /<testsuite name="outer &gt; inner" /)
  // tap still goes to stdout.
  assert.match(proc.stdout, /^not ok \d+ - outer/m)
})

test('a run killed during its second test keeps the first and names the second', async (t) => {
  const dir = tempDir(t)
  const stream = join(dir, 'server.jsonl')
  // Its own group, so the kill reaches the test-file child too.
  const child = spawn(process.execPath, ['--test', ...shippedFlags(dir), SLEEP], {
    cwd: SERVER,
    env: childEnv(dir),
    detached: true,
    stdio: 'ignore',
  })
  let exited = false
  const exit = new Promise((resolve) => child.on('exit', () => resolve((exited = true))))
  try {
    const deadline = Date.now() + 60_000
    while (!(existsSync(stream) && readFileSync(stream, 'utf8').includes('"sleeps"'))) {
      assert.ok(!exited, 'the fixture run ended before its second test started')
      assert.ok(Date.now() < deadline, "the second test's start line never appeared")
      await sleep(50)
    }
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
    await exit
  }

  const got = lines(stream)
  assert.deepEqual(
    got.map((e) => [e.event, e.name]),
    [
      ['started', 'first'],
      ['finished', 'first'],
      ['started', 'sleeps'],
    ],
  )
  assert.equal(got[1].status, 'pass')
})

test('with the variable unset no stream is written and the exit code is the same', (t) => {
  const dir = tempDir(t)
  const reports = join(dir, 'reports')
  mkdirSync(reports)
  const unset = runShipped(PASS_FAIL, undefined)
  const withDir = runShipped(PASS_FAIL, reports)
  assert.equal(unset.status, 1, unset.stdout + unset.stderr)
  assert.equal(withDir.status, unset.status)

  // The reporter itself, loaded with the variable unset, writes nothing.
  const cwd = join(dir, 'cwd')
  mkdirSync(cwd)
  const direct = spawnSync(
    process.execPath,
    ['--test', `--test-reporter=${join(SERVER, 'scripts/stream-reporter.mjs')}`, '--test-reporter-destination=stderr', PASS_FAIL],
    { cwd, env: childEnv(undefined), encoding: 'utf8', timeout: 60_000 },
  )
  assert.equal(direct.status, 1, direct.stdout + direct.stderr)
  assert.deepEqual(jsonlFiles(cwd), [])
  assert.deepEqual(jsonlFiles(reports), ['server.jsonl'])
})

test('a stream that cannot be written changes neither the exit code nor server.xml', (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'server.jsonl'))
  const proc = runShipped(PASS_FAIL, dir)

  assert.equal(proc.status, 1, proc.stdout + proc.stderr)
  assert.deepEqual(xmlCases(join(dir, 'server.xml')), { passes: 'pass', fails: 'fail' })
  assert.doesNotMatch(proc.stderr, /stream-reporter|EISDIR/)
})

test("no fixture run appends to this run's own stream", { skip: !OUTER_DIR && 'HORIZON_TEST_REPORT_DIR is unset' }, () => {
  const outer = join(OUTER_DIR, 'server.jsonl')
  const text = existsSync(outer) ? readFileSync(outer, 'utf8') : ''
  assert.ok(!text.includes(FIXTURES), 'a fixture test was streamed to the outer report')
})
