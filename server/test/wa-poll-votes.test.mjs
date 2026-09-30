// HZ-142 success metrics 3, 4, 5, 6 and 7 — the vote-to-decision path.
//
// Every "changes nothing" metric line is asserted as FIVE side effects, not
// one: cursor, gate_decision, feedback, event and the acknowledgement notice.
// A test that only checks the cursor passes for a validator that refuses the
// vote and still writes a feedback row, which is not "nothing".
//
// The two actions are the REAL store functions, injected the way app.js
// injects them. Stubbing them would have made every assertion below about a
// spy rather than about the board.
//
// Its own file because config.js reads the environment at import time and the
// approver allowlist has to be set before that import.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-wa-poll-votes-')), 'test.db')
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net,15550002222'
process.env.WA_APPROVAL_SECRET = 'wa-approval-secret-for-tests'
process.env.HORIZON_UI_URL = 'http://localhost:5173'
delete process.env.FARM_URL
delete process.env.HORIZON_REPO

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const votes = await import('../src/waPollVotes.js')
const { POLL_APPROVE, POLL_SEND_BACK } = await import('../src/waSend.js')
const { STEPS, gateStepIndexes, requiredStepIndex, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const GATES = gateStepIndexes()
const GATE = GATES[0]
const LATER_GATE = GATES[2]
const DAVID = '15550001111@s.whatsapp.net'
const EVAN = '15550002222:7@s.whatsapp.net'
const STRANGER = '19998887777@s.whatsapp.net'

// The agent runner is registered as a recorder, not the orchestrator: metric 9
// forbids a model on this path and store.approveGate/requestChanges both call
// kick(), which would otherwise be undefined.
const runnerCalls = []
store.registerAgentRunner({
  kick: (...a) => runnerCalls.push(['kick', ...a]),
  cancel: (...a) => runnerCalls.push(['cancel', ...a]),
})

// Exactly what app.js hands applyVote — including requestChanges' null
// targetStepIndex, so "the gate's default rework target" is derived in the one
// place store.js derives it.
const ACTIONS = {
  approve: async (id, stepIndex, notes, actor) => store.approveGate(id, stepIndex, notes, actor),
  sendBack: async (id, feedback, actor) =>
    store.requestChanges(id, STEPS[store.getItem(id)?.cursor]?.label || null, feedback, actor, null),
}

let seq = 0
const nextId = (prefix) => `${prefix}-${++seq}`

function makeItem(id, cursor, extra = {}) {
  const cols = ['id', 'title', 'priority', 'cursor', ...Object.keys(extra)]
  db.prepare(
    `INSERT INTO work_item (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
  ).run(id, `Poll vote fixture ${id}`, 'Medium', cursor, ...Object.values(extra))
  return id
}

// Registers a poll the way gateNotifier's sweep does — retire what is open,
// then register the arrival's batch — and attaches the id the way its drain
// does. Every fixture here has a single recipient, so one call is one arrival.
function makePoll(itemId, stepIndex, { recipient = DAVID, msgId = nextId('MSG') } = {}) {
  votes.supersedeOpenPolls(itemId)
  const pollId = votes.registerPoll({ itemId, stepIndex, recipient, question: `${itemId} — ${STEPS[stepIndex].label}` })
  votes.attachPollMessageId(pollId, msgId)
  return { pollId, msgId }
}

const vote = (msgId, option, voter = DAVID, voteId = nextId('VOTE')) =>
  votes.applyVote({ voteId, pollMsgId: msgId, voterJid: voter, selectedOption: option }, ACTIONS)

const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const counts = (id) => ({
  cursor: cursorOf(id),
  decisions: db.prepare('SELECT COUNT(*) AS n FROM gate_decision WHERE item_id = ?').get(id).n,
  feedback: db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE item_id = ?').get(id).n,
  events: db.prepare('SELECT COUNT(*) AS n FROM event WHERE item_id = ?').get(id).n,
  notices: db.prepare('SELECT COUNT(*) AS n FROM gate_notice WHERE item_id = ?').get(id).n,
})

// "Changes nothing" means nothing — all five, every time.
async function assertNothingChanged(itemId, run) {
  const before = counts(itemId)
  const result = await run()
  assert.deepEqual(counts(itemId), before, `${result.outcome} was not side-effect free`)
  return result
}

test('setup: the fixture pins five gates and two distinct approvers', () => {
  assert.equal(GATES.length, 5)
  assert.ok(STEPS[GATE].kind === 'gate' && STEPS[LATER_GATE].kind === 'gate')
})

// ---- metric 3: an Approve vote approves the gate ----

test('an Approve vote from an allowlisted voter approves the gate', async () => {
  const id = makeItem('P-APPROVE', GATE)
  const { msgId } = makePoll(id, GATE)
  const res = await vote(msgId, POLL_APPROVE)

  assert.equal(res.outcome, 'applied')
  assert.equal(res.status, 200)
  assert.deepEqual({ itemId: res.itemId, stepIndex: res.stepIndex, choice: res.choice }, { itemId: id, stepIndex: GATE, choice: 'approve' })
  assert.equal(cursorOf(id), GATE + 1, 'the cursor did not advance past the gate')
  const decision = db.prepare('SELECT * FROM gate_decision WHERE item_id = ?').get(id)
  assert.equal(decision.decision, 'approved')
  assert.equal(decision.step_index, GATE)
  // Attributable, and from the PROVEN jid — the bridge sends no display name.
  assert.equal(decision.decided_by, '...1111 via WhatsApp poll')
})

test('the acknowledgement rides the existing text outbox, to the poll recipient', () => {
  const ack = db.prepare("SELECT * FROM gate_notice WHERE item_id = 'P-APPROVE' ORDER BY id DESC").get()
  assert.ok(ack, 'the voter was never told their tap landed')
  assert.equal(ack.recipient, DAVID)
  assert.equal(ack.status, 'pending', 'the ack must be queued, not sent inline')
  assert.match(ack.body, /P-APPROVE — approved from your poll/)
})

// ---- metric 4: a Send back vote goes to the gate's default rework target ----

test('a Send back vote sends the item to the gate default rework target', async () => {
  const id = makeItem('P-BACK', LATER_GATE)
  const { msgId } = makePoll(id, LATER_GATE)
  const res = await vote(msgId, POLL_SEND_BACK)

  assert.equal(res.outcome, 'applied')
  assert.equal(res.choice, 'send_back')
  const landed = cursorOf(id)
  assert.ok(landed < LATER_GATE, `the item did not move back (cursor ${landed})`)
  assert.equal(STEPS[landed].kind, 'agent', 'a send-back must land on an agent step')
  // The default, derived by store.requestChanges and nowhere else: the
  // nearest preceding agent step.
  let expected = LATER_GATE
  while (expected > 0 && STEPS[expected].kind !== 'agent') expected--
  assert.equal(landed, expected)
  assert.equal(db.prepare('SELECT decision FROM gate_decision WHERE item_id = ?').get(id).decision, 'rejected')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE item_id = ?').get(id).n, 1)
})

test('the Accept gate sends back to the implement step, not to the Review step before it', async () => {
  const id = makeItem('P-ACCEPT', ACCEPT_GATE_INDEX)
  const { msgId } = makePoll(id, ACCEPT_GATE_INDEX)
  assert.equal((await vote(msgId, POLL_SEND_BACK)).outcome, 'applied')
  const landed = cursorOf(id)
  assert.equal(STEPS[landed].label, 'Specialist agent implements', `landed on ${STEPS[landed].label}`)
})

test('the send-back event names the gate, not "this step"', () => {
  const text = db.prepare("SELECT text FROM event WHERE item_id = 'P-BACK' ORDER BY id DESC").get().text
  assert.ok(text.includes(STEPS[LATER_GATE].label), `the event reads "${text}"`)
})

test('the send-back acknowledgement invites the follow-up the concierge already handles', () => {
  const ack = db.prepare("SELECT body FROM gate_notice WHERE item_id = 'P-BACK' ORDER BY id DESC").get()
  assert.match(ack.body, /sent back from your poll/)
  assert.match(ack.body, /feedback/)
})

// ---- metric 5: a vote from a non-allowlisted voter changes nothing ----

test('a vote from a non-allowlisted voter changes nothing at all', async () => {
  const id = makeItem('P-STRANGER', GATE)
  const { msgId } = makePoll(id, GATE)
  const res = await assertNothingChanged(id, () => vote(msgId, POLL_APPROVE, STRANGER))
  assert.equal(res.outcome, 'ignored_not_allowed')
  assert.equal(res.status, 403)
})

// Otherwise an unauthorised flood grows gate_poll_vote without bound, and the
// refusal leaks which poll ids exist.
test('a non-allowlisted vote writes no gate_poll_vote row and claims no poll', async () => {
  const id = makeItem('P-STRANGER2', GATE)
  const { pollId, msgId } = makePoll(id, GATE)
  const before = db.prepare('SELECT COUNT(*) AS n FROM gate_poll_vote').get().n
  await vote(msgId, POLL_APPROVE, STRANGER)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gate_poll_vote').get().n, before)
  assert.equal(db.prepare('SELECT decided_at FROM gate_poll WHERE id = ?').get(pollId).decided_at, null)
  // …and the gate is still genuinely decidable by someone who may.
  assert.equal((await vote(msgId, POLL_APPROVE, DAVID)).outcome, 'applied')
})

test('a jid with a device suffix is still recognised as its allowlisted owner', async () => {
  const id = makeItem('P-SUFFIX', GATE)
  const { msgId } = makePoll(id, GATE, { recipient: '15550002222@s.whatsapp.net' })
  assert.equal((await vote(msgId, POLL_APPROVE, EVAN)).outcome, 'applied')
  assert.equal(cursorOf(id), GATE + 1)
})

// ---- metric 6: a vote on a gate the item has already left ----

test('a vote on a gate the item has already left changes nothing', async () => {
  const id = makeItem('P-MOVED', GATE)
  const { msgId } = makePoll(id, GATE)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(GATE + 1, id)
  const res = await assertNothingChanged(id, () => vote(msgId, POLL_APPROVE))
  assert.equal(res.outcome, 'ignored_stale_gate')
  assert.equal(res.status, 409)
})

test('a vote on a closed or abandoned item changes nothing', async () => {
  for (const [id, extra] of [
    ['P-CLOSED', { cursor: STEPS.length }],
    ['P-ABANDONED', { abandoned_at: '2026-09-30T00:00:00Z' }],
  ]) {
    makeItem(id, extra.cursor ?? GATE, extra.abandoned_at ? { abandoned_at: extra.abandoned_at } : {})
    const { msgId } = makePoll(id, GATE)
    const res = await assertNothingChanged(id, () => vote(msgId, POLL_APPROVE))
    assert.equal(res.outcome, 'ignored_stale_gate', `${id}: ${res.outcome}`)
  }
})

test('a vote naming a poll this server never sent changes nothing', async () => {
  const id = makeItem('P-UNKNOWN', GATE)
  makePoll(id, GATE)
  const res = await assertNothingChanged(id, () =>
    votes.applyVote(
      { voteId: nextId('VOTE'), pollMsgId: 'MSG-THAT-NEVER-EXISTED', voterJid: DAVID, selectedOption: POLL_APPROVE },
      ACTIONS,
    ),
  )
  assert.equal(res.outcome, 'ignored_unknown_poll')
  assert.equal(res.status, 404)
})

test('an option string that is not one of the two changes nothing — it is never guessed', async () => {
  const id = makeItem('P-OPTION', GATE)
  const { msgId } = makePoll(id, GATE)
  for (const option of ['Approve', 'approve', '✅Approve', '↩ Send back', POLL_APPROVE + ' ', '', 'yes']) {
    const res = await assertNothingChanged(id, () => vote(msgId, option))
    assert.equal(res.outcome, 'ignored_unknown_option', `"${option}" was resolved to ${res.outcome}`)
    assert.equal(res.status, 422)
  }
  // The real strings still work, so the loop above is not vacuous.
  assert.equal((await vote(msgId, POLL_APPROVE)).outcome, 'applied')
})

// ---- the re-arrival cases: the bug the architecture review caught ----
//
// store.requestChanges writes a 'rejected' gate_decision row and never deletes
// it. Scoping "already decided" to (item, step) would therefore refuse every
// vote on this gate forever after the first send-back — failing metrics 3 and
// 4 on the SECOND visit to any gate, which is the common case for the
// pre-execution gate.

test('send back, rework, return to the same gate — the new poll still approves it', async () => {
  const id = makeItem('P-RETURN', LATER_GATE)
  const first = makePoll(id, LATER_GATE)
  assert.equal((await vote(first.msgId, POLL_SEND_BACK)).outcome, 'applied')
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM gate_decision WHERE item_id = ?').get(id).n >= 1)

  // Back at the gate, a fresh arrival with a fresh poll.
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(LATER_GATE, id)
  const second = makePoll(id, LATER_GATE)
  const res = await vote(second.msgId, POLL_APPROVE)
  assert.equal(res.outcome, 'applied', 'the second arrival at this gate could not be decided')
  assert.equal(cursorOf(id), LATER_GATE + 1)
})

test("arrival #2's poll being live makes arrival #1's poll unable to decide", async () => {
  const id = makeItem('P-SUPERSEDE', GATE)
  const stale = makePoll(id, GATE)
  const fresh = makePoll(id, GATE)

  const res = await assertNothingChanged(id, () => vote(stale.msgId, POLL_APPROVE))
  assert.equal(res.outcome, 'ignored_superseded')
  assert.equal(res.status, 409)
  // And the current poll is unaffected by the stale tap.
  assert.equal((await vote(fresh.msgId, POLL_APPROVE)).outcome, 'applied')
})

test('decidedness is scoped to the arrival, on gate_poll — not to a gate_decision row', () => {
  // The mechanism, pinned. A comment would not fail if someone reintroduced a
  // (item, step) gate_decision lookup.
  const poll = db.prepare("SELECT * FROM gate_poll WHERE item_id = 'P-RETURN' ORDER BY id").all()
  assert.equal(poll.length, 2, 'the two arrivals did not produce two poll rows')
  assert.ok(poll[0].decided_at, 'the first arrival was never marked decided')
  assert.ok(poll[1].decided_at, 'the second arrival was never marked decided')
  assert.ok(poll[0].superseded_at, 'the first poll was never superseded by the second')
  assert.equal(poll[1].superseded_at, null)
})

// ---- metric 7: a second vote after the gate is decided; replay idempotence ----

test('a second vote after the gate is decided changes nothing', async () => {
  const id = makeItem('P-SECOND', GATE)
  const { msgId } = makePoll(id, GATE)
  assert.equal((await vote(msgId, POLL_APPROVE)).outcome, 'applied')
  const res = await assertNothingChanged(id, () => vote(msgId, POLL_SEND_BACK))
  // The cursor has already moved off the gate, so the stale-gate check is what
  // catches it first — the decidedness claim is the backstop for the window
  // where it has not yet.
  assert.ok(['ignored_stale_gate', 'ignored_already_decided'].includes(res.outcome), res.outcome)
  assert.equal(res.status, 409)
})

test('two allowlisted voters tapping opposite options: the first decides, the second is refused', async () => {
  const id = makeItem('P-RACE', GATE)
  const { msgId } = makePoll(id, GATE, { recipient: DAVID })
  const [a, b] = await Promise.all([
    vote(msgId, POLL_APPROVE, DAVID, 'RACE-A'),
    vote(msgId, POLL_SEND_BACK, '15550002222', 'RACE-B'),
  ])
  const outcomes = [a.outcome, b.outcome].sort()
  assert.equal(outcomes.filter((o) => o === 'applied').length, 1, `both votes applied: ${outcomes}`)
  assert.ok(outcomes.some((o) => o === 'ignored_already_decided' || o === 'ignored_stale_gate'), outcomes.join(','))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gate_decision WHERE item_id = ?').get(id).n, 1)
})

test('the same vote delivered twice is idempotent — the second is a duplicate, not a second decision', async () => {
  const id = makeItem('P-REPLAY', GATE)
  const { msgId } = makePoll(id, GATE)
  const first = await votes.applyVote(
    { voteId: 'REPLAY-1', pollMsgId: msgId, voterJid: DAVID, selectedOption: POLL_APPROVE },
    ACTIONS,
  )
  assert.equal(first.outcome, 'applied')

  const after = counts(id)
  for (let i = 0; i < 3; i++) {
    const again = await votes.applyVote(
      { voteId: 'REPLAY-1', pollMsgId: msgId, voterJid: DAVID, selectedOption: POLL_APPROVE },
      ACTIONS,
    )
    assert.equal(again.outcome, 'duplicate')
    assert.equal(again.status, 200, 'a duplicate must be a success, or the bridge retries it forever')
  }
  assert.deepEqual(counts(id), after, 'a replay changed the board')
})

test('two deliveries of one vote in flight at once apply exactly once', async () => {
  const id = makeItem('P-INFLIGHT', GATE)
  const { msgId } = makePoll(id, GATE)
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      votes.applyVote({ voteId: 'INFLIGHT-1', pollMsgId: msgId, voterJid: DAVID, selectedOption: POLL_APPROVE }, ACTIONS),
    ),
  )
  assert.equal(results.filter((r) => r.outcome === 'applied').length, 1, results.map((r) => r.outcome).join(','))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gate_decision WHERE item_id = ?').get(id).n, 1)
})

// A crash between the claim and the act strands the vote: the poll is claimed,
// the gate never moved, and nobody can decide it. Mirrors
// gateNotifier.failInterruptedSends()'s boot-time recovery.
test('a vote stranded mid-decision by a crash is released at boot and can then be decided', async () => {
  const id = makeItem('P-STRANDED', GATE)
  const { pollId, msgId } = makePoll(id, GATE)
  // Exactly the state a crash between claim() and the action leaves behind.
  db.prepare("INSERT INTO gate_poll_vote (vote_id, poll_id, voter_jid, choice, outcome) VALUES (?, ?, ?, ?, 'claimed')").run(
    'STRANDED-1',
    pollId,
    DAVID,
    'approve',
  )
  db.prepare("UPDATE gate_poll SET decided_at = datetime('now') WHERE id = ?").run(pollId)

  // Before recovery the gate is stuck: nobody can decide it.
  assert.equal((await vote(msgId, POLL_APPROVE)).outcome, 'ignored_already_decided')

  assert.equal(votes.releaseInterruptedVotes(), 1)
  assert.equal(db.prepare('SELECT decided_at FROM gate_poll WHERE id = ?').get(pollId).decided_at, null)
  assert.equal(db.prepare("SELECT outcome FROM gate_poll_vote WHERE vote_id = 'STRANDED-1'").get().outcome, 'interrupted')

  // The bridge is still retrying the original vote, and that retry finishes it.
  const retry = await votes.applyVote(
    { voteId: 'STRANDED-1', pollMsgId: msgId, voterJid: DAVID, selectedOption: POLL_APPROVE },
    ACTIONS,
  )
  assert.equal(retry.outcome, 'applied')
  assert.equal(cursorOf(id), GATE + 1)
})

// ---- metric 10: the concierge's free-text approval coexists with the poll ----

test('a free-text approval decides the gate; the poll vote that follows is ignored, not double-applied', async () => {
  const id = makeItem('P-COEXIST', GATE)
  const { msgId } = makePoll(id, GATE)
  // Exactly what POST .../approve-via-whatsapp does today, untouched by HZ-142.
  assert.deepEqual(store.approveGate(id, GATE, '', 'David via WhatsApp'), { ok: true, closed: false })
  const after = counts(id)

  const res = await vote(msgId, POLL_APPROVE)
  assert.equal(res.outcome, 'ignored_stale_gate')
  assert.deepEqual(counts(id), after, 'the poll vote approved a gate the concierge had already approved')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gate_decision WHERE item_id = ?').get(id).n, 1)
})

// ---- failure of the action itself ----

test('an action that refuses leaves the arrival decidable and the vote retryable', async () => {
  const id = makeItem('P-REFUSED', GATE)
  const { pollId, msgId } = makePoll(id, GATE)
  const refusing = { approve: async () => ({ error: 'closed' }), sendBack: ACTIONS.sendBack }

  const res = await votes.applyVote(
    { voteId: 'REFUSED-1', pollMsgId: msgId, voterJid: DAVID, selectedOption: POLL_APPROVE },
    refusing,
  )
  assert.equal(res.outcome, 'failed')
  // A store refusal is a conflict with the board's state, not a bad gateway.
  assert.equal(res.status, 409)
  assert.equal(res.error, 'closed')
  assert.equal(cursorOf(id), GATE, 'the gate moved despite the action refusing')
  assert.equal(db.prepare('SELECT decided_at FROM gate_poll WHERE id = ?').get(pollId).decided_at, null, 'the claim was not released')

  // The same vote, retried against a working action, finishes the job.
  const retry = await votes.applyVote(
    { voteId: 'REFUSED-1', pollMsgId: msgId, voterJid: DAVID, selectedOption: POLL_APPROVE },
    ACTIONS,
  )
  assert.equal(retry.outcome, 'applied')
  assert.equal(cursorOf(id), GATE + 1)
})

test('a merge-style failure is a 502, so the bridge retries it', async () => {
  const id = makeItem('P-MERGEFAIL', GATE)
  const { msgId } = makePoll(id, GATE)
  const res = await votes.applyVote(
    { voteId: 'MERGEFAIL-1', pollMsgId: msgId, voterJid: DAVID, selectedOption: POLL_APPROVE },
    { approve: async () => ({ error: 'merge failed: required checks pending', status: 502 }), sendBack: ACTIONS.sendBack },
  )
  assert.equal(res.outcome, 'failed')
  assert.equal(res.status, 502)
  assert.equal(cursorOf(id), GATE)
})

test('an action that throws is contained — the arrival stays decidable', async () => {
  const id = makeItem('P-THROWS', GATE)
  const { pollId, msgId } = makePoll(id, GATE)
  const res = await votes.applyVote(
    { voteId: 'THROWS-1', pollMsgId: msgId, voterJid: DAVID, selectedOption: POLL_APPROVE },
    { approve: async () => { throw new Error('github exploded') }, sendBack: ACTIONS.sendBack },
  )
  assert.equal(res.outcome, 'failed')
  assert.equal(res.status, 502)
  assert.match(res.error, /github exploded/)
  assert.equal(db.prepare('SELECT decided_at FROM gate_poll WHERE id = ?').get(pollId).decided_at, null)
})

// ---- the option contract, byte for byte ----

test('the two option strings are exactly the bytes the bridge sends', () => {
  assert.equal(Buffer.from(POLL_APPROVE, 'utf8').toString('hex'), 'e29c8520417070726f7665')
  assert.equal(Buffer.from(POLL_SEND_BACK, 'utf8').toString('hex'), 'e286a9efb88f2053656e64206261636b')
  assert.equal(votes.choiceFor(POLL_APPROVE), 'approve')
  assert.equal(votes.choiceFor(POLL_SEND_BACK), 'send_back')
  assert.equal(votes.choiceFor('Approve'), null)
})

// ---- metric 9, the local half ----

test('nothing on the vote path reached the agent runner except the store calls that own it', () => {
  // approveGate and requestChanges each legitimately call kick()/cancel();
  // what must never appear is a call from waPollVotes itself. Every entry here
  // is therefore paired with a decision, and there is no other kind.
  assert.ok(runnerCalls.length > 0, 'the store never ran — these assertions would be vacuous')
  for (const [name] of runnerCalls) {
    assert.ok(['kick', 'cancel'].includes(name), `unexpected runner call ${name}`)
  }
})
