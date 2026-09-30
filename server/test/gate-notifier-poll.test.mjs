// HZ-142 success metric 2: every gate notification carries a two-option poll.
//
// WA_NOTIFY_ENABLED is set here, which is what turns WA_POLL_ENABLED on — the
// two are coupled in config.js so that "notify nobody" means "poll nobody",
// and so that every pre-HZ-142 test driving sweepGates() with the notifier off
// still sees exactly the rows it saw before.
//
// The counterpart file is gate-notifier-poll-disabled.test.mjs, which pins
// rollback tier 1 (WA_POLL_ENABLED=0). Separate processes because config.js
// reads the environment once, at import.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-gatepoll-')), 'test.db')
process.env.WA_NOTIFY_ENABLED = '1'
delete process.env.WA_POLL_ENABLED
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net,15550002222@s.whatsapp.net'
process.env.HORIZON_UI_URL = 'http://localhost:5173'
process.env.WA_BRIDGE_URL = 'http://127.0.0.1:9' // discard: no real bridge
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const notifier = await import('../src/gateNotifier.js')
const { POLL_APPROVE, POLL_SEND_BACK, POLL_OPTIONS } = await import('../src/waSend.js')
const { WA_POLL_ENABLED } = await import('../src/config.js')
const { STEPS, gateStepIndexes } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

const GATES = gateStepIndexes()
const APPROVERS = ['15550001111@s.whatsapp.net', '15550002222@s.whatsapp.net']

const polls = (id) => db.prepare('SELECT * FROM gate_poll WHERE item_id = ? ORDER BY id').all(id)
const notices = (id) => db.prepare('SELECT * FROM gate_notice WHERE item_id = ? ORDER BY id').all(id)
const setCursor = (id, cursor) => db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(cursor, id)

function makeItem(id, cursor) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(id, `Poll ${id}`, 'High', cursor)
  return id
}

// Collects every (recipient, question) the poll drain hands to the transport,
// and answers with a poll message id the way the forked bridge does.
function pollRecorder() {
  const sent = []
  let n = 0
  return {
    sent,
    send: async (recipient, question) => {
      sent.push({ recipient, question })
      return `3EB0POLL${++n}`
    },
  }
}

test('setup: the poll is on because the notifier is on', () => {
  assert.equal(WA_POLL_ENABLED, true)
})

// ---- metric 2 ----

test('each gate arrival queues one poll per approver, alongside the text notice', () => {
  const id = makeItem('G-ONE', GATES[0])
  const swept = notifier.sweepGates()

  assert.equal(notices(id).length, APPROVERS.length, 'the text notices changed')
  assert.equal(polls(id).length, APPROVERS.length, 'one poll per approver was not queued')
  assert.deepEqual(polls(id).map((p) => p.recipient).sort(), [...APPROVERS].sort())
  assert.ok(polls(id).every((p) => p.step_index === GATES[0] && p.status === 'pending' && p.attempts === 0))

  // sweepGates' own return shape is unchanged: `enqueued` still counts text
  // notices, one per (arrival, approver). Four existing test files assert on
  // it, and polls living in their own outbox is what keeps that true.
  assert.deepEqual(Object.keys(swept).sort(), ['cleared', 'enqueued', 'failed'])
  assert.equal(swept.enqueued, APPROVERS.length)
})

test('all five gates carry a poll', () => {
  const id = makeItem('G-FIVE', 0)
  for (const gate of GATES) {
    setCursor(id, gate - 1)
    notifier.sweepGates()
    setCursor(id, gate)
    notifier.sweepGates()
  }
  const steps = [...new Set(polls(id).map((p) => p.step_index))].sort((a, b) => a - b)
  assert.deepEqual(steps, GATES, 'some gate produced no poll')
})

test('the poll question names the item and the gate, and carries no marker', async () => {
  const { BOT_MARKER } = await import('../src/waSend.js')
  const question = notifier.renderPollQuestion({ id: 'HZ-142', title: 'x', cursor: GATES[2] })
  assert.equal(question, `HZ-142 — ${STEPS[GATES[2]].label}`)
  // The marker is prepended by sendPoll, exactly once — the same division of
  // labour renderNotice has with sendWhatsApp.
  assert.ok(!question.includes(BOT_MARKER))
})

