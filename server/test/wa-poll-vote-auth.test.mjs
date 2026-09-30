// HZ-142 success metric 8 and guardrail 4: votes are forwarded using the
// dedicated approval credential, never FARM_SHARED_SECRET.
//
// Modelled on wa-approval-auth.test.mjs, and for the same reason: a metric
// phrased as "never X" has no teeth without the negative case. The load-bearing
// assertion here is that FARM_SHARED_SECRET's actual VALUE, presented on the
// approval header, is refused — not merely that a wrong header is.
//
// Driven through the real Fastify app with inject(), so the session gate, the
// body schema and the 503/401/403 ladder are the real ones.
//
// Its own file because config.js reads the environment at import time.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-wa-poll-auth-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const WA_SECRET = 'wa-approval-secret-for-tests'
process.env.WA_APPROVAL_SECRET = WA_SECRET
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'
process.env.FARM_SHARED_SECRET = 'farm-shared-secret-for-tests'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const store = await import('../src/store.js')
const votes = await import('../src/waPollVotes.js')
const { POLL_APPROVE, POLL_SEND_BACK } = await import('../src/waSend.js')
const { STEPS, gateStepIndexes } = await import('../../domain/js/lifecycle.js')
const { FARM_SHARED_SECRET, WA_APPROVAL_SECRET } = await import('../src/config.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })

const GATE = gateStepIndexes()[0]
const DAVID = '15550001111@s.whatsapp.net'
const STRANGER = '19998887777@s.whatsapp.net'

let seq = 0
function fixture(id) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(id, `Poll auth ${id}`, 'Medium', GATE)
  const msgId = `MSG-${++seq}`
  const pollId = votes.registerPoll({ itemId: id, stepIndex: GATE, recipient: DAVID, question: `${id} — ${STEPS[GATE].label}` })
  votes.attachPollMessageId(pollId, msgId)
  return msgId
}

const post = (payload, headers = {}) => app.inject({ method: 'POST', url: '/api/wa/poll-vote', payload, headers })
const withSecret = (payload, secret = WA_SECRET) => post(payload, { 'x-wa-approval-secret': secret })

const body = (msgId, option = POLL_APPROVE, voterJid = DAVID, voteId = `V-${++seq}`) => ({
  voteId,
  pollMessageId: msgId,
  voterJid,
  selectedOption: option,
})

const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const totals = () => ({
  decisions: db.prepare('SELECT COUNT(*) AS n FROM gate_decision').get().n,
  events: db.prepare('SELECT COUNT(*) AS n FROM event').get().n,
  votes: db.prepare('SELECT COUNT(*) AS n FROM gate_poll_vote').get().n,
})

async function assertNothingChanged(id, run) {
  const before = { cursor: cursorOf(id), ...totals() }
  const res = await run()
  assert.deepEqual({ cursor: cursorOf(id), ...totals() }, before, `${res.statusCode} was not side-effect free`)
  return res
}

test('setup: the two credentials are genuinely different values', () => {
  assert.equal(WA_APPROVAL_SECRET, WA_SECRET)
  assert.notEqual(FARM_SHARED_SECRET, WA_APPROVAL_SECRET)
})

test('the dedicated approval credential plus an allowlisted voter decides the gate', async () => {
  const msgId = fixture('V-OK')
  const res = await withSecret(body(msgId))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, outcome: 'applied', itemId: 'V-OK', stepIndex: GATE, choice: 'approve' })
  assert.equal(cursorOf('V-OK'), GATE + 1)
})

test('a Send back vote over the route moves the item back', async () => {
  const msgId = fixture('V-BACK')
  const res = await withSecret(body(msgId, POLL_SEND_BACK))
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().choice, 'send_back')
  assert.ok(cursorOf('V-BACK') < GATE)
})

// ---- metric 8 / guardrail 4 ----

test("FARM_SHARED_SECRET's own value on the approval header is refused: 401, nothing moves", async () => {
  const msgId = fixture('V-FARM')
  const res = await assertNothingChanged('V-FARM', () => withSecret(body(msgId), FARM_SHARED_SECRET))
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'bad_approval_secret' })
})

test('FARM_SHARED_SECRET on its own header opens nothing here', async () => {
  const msgId = fixture('V-FARMHDR')
  const res = await assertNothingChanged('V-FARMHDR', () =>
    post(body(msgId), { 'x-farm-secret': FARM_SHARED_SECRET }),
  )
  assert.equal(res.statusCode, 401)
})

test('the forgery path: what an agent session can send is 401, every time', async () => {
  const msgId = fixture('V-FORGE')
  for (const headers of [{}, { 'x-farm-secret': FARM_SHARED_SECRET }, { 'x-wa-approval-secret': '' }]) {
    const res = await assertNothingChanged('V-FORGE', () => post(body(msgId), headers))
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: 'bad_approval_secret' })
  }
})

test('a wrong credential of any length is 401, never a 500', async () => {
  const msgId = fixture('V-LEN')
  for (const secret of ['x', 'x'.repeat(4096), `${WA_SECRET}-and-more`, WA_SECRET.slice(0, -1)]) {
    const res = await withSecret(body(msgId), secret)
    assert.equal(res.statusCode, 401, `secret of length ${secret.length} got ${res.statusCode}`)
  }
})

