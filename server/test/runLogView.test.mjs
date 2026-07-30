// Unit tests for the pure logic behind the "See agent output" live-tail page
// (HZ-14). appendLog/timedOut are embedded verbatim into the served page's
// inline <script> (see clientScript() and app.test.mjs's page-content
// assertions), so these tests are exercising the exact code the browser runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendLog, timedOut, clientScript, POLL_MS, LOG_KEEP_CHARS, TIMEOUT_MS } from '../src/runLogView.js'

test('appendLog concatenates new content onto the buffer', () => {
  assert.equal(appendLog('hello ', 'world'), 'hello world')
  assert.equal(appendLog('', 'first chunk'), 'first chunk')
})

test('appendLog caps the buffer at LOG_KEEP_CHARS, keeping the most recent text', () => {
  const buffer = 'a'.repeat(LOG_KEEP_CHARS)
  const result = appendLog(buffer, 'NEW')
  assert.equal(result.length, LOG_KEEP_CHARS)
  assert.ok(result.endsWith('NEW'))
})

test('timedOut is false before the 3-minute wall clock elapses', () => {
  const start = 1_000_000
  assert.equal(timedOut(start, start), false)
  assert.equal(timedOut(start, start + TIMEOUT_MS - 1), false)
})

test('timedOut is true at and after the 3-minute wall clock', () => {
  const start = 1_000_000
  assert.equal(timedOut(start, start + TIMEOUT_MS), true)
  assert.equal(timedOut(start, start + TIMEOUT_MS + 60_000), true)
})

test('clientScript embeds the real constants and the exact tested function source', () => {
  const script = clientScript()
  assert.match(script, new RegExp(`var POLL_MS = ${POLL_MS};`))
  assert.match(script, new RegExp(`var LOG_KEEP_CHARS = ${LOG_KEEP_CHARS};`))
  assert.match(script, new RegExp(`var TIMEOUT_MS = ${TIMEOUT_MS};`))
  assert.ok(script.includes(appendLog.toString()), 'ships the exact appendLog source under test')
  assert.ok(script.includes(timedOut.toString()), 'ships the exact timedOut source under test')
})

test('clientScript writes streamed content via .textContent, never innerHTML — agent output is untrusted', () => {
  const script = clientScript()
  assert.ok(script.includes('.textContent ='), 'must assign text nodes, not parse HTML')
  assert.ok(!script.includes('innerHTML'), 'innerHTML would let untrusted agent output run as markup/script')
})
