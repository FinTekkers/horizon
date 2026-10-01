// HZ-142 rollback tier 1: WA_POLL_ENABLED=0.
//
// This is the first lever anyone reaches for when the poll misbehaves — set
// it, restart horizon-server, no deploy. It is therefore worth a test rather
// than a line in a runbook. Three things have to hold:
//
//   1. no poll is attached to a new gate arrival;
//   2. the text notice is byte-identical to what it was before HZ-142, and
//      still sends;
//   3. POST /api/wa/poll-vote stays REGISTERED — a poll already on someone's
//      phone must still decide its gate after the flag goes off, or turning
//      the feature off would strand every poll already in flight.
//
// Its own process because config.js reads the environment once, at import.
// gate-notifier-poll.test.mjs is the enabled counterpart.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-gatepoll-off-')), 'test.db')
process.env.WA_NOTIFY_ENABLED = '1'
process.env.WA_POLL_ENABLED = '0'
process.env.WA_APPROVAL_SECRET = 'wa-approval-secret-for-tests'
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'
process.env.HORIZON_UI_URL = 'http://localhost:5173'
process.env.WA_BRIDGE_URL = 'http://127.0.0.1:9'
delete process.env.FARM_URL
delete process.env.HORIZON_REPO

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const notifier = await import('../src/gateNotifier.js')
const votes = await import('../src/waPollVotes.js')
const { buildApp } = await import('../src/app.js')
const { WA_NOTIFY_ENABLED, WA_POLL_ENABLED } = await import('../src/config.js')
const { POLL_APPROVE } = await import('../src/waSend.js')
const { STEPS, gateStepIndexes } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })

const GATE = gateStepIndexes()[0]
const DAVID = '15550001111@s.whatsapp.net'

test('setup: the notifier is on and only the poll is off', () => {
  assert.equal(WA_NOTIFY_ENABLED, true)
  assert.equal(WA_POLL_ENABLED, false)
})

test('a gate arrival queues its text notice and no poll at all', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('OFF-1', 'Poll disabled', 'High', ?)").run(GATE)
  const swept = notifier.sweepGates()

  assert.equal(swept.enqueued, 1)
  const notices = db.prepare("SELECT * FROM gate_notice WHERE item_id = 'OFF-1'").all()
  assert.equal(notices.length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gate_poll').get().n, 0, 'a poll was attached with the flag off')

  // The notice is unchanged, and still goes out.
  assert.match(notices[0].body, /^OFF-1 — Poll disabled$/m)
  assert.match(notices[0].body, /^Asking: \S.*\.$/m)
  assert.ok(notices[0].body.includes('http://localhost:5173/off-1'))
  const sent = []
  await notifier.drainOutbox({ send: async (r, b) => void sent.push(b) })
  assert.equal(sent.length, 1)
})

test('the poll drain is a no-op with nothing queued, and contacts nothing', async () => {
  let called = 0
  const out = await notifier.drainPolls({
    send: async () => {
      called++
      return 'X'
    },
  })
  assert.deepEqual(out, { sent: 0, failed: 0 })
  assert.equal(called, 0)
})

// The reason the route stays registered rather than being gated on the flag:
// turning polls off must not strand the ones already on a phone.
test('a poll sent before the flag went off still decides its gate', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('OFF-2', 'Poll in flight', 'High', ?)").run(GATE)
  // Exactly the rows the enabled sweep+drain left behind before the restart.
  const pollId = votes.registerPoll({
    itemId: 'OFF-2',
    stepIndex: GATE,
    recipient: DAVID,
    question: `OFF-2 — ${STEPS[GATE].label}`,
  })
  votes.attachPollMessageId(pollId, 'MSG-IN-FLIGHT')

  const res = await app.inject({
    method: 'POST',
    url: '/api/wa/poll-vote',
    headers: { 'x-wa-approval-secret': 'wa-approval-secret-for-tests' },
    payload: { voteId: 'OFF-VOTE-1', pollMessageId: 'MSG-IN-FLIGHT', voterJid: DAVID, selectedOption: POLL_APPROVE },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().outcome, 'applied')
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'OFF-2'").get().cursor, GATE + 1)
})

// The other half of the same rule: a fresh arrival still retires whatever is
// open, flag or no flag. Otherwise an in-flight poll from arrival #1 would sit
// there matching arrival #2's cursor and decide it.
test('a fresh arrival still supersedes an in-flight poll from the previous one', async () => {
  const gate = gateStepIndexes()[2]
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('OFF-3', 'Stale poll', 'High', ?)").run(gate)
  const pollId = votes.registerPoll({ itemId: 'OFF-3', stepIndex: gate, recipient: DAVID, question: 'OFF-3 — stale' })
  votes.attachPollMessageId(pollId, 'MSG-STALE')
  db.prepare("UPDATE work_item SET notified_step = ? WHERE id = 'OFF-3'").run(gate)

  // Leave the gate and come back — a genuinely fresh arrival.
  db.prepare("UPDATE work_item SET cursor = ? WHERE id = 'OFF-3'").run(STEPS.findIndex((s) => s.kind === 'agent'))
  notifier.sweepGates()
  db.prepare("UPDATE work_item SET cursor = ? WHERE id = 'OFF-3'").run(gate)
  notifier.sweepGates()

  assert.ok(db.prepare('SELECT superseded_at FROM gate_poll WHERE id = ?').get(pollId).superseded_at)
  const res = await app.inject({
    method: 'POST',
    url: '/api/wa/poll-vote',
    headers: { 'x-wa-approval-secret': 'wa-approval-secret-for-tests' },
    payload: { voteId: 'OFF-VOTE-2', pollMessageId: 'MSG-STALE', voterJid: DAVID, selectedOption: POLL_APPROVE },
  })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'ignored_superseded' })
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'OFF-3'").get().cursor, gate)
})
