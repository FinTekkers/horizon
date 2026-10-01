// HZ-141 success metric 4 ("a bridge failure does not change the item's state
// and is retried") and guardrail 2 ("never block, fail or delay a lifecycle
// transition because a notification failed").
//
// The failures are injected at the FETCH layer, not by stubbing sendWhatsApp:
// the metric says "the bridge returning 500", and a pre-thrown WaSendError would
// never enter waSend.js at all — the status parsing, the success:false check and
// the timeout would all be untested while the suite stayed green.
//
// The retry itself is asserted through gateNotifier's drain rather than in
// isolation, because "is retried" is a property of the two together: waSend
// throws, the drain decides when to try again.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-gatenotify-retry-')), 'test.db')
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'
process.env.WA_BRIDGE_URL = 'http://127.0.0.1:59999/'
process.env.WA_NOTIFY_MAX_ATTEMPTS = '3'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const notifier = await import('../src/gateNotifier.js')
const { sendWhatsApp, WaSendError, BOT_MARKER } = await import('../src/waSend.js')
const { WA_BRIDGE_URL, WA_NOTIFY_MAX_ATTEMPTS } = await import('../src/config.js')
const { gateStepIndexes } = await import('../../domain/js/lifecycle.js')

const GATE = gateStepIndexes()[0]

store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

// A fetch stub that records every call and answers from a queue of responses.
function stubFetch(responses) {
  const calls = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      const next = responses.length > 1 ? responses.shift() : responses[0]
      if (typeof next === 'function') return next(init)
      return next
    },
  }
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// A send bound to a stub fetch, shaped like the drain's `send` option so the
// real waSend.js sits between the drain and the stubbed transport.
const sendVia = (fetchImpl) => (recipient, body) => sendWhatsApp(recipient, body, { fetchImpl })

function seedAtGate(id) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(id, `Item ${id}`, 'High', GATE)
  notifier.sweepGates()
  return db.prepare('SELECT * FROM gate_notice WHERE item_id = ? ORDER BY id').all(id)
}

const noticeFor = (id) => db.prepare('SELECT * FROM gate_notice WHERE item_id = ? ORDER BY id').get(id)
const itemRow = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)

// ---- waSend.js's own failure taxonomy ----

test('a 500 from the bridge throws WaSendError carrying the status', async () => {
  const { fetchImpl } = stubFetch([new Response('upstream exploded', { status: 500 })])
  await assert.rejects(() => sendWhatsApp('jid', 'hi', { fetchImpl }), (err) => {
    assert.ok(err instanceof WaSendError)
    assert.equal(err.status, 500)
    assert.match(err.message, /returned 500/)
    return true
  })
})

test('a 200 with success:false is a refusal, not a success', async () => {
  const { fetchImpl } = stubFetch([json(200, { success: false, message: 'not paired' })])
  await assert.rejects(() => sendWhatsApp('jid', 'hi', { fetchImpl }), /refused the send: not paired/)
})

test('a network failure throws with status null', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed')
  }
  await assert.rejects(() => sendWhatsApp('jid', 'hi', { fetchImpl }), (err) => {
    assert.equal(err.status, null)
    assert.match(err.message, /bridge send failed/)
    return true
  })
})

test('a timeout aborts the request — the stub honours the AbortSignal', async () => {
  const fetchImpl = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
  await assert.rejects(() => sendWhatsApp('jid', 'hi', { fetchImpl, timeoutMs: 10 }), (err) => {
    assert.ok(err instanceof WaSendError)
    assert.equal(err.status, null)
    return true
  })
})

test('an unparseable 200 body counts as a success — surprising enough to pin', async () => {
  const { fetchImpl } = stubFetch([new Response('not json at all', { status: 200 })])
  await sendWhatsApp('jid', 'hi', { fetchImpl })
})