test('renderPollQuestion throws on a non-gate step, with no vague fallback', () => {
  const agentStep = STEPS.findIndex((s) => s.kind === 'agent')
  assert.throws(() => notifier.renderPollQuestion({ id: 'HZ-1', cursor: agentStep }), /no ask line/)
})

test('a very long item id is truncated to WhatsApp’s poll-name cap, not dropped', () => {
  const question = notifier.renderPollQuestion({ id: 'X'.repeat(400), cursor: GATES[0] })
  assert.ok(question.length <= 255, `poll name is ${question.length} chars`)
  assert.ok(question.endsWith('…'))
})

// ---- the option strings, byte for byte on this side of the boundary ----

test('the two options are exactly the bytes infra/whatsapp-bridge sends', () => {
  assert.deepEqual(POLL_OPTIONS, [POLL_APPROVE, POLL_SEND_BACK])
  assert.equal(Buffer.from(POLL_APPROVE, 'utf8').toString('hex'), 'e29c8520417070726f7665')
  assert.equal(Buffer.from(POLL_SEND_BACK, 'utf8').toString('hex'), 'e286a9efb88f2053656e64206261636b')
})

test('the wire payload carries both options, the marker-prefixed question, and no credential', async () => {
  const { sendPoll } = await import('../src/waSend.js')
  const { BOT_MARKER } = await import('../src/waSend.js')
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) }
    return { status: 200, json: async () => ({ success: true, messageId: '3EB0X' }), text: async () => '' }
  }
  const id = await sendPoll('15550001111@s.whatsapp.net', 'HZ-142 — Review before execution', { fetchImpl })
  assert.equal(id, '3EB0X')
  assert.match(seen.url, /\/api\/send-poll$/)
  assert.deepEqual(Object.keys(seen.body).sort(), ['name', 'options', 'recipient'])
  assert.deepEqual(seen.body.options, [POLL_APPROVE, POLL_SEND_BACK])
  assert.equal(seen.body.name, `${BOT_MARKER}HZ-142 — Review before execution`)
  assert.equal(seen.body.name.split(BOT_MARKER).length - 1, 1, 'the marker appears twice')
  assert.ok(!/secret|token|authorization/i.test(init_raw(seen)), 'a credential rode along on a loopback-only endpoint')
})

function init_raw(seen) {
  return JSON.stringify({ headers: seen.init.headers, body: seen.body })
}

// ---- the drain ----

test('the drain sends each poll once and records its message id', async () => {
  const id = makeItem('G-DRAIN', GATES[1])
  notifier.sweepGates()
  const box = pollRecorder()
  const first = await notifier.drainPolls({ send: box.send })

  assert.equal(first.sent, box.sent.length)
  assert.ok(box.sent.length >= APPROVERS.length)
  const rows = polls(id)
  assert.ok(rows.every((r) => r.status === 'sent' && r.sent_at && r.last_error === null))
  assert.ok(rows.every((r) => /^3EB0POLL\d+$/.test(r.poll_msg_id)), 'a poll was sent with no id recorded — a tappable orphan')
  assert.deepEqual(
    box.sent.filter((s) => s.question.includes('G-DRAIN')).map((s) => s.recipient).sort(),
    [...APPROVERS].sort(),
  )

  // A re-drain sends nothing.
  const before = box.sent.length
  await notifier.drainPolls({ send: box.send })
  assert.equal(box.sent.length, before, 'an already-sent poll was sent again')
})

test('a poll the bridge refuses is retried with backoff and does not take the text notice down', async () => {
  const id = makeItem('G-FAIL', GATES[3])
  notifier.sweepGates()
  const failing = async () => {
    throw new Error('bridge poll send returned 404: no such route')
  }
  const out = await notifier.drainPolls({ send: failing })
  assert.equal(out.sent, 0)
  assert.ok(out.failed >= APPROVERS.length)
  for (const row of polls(id)) {
    assert.equal(row.status, 'pending', 'a first failure must retry, not give up')
    assert.equal(row.attempts, 1)
    assert.match(row.last_error, /404/)
    assert.ok(row.next_attempt_at > row.created_at, 'no backoff was applied')
  }
  // The whole point of a separate outbox: the text notice still goes out, so
  // the concierge's free-text approval still works on an un-forked bridge.
  const box = []
  await notifier.drainOutbox({ send: async (r, b) => void box.push(b) })
  assert.ok(box.some((b) => b.includes('G-FAIL')), 'a poll failure suppressed the text notification')
  assert.ok(notices(id).every((n) => n.status === 'sent'))
})