test('a voter not on the server allowlist is 403 and nothing moves', async () => {
  const msgId = fixture('V-STRANGER')
  const res = await assertNothingChanged('V-STRANGER', () => withSecret(body(msgId, POLL_APPROVE, STRANGER)))
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.json(), { error: 'voter_not_allowed' })
})

test('a wrong credential AND a bad voter is 401 — auth runs first, so the allowlist is no oracle', async () => {
  const msgId = fixture('V-BOTH')
  const res = await assertNothingChanged('V-BOTH', () =>
    withSecret(body(msgId, POLL_APPROVE, STRANGER), 'wrong-secret'),
  )
  assert.equal(res.statusCode, 401)
})

test('a rejected voter on an unknown poll is 403, not 404 — no poll-existence oracle', async () => {
  const res = await withSecret(body('MSG-NEVER-EXISTED', POLL_APPROVE, STRANGER))
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.json(), { error: 'voter_not_allowed' })
})

test('no response body ever echoes either credential', async () => {
  const msgId = fixture('V-ECHO')
  const bodies = [
    (await withSecret(body(msgId))).body,
    (await withSecret(body(msgId, POLL_APPROVE, STRANGER))).body,
    (await post(body(msgId), {})).body,
    (await withSecret(body(msgId), FARM_SHARED_SECRET)).body,
  ]
  for (const b of bodies) {
    assert.ok(!b.includes(WA_APPROVAL_SECRET), b)
    assert.ok(!b.includes(FARM_SHARED_SECRET), b)
  }
})

// ---- the route is session-exempt but not session-open ----

test('the route needs no login session — the bridge is a daemon and has none', async () => {
  const msgId = fixture('V-NOSESSION')
  const res = await withSecret(body(msgId))
  assert.notEqual(res.statusCode, 401)
  assert.equal(res.json().ok, true)
})

test('the approval credential does NOT open a farm route, and the farm secret does not open this one', async () => {
  const farm = await app.inject({
    method: 'GET',
    url: '/api/farm/snapshot',
    headers: { 'x-farm-secret': WA_APPROVAL_SECRET },
  })
  assert.equal(farm.statusCode, 401)
  const still = await app.inject({
    method: 'GET',
    url: '/api/farm/snapshot',
    headers: { 'x-farm-secret': FARM_SHARED_SECRET },
  })
  assert.equal(still.statusCode, 200, 'HZ-142 broke farmd’s own route')
})

// ---- the body schema ----

test('a malformed body is 400 and never reaches the validator', async () => {
  const msgId = fixture('V-SCHEMA')
  const payloads = [
    {},
    { voteId: 'x' },
    { voteId: 'x', pollMessageId: 'y', voterJid: DAVID },
    { voteId: '', pollMessageId: msgId, voterJid: DAVID, selectedOption: POLL_APPROVE },
    { voteId: 'x', pollMessageId: msgId, voterJid: DAVID, selectedOption: 'y'.repeat(500) },
    { voteId: 'x', pollMessageId: 'y'.repeat(500), voterJid: DAVID, selectedOption: POLL_APPROVE },
  ]
  for (const payload of payloads) {
    const res = await assertNothingChanged('V-SCHEMA', () => withSecret(payload))
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} got ${res.statusCode}`)
  }
})

// Fastify coerces a non-string into the declared string type, so a numeric
// voterJid arrives as "42". That must not launder it past the allowlist —
// identity comes from the allowlist check, never from the body's shape.
test('a coerced non-string voterJid is still refused by the allowlist', async () => {
  const msgId = fixture('V-COERCE')
  const res = await assertNothingChanged('V-COERCE', () =>
    withSecret({ voteId: 'coerce-1', pollMessageId: msgId, voterJid: 42, selectedOption: POLL_APPROVE }),
  )
  assert.ok([400, 403].includes(res.statusCode), `expected 400/403, got ${res.statusCode}`)
})

// ---- every 4xx is final, so the bridge stops retrying ----

test('the outcome ladder answers the statuses the bridge treats as final', async () => {
  const expected = {
    ignored_unknown_poll: 404,
    ignored_unknown_option: 422,
    ignored_stale_gate: 409,
  }
  const unknownPoll = await withSecret(body('MSG-NEVER-EXISTED'))
  assert.equal(unknownPoll.statusCode, expected.ignored_unknown_poll)
  assert.deepEqual(unknownPoll.json(), { error: 'ignored_unknown_poll' })

  const badOption = await withSecret(body(fixture('V-OPT'), 'Approve'))
  assert.equal(badOption.statusCode, expected.ignored_unknown_option)

  const moved = fixture('V-MOVED')
  db.prepare("UPDATE work_item SET cursor = ? WHERE id = 'V-MOVED'").run(GATE + 1)
  const stale = await withSecret(body(moved))
  assert.equal(stale.statusCode, expected.ignored_stale_gate)

  for (const status of Object.values(expected)) {
    assert.ok(status >= 400 && status < 500, `${status} would be retried forever by the bridge`)
  }
})

test('a replay of an applied vote is 200 — a 4xx there would look like a refusal', async () => {
  const msgId = fixture('V-REPLAY')
  const payload = body(msgId, POLL_APPROVE, DAVID, 'REPLAY-ROUTE-1')
  assert.equal((await withSecret(payload)).statusCode, 200)
  const again = await withSecret(payload)
  assert.equal(again.statusCode, 200)
  assert.deepEqual(again.json(), { ok: true, outcome: 'duplicate' })
})