test('every request goes to WA_BRIDGE_URL + /api/send, marker-prefixed, and nowhere else (guardrail 4)', async () => {
  const stub = stubFetch([json(200, { success: true })])
  await sendWhatsApp('15550001111@s.whatsapp.net', 'body text', { fetchImpl: stub.fetchImpl })
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].url, `${WA_BRIDGE_URL}/api/send`)
  assert.ok(stub.calls[0].url.startsWith(WA_BRIDGE_URL))
  const payload = JSON.parse(stub.calls[0].init.body)
  assert.deepEqual(Object.keys(payload).sort(), ['message', 'recipient'])
  assert.equal(payload.recipient, '15550001111@s.whatsapp.net')
  assert.equal(payload.message, `${BOT_MARKER}body text`)
  // The marker appears exactly once in the wire payload.
  assert.equal(payload.message.split(BOT_MARKER).length - 1, 1)
})

test('WA_BRIDGE_URL has its trailing slash stripped, so the path never doubles up', () => {
  assert.equal(process.env.WA_BRIDGE_URL.endsWith('/'), true, 'the fixture must set a trailing slash for this to mean anything')
  assert.equal(WA_BRIDGE_URL, 'http://127.0.0.1:59999')
})

// ---- the drain's retry behaviour, and guardrail 2 ----

test('a 500 leaves the row pending with attempts=1 and the item state untouched', async () => {
  seedAtGate('T-500')
  const before = itemRow('T-500')
  const stub = stubFetch([new Response('boom', { status: 500 })])

  const result = await notifier.drainOutbox({ send: sendVia(stub.fetchImpl) })
  assert.deepEqual(result, { sent: 0, failed: 1 })

  const row = noticeFor('T-500')
  assert.equal(row.status, 'pending')
  assert.equal(row.attempts, 1)
  assert.match(row.last_error, /returned 500/)
  assert.equal(row.sent_at, null)
  // Guardrail 2: nothing about the item moved, and no event was written.
  assert.deepEqual(itemRow('T-500'), before)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = 'T-500'").get().n, 0)
})

test('the next drain SKIPS the row while its backoff is in the future', async () => {
  const stub = stubFetch([json(200, { success: true })])
  const result = await notifier.drainOutbox({ send: sendVia(stub.fetchImpl) })
  assert.deepEqual(result, { sent: 0, failed: 0 })
  assert.equal(stub.calls.length, 0, 'the backoff was ignored — the attempt budget would burn in one tick')
  assert.equal(noticeFor('T-500').attempts, 1)
})

test('once the backoff elapses a recovered bridge sends it, and the row settles as sent', async () => {
  db.prepare("UPDATE gate_notice SET next_attempt_at = datetime('now', '-1 second') WHERE item_id = 'T-500'").run()
  const stub = stubFetch([json(200, { success: true, message: 'sent' })])
  const result = await notifier.drainOutbox({ send: sendVia(stub.fetchImpl) })
  assert.deepEqual(result, { sent: 1, failed: 0 })

  const row = noticeFor('T-500')
  assert.equal(row.status, 'sent')
  assert.ok(row.sent_at)
  assert.equal(row.last_error, null)
  assert.equal(row.attempts, 1, 'a successful retry must not be counted as another failure')
  assert.equal(stub.calls.length, 1)
})

test('a lifecycle transition still succeeds while the bridge is down', async () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
    'T-LIVE',
    'Approved while the bridge is broken',
    'High',
    GATE,
  )
  notifier.sweepGates()
  const stub = stubFetch([new Response('down', { status: 503 })])
  await notifier.drainOutbox({ send: sendVia(stub.fetchImpl) })
  assert.equal(noticeFor('T-LIVE').status, 'pending')

  // The approval is the thing under test: it must come back ok with the cursor
  // advanced, with a notification sitting un-sent in the outbox the whole time.
  assert.deepEqual(store.approveGate('T-LIVE', GATE, ''), { ok: true, closed: false })
  assert.equal(itemRow('T-LIVE').cursor, GATE + 1)
  assert.equal(noticeFor('T-LIVE').status, 'pending')
})

