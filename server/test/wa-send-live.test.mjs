// HZ-141 — waSend.js over a REAL socket, with the REAL globalThis.fetch.
//
// gate-notifier-retry.test.mjs covers the same failure taxonomy through an
// injected `fetchImpl`. That is the right tool for "what does the drain do with
// a 500", but it means the default argument — globalThis.fetch — the actual
// bytes this code puts on the wire, and the AbortController timeout are all
// unexecuted. Every assertion below goes through a real HTTP request to a real
// listener; nothing here passes `fetchImpl` at all.
//
// The bridge URL is the stub's, so this test cannot reach the paired bridge on
// a developer's machine even if WA_BRIDGE_URL is exported in their shell.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { startStubBridge } from './helpers/stubBridge.mjs'

const bridge = await startStubBridge()
// Set BEFORE the waSend.js import below: config.js reads process.env once, at
// module load. The trailing slash is deliberate — it proves the strip in
// config.js survives a real request rather than only a string assertion.
process.env.WA_BRIDGE_URL = `${bridge.url}/`

const { sendWhatsApp, WaSendError, BOT_MARKER } = await import('../src/waSend.js')

after(() => bridge.close())

test('a successful send puts exactly one POST /api/send on the wire, marker-prefixed once', async () => {
  bridge.reset()
  await sendWhatsApp('15550001111@s.whatsapp.net', 'HZ-1 — a real request')

  assert.equal(bridge.requests.length, 1, 'more than one request reached the bridge')
  const req = bridge.requests[0]
  assert.equal(req.method, 'POST')
  // The trailing slash on WA_BRIDGE_URL must not survive into the path.
  assert.equal(req.path, '/api/send')
  assert.match(req.headers['content-type'], /application\/json/)
  // Exactly the two fields mcp_bridge.py's /api/send takes — no extra field,
  // and in particular no credential: that endpoint has no auth and this path
  // holds no secret to offer it.
  assert.deepEqual(Object.keys(req.body).sort(), ['message', 'recipient'])
  assert.equal(req.body.recipient, '15550001111@s.whatsapp.net')
  assert.equal(req.body.message, `${BOT_MARKER}HZ-1 — a real request`)
  assert.equal(req.body.message.split(BOT_MARKER).length - 1, 1, 'the bot marker was sent twice')
  assert.ok(!/authorization|secret|token/i.test(req.raw))
  assert.ok(!('authorization' in req.headers))
})

test('a multi-line body survives the wire byte for byte, emoji and all', async () => {
  bridge.reset()
  const body = 'BF-1 — Título wîth accents\nGate: Accept the code\nAsking: yes or no.\nhttps://shoreward.ai/horizon/bf-1'
  await sendWhatsApp('15550001111@s.whatsapp.net', body)
  assert.equal(bridge.sends()[0].body.message, BOT_MARKER + body)
})

test('a 500 from a real listener throws WaSendError carrying the status and the body detail', async () => {
  bridge.reset()
  bridge.setHandler(() => ({ status: 500, payload: 'bridge exploded' }))
  const err = await sendWhatsApp('15550001111@s.whatsapp.net', 'x').then(
    () => null,
    (e) => e,
  )
  assert.ok(err instanceof WaSendError, `expected WaSendError, got ${err}`)
  assert.equal(err.status, 500)
  assert.match(err.message, /bridge send returned 500: bridge exploded/)
})

test('a real 200 carrying success:false is a refusal, not a success', async () => {
  bridge.reset()
  bridge.setHandler(() => ({ payload: JSON.stringify({ success: false, message: 'no whatsapp session' }) }))
  const err = await sendWhatsApp('15550001111@s.whatsapp.net', 'x').then(
    () => null,
    (e) => e,
  )
  assert.ok(err instanceof WaSendError)
  assert.equal(err.status, 200, 'the refusal came back on a 200 — that is the status to report')
  assert.match(err.message, /bridge refused the send: no whatsapp session/)
})

test('an unparseable real 200 body counts as a success — the same call mcp_bridge.py makes', async () => {
  bridge.reset()
  bridge.setHandler(() => ({ payload: 'not json at all' }))
  await sendWhatsApp('15550001111@s.whatsapp.net', 'x') // must not throw
  assert.equal(bridge.sends().length, 1)
})

test('an empty real 200 body counts as a success too', async () => {
  bridge.reset()
  bridge.setHandler(() => ({ payload: '' }))
  await sendWhatsApp('15550001111@s.whatsapp.net', 'x')
  assert.equal(bridge.sends().length, 1)
})

test('a bridge that never answers is aborted by the real timeout, with status null', async () => {
  bridge.reset()
  bridge.setHandler(() => ({ hang: true }))
  const started = Date.now()
  const err = await sendWhatsApp('15550001111@s.whatsapp.net', 'x', { timeoutMs: 150 }).then(
    () => null,
    (e) => e,
  )
  assert.ok(err instanceof WaSendError, `expected WaSendError, got ${err}`)
  assert.equal(err.status, null, 'a request that never got an answer has no HTTP status to report')
  assert.match(err.message, /bridge send failed/)
  // The point of the AbortController: the call returns at the timeout rather
  // than hanging until fetch's own (far longer) default gives up.
  assert.ok(Date.now() - started < 5_000, 'the abort never fired — the request hung')
  // The request DID reach the bridge; it is the response that never came.
  assert.equal(bridge.sends().length, 1)
})
