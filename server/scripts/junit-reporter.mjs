// HZ-327: the server suite's JUnit XML for HORIZON_TEST_REPORT_DIR (see
// package.json's test script). Node's built-in junit reporter leaves out the
// test file, and a test's history is per file: two files may hold a test of
// the same name. One <testsuite> per (file, describe path); a top-level test's
// suite name is empty. farm/checks.py's parse_junit reads it.
//
// HZ-950: a failing case carries why — <failure message="…"> with the
// assertion message plus labelled Expected:/Received: lines, the stack in the
// body. A failure that cannot be described still writes <failure/>: the
// report only ever loses detail, and the exit code alone decides the check.

import { inspect } from 'node:util'

// The farm reads at most this much of a failure (FAILURE_TEXT_MAX_CHARS).
const REPORT_MESSAGE_MAX = 4000

import { escapeXml } from './junit-cases.mjs'

// An XML parser turns a raw newline or tab in an attribute into a space.
const escapeAttr = (value) =>
  escapeXml(value).replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;')

const show = (value) => inspect(value, { depth: 2, breakLength: Infinity, maxStringLength: 500 })

// The message and stack of a test:fail error, or '' for either that cannot be
// read. node --test wraps the thrown error (ERR_TEST_FAILURE): it is `cause`.
function failureText(error) {
  try {
    const cause = error?.cause ?? error
    let message = String(cause?.message || error?.message || cause || '')
    if (cause !== null && typeof cause === 'object' && 'expected' in cause && 'actual' in cause) {
      message += `\nExpected: ${show(cause.expected)}\nReceived: ${show(cause.actual)}`
    }
    const stack = typeof cause?.stack === 'string' ? cause.stack : ''
    return { message: message.slice(0, REPORT_MESSAGE_MAX), stack: stack.slice(0, REPORT_MESSAGE_MAX) }
  } catch {
    return { message: '', stack: '' }
  }
}

export default async function* junitReporter(source) {
  // file -> names of the tests started at each nesting level, so a case can be
  // named by its describe path. test:start comes in definition order per file.
  const open = new Map()
  const suites = new Map()
  for await (const event of source) {
    const { name, file = '', nesting = 0, details, skip, todo } = event.data ?? {}
    if (event.type === 'test:start') {
      const path = open.get(file) ?? []
      path.length = nesting
      path[nesting] = name
      open.set(file, path)
      continue
    }
    if ((event.type !== 'test:pass' && event.type !== 'test:fail') || details?.type === 'suite') continue
    const suite = (open.get(file) ?? []).slice(0, nesting).join(' > ')
    const key = `${file}\u0000${suite}`
    if (!suites.has(key)) suites.set(key, { file, suite, cases: [] })
    const status = event.type === 'test:fail' ? 'fail' : skip || todo ? 'skip' : 'pass'
    const failure = status === 'fail' ? failureText(details?.error) : null
    suites.get(key).cases.push({ name, status, seconds: (details?.duration_ms ?? 0) / 1000, failure })
  }
  let xml = '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n'
  for (const { file, suite, cases } of suites.values()) {
    xml += `  <testsuite name="${escapeXml(suite)}" file="${escapeXml(file)}" tests="${cases.length}">\n`
    for (const { name, status, seconds, failure } of cases) {
      const body = failure?.message
        ? `<failure message="${escapeAttr(failure.message)}">${escapeXml(failure.stack)}</failure>`
        : status === 'fail' ? '<failure/>' : status === 'skip' ? '<skipped/>' : ''
      xml += `    <testcase name="${escapeXml(name)}" file="${escapeXml(file)}" time="${seconds.toFixed(6)}">${body}</testcase>\n`
    }
    xml += '  </testsuite>\n'
  }
  yield `${xml}</testsuites>\n`
}
