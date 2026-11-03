// Unit tests for the pure logic behind the "See agent output" live-tail page
// (HZ-14). appendLog/timedOut are embedded verbatim into the served page's
// inline <script> (see clientScript() and app.test.mjs's page-content
// assertions), so these tests are exercising the exact code the browser runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
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

// ---- HZ-717: the live page says when the farm can't be reached ----
// Runs the exact served script in node:vm against a stub DOM, a stub fetch
// that replays canned log-route replies, and a manual setTimeout queue.

function runPage(replies) {
  const el = () => ({ textContent: '', hidden: true, focus() {}, addEventListener() {} })
  const nodes = { log: el(), status: el(), reconnect: el() }
  const timers = []
  const fetched = []
  const context = {
    document: { getElementById: (id) => nodes[id] },
    window: { location: { href: 'https://horizon.test/api/runs/7/log/view' } },
    URL,
    Date,
    setTimeout: (fn) => timers.push(fn),
    fetch: (url) => {
      fetched.push(String(url))
      const [status, body] = replies.shift() ?? [200, { content: '', next_offset: 0, active: true }]
      return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body })
    },
  }
  vm.runInNewContext(clientScript(), context)
  const settle = () => new Promise((r) => setImmediate(r))
  return {
    nodes,
    timers,
    fetched,
    settle,
    async tick() {
      timers.shift()()
      await settle()
    },
  }
}

const FARM_DOWN = [503, { error: 'farm unavailable' }]

test('a 503 farm unavailable says the farm is unreachable, polls again, and clears once a read succeeds', async () => {
  const page = runPage([FARM_DOWN, [200, { content: 'step one\n', next_offset: 9, active: true }]])
  await page.settle()
  assert.equal(page.nodes.status.textContent, 'Can’t reach the farm. Retrying…')
  assert.equal(page.nodes.log.textContent, '', 'no log yet')
  assert.equal(page.timers.length, 1, 'another poll is scheduled')

  await page.tick()
  assert.equal(page.fetched.length, 2)
  assert.equal(page.nodes.log.textContent, 'step one\n')
  assert.equal(page.nodes.status.textContent, '')
  assert.equal(page.timers.length, 1, 'keeps polling the live run')
})

test('a 404 keeps its own message, not the unreachable one, and stops polling', async () => {
  const page = runPage([[404, { error: 'not found' }]])
  await page.settle()
  assert.equal(page.nodes.status.textContent, 'This run’s output is no longer available.')
  assert.doesNotMatch(page.nodes.status.textContent, /reach the farm/)
  assert.equal(page.timers.length, 0)
})

test('a 503 then a 404 ends on the 404 message with no further poll', async () => {
  const page = runPage([FARM_DOWN, [404, { error: 'not found' }]])
  await page.settle()
  assert.equal(page.nodes.status.textContent, 'Can’t reach the farm. Retrying…')
  await page.tick()
  assert.equal(page.nodes.status.textContent, 'This run’s output is no longer available.')
  assert.equal(page.timers.length, 0)
})

test('the unreachable status is fixed text: no farm detail from the reply reaches the page', async () => {
  const page = runPage([[503, { error: 'farm unavailable', detail: 'connect ECONNREFUSED 10.0.0.5:8700' }]])
  await page.settle()
  assert.equal(page.nodes.status.textContent, 'Can’t reach the farm. Retrying…')
  for (const node of [page.nodes.status, page.nodes.log]) {
    assert.doesNotMatch(node.textContent, /10\.0\.0\.5|ECONNREFUSED/)
  }
})

test('any other failure keeps the silent retry', async () => {
  const page = runPage([[500, 'not json']])
  await page.settle()
  assert.equal(page.nodes.status.textContent, '')
  assert.equal(page.timers.length, 1)
})