test('a poll left mid-send by a crash is failed at boot, never resent', () => {
  const id = makeItem('G-CRASH', GATES[4])
  notifier.sweepGates()
  db.prepare("UPDATE gate_poll SET status = 'sending' WHERE item_id = ?").run(id)
  assert.ok(notifier.failInterruptedPolls() >= APPROVERS.length)
  for (const row of polls(id)) {
    assert.equal(row.status, 'failed')
    assert.match(row.last_error, /interrupted/)
  }
})

// ---- re-arrival ----

test('a re-arrival at the same gate queues a fresh poll and supersedes the old one', () => {
  const gate = GATES[2]
  const id = makeItem('G-AGAIN', gate)
  notifier.sweepGates()
  const first = polls(id).map((p) => p.id)

  // Leave the gate, which clears notified_step, then come back.
  const agentStep = STEPS.findIndex((s) => s.kind === 'agent')
  setCursor(id, agentStep)
  notifier.sweepGates()
  setCursor(id, gate)
  notifier.sweepGates()

  const all = polls(id)
  assert.equal(all.length, first.length * 2, 're-arrival did not queue a fresh poll')
  for (const row of all) {
    const superseded = first.includes(row.id)
    assert.equal(
      Boolean(row.superseded_at),
      superseded,
      `poll ${row.id} superseded=${Boolean(row.superseded_at)}, expected ${superseded}`,
    )
  }
})

// ---- the sweep's own failure containment, extended to polls ----

test('an item whose poll cannot be rendered fails alone, and queues no notice either', () => {
  const gate = GATES[0]
  for (const id of ['G-POISON', 'G-NEIGHBOUR']) makeItem(id, gate)
  const logged = []
  const renderPoll = (item) => {
    if (item.id === 'G-POISON') throw new Error('poll render exploded')
    return notifier.renderPollQuestion(item)
  }
  const swept = notifier.sweepGates({ log: { error: (m) => logged.push(m) }, renderPoll })

  assert.equal(swept.failed, 1)
  assert.equal(polls('G-POISON').length, 0)
  assert.equal(notices('G-POISON').length, 0, 'the notice committed and then the poll threw')
  assert.equal(polls('G-NEIGHBOUR').length, APPROVERS.length, 'the neighbour was collateral damage')
  assert.ok(logged.some((m) => m.includes('G-POISON')))
})

// ---- sendPoll's failure taxonomy, driven through the real fetch layer ----
//
// Injected at the FETCH layer rather than by stubbing sendPoll, for the same
// reason gate-notifier-retry.test.mjs does it: a pre-thrown WaSendError would
// never enter waSend.js, so the status parsing and the messageId check would
// be untested while the suite stayed green.

test('every bridge failure mode throws WaSendError rather than reporting success', async () => {
  const { sendPoll, WaSendError } = await import('../src/waSend.js')
  const cases = {
    '404 from an un-forked bridge': { status: 404, json: async () => ({}), text: async () => 'no such route' },
    'a refusal': { status: 200, json: async () => ({ success: false, message: 'Not connected to WhatsApp' }), text: async () => '' },
    // The worst outcome available: the poll IS on the human's phone and no
    // row records its id, so the tap resolves to nothing at all.
    '200 with no messageId': { status: 200, json: async () => ({ success: true }), text: async () => '' },
    'an empty messageId': { status: 200, json: async () => ({ success: true, messageId: '   ' }), text: async () => '' },
    'an unparseable body': {
      status: 200,
      json: async () => {
        throw new Error('not json')
      },
      text: async () => '',
    },
  }
  for (const [name, response] of Object.entries(cases)) {
    await assert.rejects(
      () => sendPoll('15550001111@s.whatsapp.net', 'q', { fetchImpl: async () => response }),
      WaSendError,
      name,
    )
  }
  // A network failure, and the abort the timeout raises.
  await assert.rejects(
    () =>
      sendPoll('r', 'q', {
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED')
        },
      }),
    /bridge poll send failed/,
  )
  await assert.rejects(
    () => sendPoll('r', 'q', { fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))), timeoutMs: 20 }),
    /bridge poll send failed/,
  )
})