test('attempts stop at WA_NOTIFY_MAX_ATTEMPTS: the row goes failed and is never POSTed again', async () => {
  seedAtGate('T-GIVEUP')
  const stub = stubFetch([new Response('still down', { status: 500 })])
  for (let i = 0; i < WA_NOTIFY_MAX_ATTEMPTS; i++) {
    db.prepare("UPDATE gate_notice SET next_attempt_at = datetime('now', '-1 second') WHERE item_id = 'T-GIVEUP'").run()
    await notifier.drainOutbox({ send: sendVia(stub.fetchImpl) })
  }
  const row = noticeFor('T-GIVEUP')
  assert.equal(row.attempts, WA_NOTIFY_MAX_ATTEMPTS)
  assert.equal(row.status, 'failed')
  const postsSoFar = stub.calls.length
  assert.equal(postsSoFar, WA_NOTIFY_MAX_ATTEMPTS)

  // Even with the clock forced forward and the bridge healthy again.
  db.prepare("UPDATE gate_notice SET next_attempt_at = datetime('now', '-1 hour') WHERE item_id = 'T-GIVEUP'").run()
  const healthy = stubFetch([json(200, { success: true })])
  await notifier.drainOutbox({ send: sendVia(healthy.fetchImpl) })
  assert.equal(healthy.calls.length, 0, 'a failed row was retried past the cap')
  assert.equal(noticeFor('T-GIVEUP').status, 'failed')
})

test('two overlapping drains on one pending row produce exactly one POST', async () => {
  seedAtGate('T-RACE')
  let inFlight = 0
  let maxInFlight = 0
  const posts = []
  const slowSend = async (recipient, body) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setImmediate(r))
    posts.push({ recipient, body })
    inFlight--
  }
  const [a, b] = await Promise.all([
    notifier.drainOutbox({ send: slowSend }),
    notifier.drainOutbox({ send: slowSend }),
  ])
  assert.equal(posts.length, 1, `the same pending row was sent ${posts.length} times`)
  assert.equal(maxInFlight, 1)
  // One drain did the work; the other saw the in-flight guard and did nothing.
  assert.equal(a.sent + b.sent, 1)
  assert.equal(noticeFor('T-RACE').status, 'sent')
})

test('a send that throws a non-WaSendError is still contained — the drain never throws', async () => {
  seedAtGate('T-ODD')
  const result = await notifier.drainOutbox({
    send: async () => {
      throw new Error('something completely unexpected')
    },
  })
  assert.deepEqual(result, { sent: 0, failed: 1 })
  assert.equal(noticeFor('T-ODD').status, 'pending')
  assert.match(noticeFor('T-ODD').last_error, /completely unexpected/)
})

// LAST in the file: it drops gate_notice to break the sweep, so nothing after
// it can queue anything.
//
// This is guardrail 2's hardest case and the reason tick() wraps sweepGates in
// try/catch. store.js's notify() is a bare synchronous `listeners.forEach`,
// called AFTER the cursor write has committed — so a throw inside the sweep
// would surface to the HTTP layer as a 500 on an approval that had already
// succeeded, i.e. a human told their approval failed when it did not. The real
// tick() is registered as the real listener here; no stub stands in for it.
test('a sweep that throws is logged and swallowed — approveGate still returns ok, with the cursor advanced', async () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
    'T-POISON',
    'Sweep cannot write',
    'High',
    GATE,
  )
  db.exec('DROP TABLE gate_notice') // any insert the sweep attempts now throws
  const logged = []
  const log = { error: (m) => logged.push(m), warn: (m) => logged.push(m), info: () => {} }

  // Positive control first: the sweep really is broken now.
  assert.throws(() => notifier.sweepGates())

  const unsubscribe = store.onChange(() => void notifier.tick(log))
  try {
    assert.deepEqual(store.approveGate('T-POISON', GATE, ''), { ok: true, closed: false })
  } finally {
    unsubscribe()
  }
  assert.equal(itemRow('T-POISON').cursor, GATE + 1, 'the transition must have completed regardless')

  // tick() is async, so let its swallowed rejection settle before asserting.
  await new Promise((r) => setImmediate(r))
  assert.ok(
    logged.some((m) => /sweep failed/.test(m)),
    `the sweep failure was never logged: ${JSON.stringify(logged)}`,
  )
})
