// HZ-950: a failing node --test case's JUnit report carries why it failed —
// <failure message="…"> with the assertion message and labelled Expected: and
// Received: lines — and a failure that cannot be described still writes a
// valid report and exits 1. farm/tests/test_checks_failing_tests.py parses
// the same reporter's output with the farm's real parser.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const REPORTER = join(REPO_ROOT, 'server/scripts/junit-reporter.mjs')

// Runs `body` as a test file under the reporter: its exit code and report.
// inProcess runs the file itself, not under --test, so the reporter gets the
// thrown error object, not a copy serialized from a child process.
function runReporter(body, { inProcess = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'horizon-junit-reporter-'))
  writeFileSync(join(dir, 'case.test.mjs'), `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n${body}\n`)
  const out = join(dir, 'out.xml')
  // Run under this test runner, the child would report to it, not to `out`.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const proc = spawnSync(
    process.execPath,
    [...(inProcess ? [] : ['--test']), `--test-reporter=${REPORTER}`, `--test-reporter-destination=${out}`, 'case.test.mjs'],
    { cwd: dir, env, encoding: 'utf8', timeout: 60_000 },
  )
  try {
    return { status: proc.status, xml: readFileSync(out, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The XML entity decoding a parser applies to an attribute value.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (value) =>
  value.replace(/&(#\d+|amp|lt|gt|quot|apos);/g, (_, e) => (e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : ENTITIES[e]))

// Each <testcase name="…"> -> its raw failure markup ('' for none).
function cases(xml) {
  const found = {}
  for (const [, name, body] of xml.matchAll(/<testcase name="([^"]*)"[^>]*>(.*?)<\/testcase>/gs)) found[decode(name)] = body
  return found
}

const messageOf = (body) => decode(/^<failure message="([^"]*)">/.exec(body)?.[1] ?? '')

test('a failing assertion writes <failure message> with its expected and received values; a pass has no message', () => {
  const { status, xml } = runReporter(
    "test('fails', () => { assert.strictEqual(1717, 4242) })\ntest('passes', () => {})",
  )

  assert.equal(status, 1)
  assert.ok(xml.includes('<failure message="'), xml)
  assert.ok(!xml.includes('<failure/>'), xml)
  const { fails, passes } = cases(xml)
  const message = messageOf(fails)
  assert.match(message, /^Expected values to be strictly equal:/)
  assert.match(message, /\nExpected: 4242\nReceived: 1717$/)
  assert.match(fails, /<\/failure>$/)
  assert.equal(passes, '')
})

test('a message with < > & " and a newline round-trips through the parsed attribute', () => {
  const { status, xml } = runReporter(`test('escapes', () => { throw new Error('a<b>&"c\\nd') })`)

  assert.equal(status, 1)
  const raw = /<failure message="([^"]*)">/.exec(xml)[1]
  assert.ok(!/[<>\n]/.test(raw), raw)
  assert.equal(decode(raw), 'a<b>&"c\nd')
})

test('an error whose actual getter throws still exits 1 and writes a valid report with <failure/>', () => {
  const { status, xml } = runReporter(
    "test('unreadable', () => {\n" +
      "  const error = new Error('boom')\n" +
      "  Object.defineProperty(error, 'expected', { value: 1 })\n" +
      "  Object.defineProperty(error, 'actual', { get() { throw new Error('getter') } })\n" +
      '  throw error\n' +
      '})',
    { inProcess: true },
  )

  assert.equal(status, 1)
  assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>\n<testsuites>\n[\s\S]*<\/testsuites>\n$/)
  assert.equal(cases(xml).unreadable, '<failure/>')
})