test('a 200 with no messageId puts the row back on the retry path, and a later good reply records the id', async () => {
  const { sendPoll } = await import('../src/waSend.js')
  const id = makeItem('G-NOID', GATES[0])
  notifier.sweepGates()

  const orphaning = async () => ({ status: 200, json: async () => ({ success: true }), text: async () => '' })
  const send = (recipient, question) => sendPoll(recipient, question, { fetchImpl: orphaning })
  const out = await notifier.drainPolls({ send })
  assert.equal(out.sent, 0)
  for (const row of polls(id)) {
    assert.equal(row.status, 'pending', 'a tappable orphan was recorded as sent')
    assert.equal(row.poll_msg_id, null)
    assert.match(row.last_error, /messageId/)
  }

  // The bridge recovers. The retry is due immediately only if the backoff has
  // elapsed, so the row is nudged the way the backstop timer eventually would.
  db.prepare("UPDATE gate_poll SET next_attempt_at = datetime('now','-1 hour') WHERE item_id = ?").run(id)
  // A DISTINCT id per poll, because poll_msg_id is uniquely indexed — a
  // bridge that returned the same id twice would fail the second row and
  // retry it, which is the right behaviour and not what this case is about.
  let n = 0
  const good = async () => ({
    status: 200,
    json: async () => ({ success: true, messageId: `3EB0RECOVERED${++n}` }),
    text: async () => '',
  })
  await notifier.drainPolls({ send: (r, q) => sendPoll(r, q, { fetchImpl: good }) })
  for (const row of polls(id)) {
    assert.equal(row.status, 'sent')
    assert.match(row.poll_msg_id, /^3EB0RECOVERED\d$/)
  }
})

test('a poll gives up after the attempt cap rather than retrying a dead endpoint forever', async () => {
  const { WA_NOTIFY_MAX_ATTEMPTS } = await import('../src/config.js')
  const id = makeItem('G-GIVEUP', GATES[1])
  notifier.sweepGates()
  const failing = async () => {
    throw new Error('bridge poll send returned 500: wedged')
  }
  for (let i = 0; i < WA_NOTIFY_MAX_ATTEMPTS; i++) {
    db.prepare("UPDATE gate_poll SET next_attempt_at = datetime('now','-1 hour') WHERE item_id = ?").run(id)
    await notifier.drainPolls({ send: failing })
  }
  for (const row of polls(id)) {
    assert.equal(row.status, 'failed')
    assert.equal(row.attempts, WA_NOTIFY_MAX_ATTEMPTS)
  }
  // 'failed' is terminal: a later drain must not pick it back up.
  db.prepare("UPDATE gate_poll SET next_attempt_at = datetime('now','-1 hour') WHERE item_id = ?").run(id)
  assert.deepEqual(await notifier.drainPolls({ send: failing }), { sent: 0, failed: 0 })
})

test('two overlapping poll drains send each row once', async () => {
  const id = makeItem('G-RACE', GATES[2])
  notifier.sweepGates()
  const posts = []
  const slow = async (recipient, question) => {
    // Keyed by recipient too: the two rows of one arrival carry the SAME
    // question, so a question-only key would hide a double send.
    posts.push(`${recipient}|${question}`)
    await new Promise((r) => setTimeout(r, 20))
    return `3EB0RACE${posts.length}`
  }
  const [a, b] = await Promise.all([notifier.drainPolls({ send: slow }), notifier.drainPolls({ send: slow })])
  const mine = posts.filter((q) => q.includes('G-RACE'))
  assert.equal(mine.length, polls(id).length, `${polls(id).length} row(s) produced ${mine.length} send(s)`)
  assert.equal(new Set(mine).size, mine.length, 'a row was sent twice by two overlapping drains')
  assert.equal(a.sent + b.sent, posts.length)
  assert.ok(polls(id).every((r) => r.status === 'sent'))
})

test('no agent runner call happens during a poll sweep or a poll drain', async () => {
  const calls = []
  store.registerAgentRunner({ kick: (...a) => calls.push(a), cancel: (...a) => calls.push(a) })
  makeItem('G-NOAGENT', GATES[1])
  notifier.sweepGates()
  await notifier.drainPolls({ send: pollRecorder().send })
  assert.deepEqual(calls, [], 'the poll path reached the agent runner')
})
