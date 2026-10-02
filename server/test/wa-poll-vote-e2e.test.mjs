// HZ-142 end to end, the half gate-notifier-e2e.test.mjs cannot reach: a real
// vote, over a real socket, into the real `node src/server.js`.
//
// That sibling file boots the whole server and proves the OUTBOUND leg — a poll
// leaves the process over TCP and its message id is recorded. It deliberately
// stops there: it is built around "exactly three notifications, exactly three
// polls", and a vote moves a cursor, which produces a fourth arrival and turns
// every one of those exact counts into a race. So the INBOUND leg lives here,
// in its own process, where state may move freely.
//
// What only this file proves:
//
//   * the route is actually mounted on the booted server, reachable without a
//     login session, and answers over the wire — inject() would pass even if
//     server.js never listened;
//   * the credential that opens it is WA_APPROVAL_SECRET and FARM_SHARED_SECRET
//     is refused, with the two set to genuinely different values in one real
//     process (metric 8, guardrail 4). wa-poll-vote-auth.test.mjs asserts this
//     through the app object; here it crosses a socket, which is what the
//     bridge actually does;
//   * a tap resolves against a poll id the SERVER minted and the BRIDGE
//     returned, never one a test made up. That round trip — sendPoll's reply
//     becoming gate_poll.poll_msg_id becoming the vote's pollMessageId — is the
//     join the whole feature hangs on, and no other test exercises all of it.
//
// DURABLE ASSERTIONS ONLY. The mock pipeline is live in this process, so a
// cursor is not a stable thing to assert: send back moves an item to an agent
// step and the pipeline immediately starts walking it forward again. So the
// checks below are on gate_decision, feedback and event rows, which are append
// only, plus cursor bounds rather than cursor equality.
//
// Isolation is HZ-138's rule, same as the sibling: PORT=0, a private temp DB,
// and every outbound URL and credential set explicitly rather than inherited,
// so this can reach no real farm, no real GitHub and no real WhatsApp bridge.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'

import { REPO_ROOT } from './helpers/repoFiles.mjs'
import { startStubBridge, waitUntil } from './helpers/stubBridge.mjs'

const APPROVER = '15550003333@s.whatsapp.net'
// On the allowlist, tapping from a second linked device. normalizeJid has to
// strip the `:12` for this to be recognised as the same person.
const APPROVER_DEVICE = '15550003333:12@s.whatsapp.net'
const STRANGER = '19998887777@s.whatsapp.net'

// The two credentials, as different values. The whole point of metric 8 is that
// presenting the SECOND one here opens nothing, so a shared value would make
// every assertion below vacuous. Asserted, not assumed, in the first test.
const WA_SECRET = 'wa-approval-secret-e2e'
const FARM_SECRET = 'farm-shared-secret-e2e'

const { STEPS, gateStepIndexes } = await import('../../domain/js/lifecycle.js')
const GATES = gateStepIndexes()
const POLL_APPROVE = '✅ Approve'
const POLL_SEND_BACK = '↩️ Send back'

// Same derivation as the sibling file: what the mock pipeline walks to a gate
// on a fresh demo seed. One item per leg, so no test depends on another's
// item still being where it was left.
const nextGateFrom = (cursor) => GATES.find((g) => g >= cursor)
const APPROVE_ITEM = 'BF-145'
const SEND_BACK_ITEM = 'BF-119'
const REFUSED_ITEM = 'BF-102' // must finish this file exactly where it started
const WALKERS = [
  { id: APPROVE_ITEM, from: 1 },
  { id: SEND_BACK_ITEM, from: 7 },
  { id: REFUSED_ITEM, from: 12 },
].map((e) => ({ ...e, gate: nextGateFrom(e.from) }))

const bridge = await startStubBridge()
const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-wa-poll-vote-e2e-')), 'test.db')

const serverLog = []
const WATCHDOG = pathToFileURL(path.join(REPO_ROOT, 'server/test/helpers/parentDeathWatch.mjs')).href
const server = spawn(process.execPath, ['--import', WATCHDOG, 'src/server.js'], {
  cwd: path.join(REPO_ROOT, 'server'),
  env: {
    ...process.env,
    HZ_TEST_PARENT_PID: String(process.pid),
    HORIZON_DB: dbPath,
    PORT: '0', // kernel-assigned, then read back off the boot log
    MOCK_STEP_LATENCY_MS: '10',
    HORIZON_UI_URL: 'https://shoreward.ai/horizon/',
    WA_NOTIFY_ENABLED: '1',
    WA_APPROVER_JIDS: APPROVER,
    WA_BRIDGE_URL: bridge.url,
    // The credential under test, and the one that must not work.
    WA_APPROVAL_SECRET: WA_SECRET,
    FARM_SHARED_SECRET: FARM_SECRET,
    // An hour, so every arrival below is store.onChange reacting in real time
    // rather than the backstop timer — same reasoning as the sibling file.
    WA_NOTIFY_SWEEP_MS: String(60 * 60 * 1000),
    HORIZON_REPO: '',
    GITHUB_TOKEN: '',
    GITHUB_WEBHOOK_SECRET: '',
    FARM_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.setEncoding('utf8')
server.stderr.setEncoding('utf8')
server.stdout.on('data', (d) => serverLog.push(d))
server.stderr.on('data', (d) => serverLog.push(d))

after(async () => {
  server.kill('SIGKILL')
  await bridge.close()
})

// A fresh read-only handle per read: the server owns this file and is writing
// to it throughout, so nothing here may hold a connection open across a wait.
function read(sql, ...params) {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

const pollFor = (itemId) => read('SELECT * FROM gate_poll WHERE item_id = ? ORDER BY id DESC', itemId)[0]
const itemRow = (itemId) => read('SELECT * FROM work_item WHERE id = ?', itemId)[0]
const decisions = (itemId) => read('SELECT * FROM gate_decision WHERE item_id = ? ORDER BY id', itemId)
const feedbackRows = (itemId) => read('SELECT * FROM feedback WHERE item_id = ? ORDER BY id', itemId)
const events = (itemId) => read('SELECT * FROM event WHERE item_id = ? ORDER BY id', itemId)
const votes = () => read('SELECT * FROM gate_poll_vote ORDER BY rowid')

// Wait for the boot log to name a port, then for all three items to be parked
// at their gate with a SENT poll carrying the id the bridge returned. That last
// condition is the one that matters: a poll with no poll_msg_id is not yet
// votable, so voting before it lands would be testing the wrong thing.
let baseUrl
try {
  await waitUntil(
    () => {
      // The boot line is JSON, so the address is followed by `"}` — the
      // character class has to stop at the quote or baseUrl carries it along
      // and every fetch below fails to parse a URL.
      const m = serverLog.join('').match(/Server listening at (http:\/\/[^\s"'}\\]+)/)
      if (!m) return false
      baseUrl = m[1].replace(/\/$/, '')
      return WALKERS.every((w) => {
        const item = itemRow(w.id)
        const poll = pollFor(w.id)
        return item?.cursor === w.gate && poll?.status === 'sent' && poll.poll_msg_id
      })
    },
    { timeoutMs: 60_000, description: 'three demo items parked at a gate with a sent, votable poll' },
  )
} catch (err) {
  throw new Error(`${err.message}\n--- server output ---\n${serverLog.join('')}`)
}

let voteSeq = 0
async function vote({ pollMessageId, option = POLL_APPROVE, voterJid = APPROVER, secret = WA_SECRET, voteId }) {
  const headers = { 'Content-Type': 'application/json' }
  if (secret !== null) headers['x-wa-approval-secret'] = secret
  const res = await fetch(`${baseUrl}/api/wa/poll-vote`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      voteId: voteId || `E2E-VOTE-${++voteSeq}`,
      pollMessageId,
      voterJid,
      selectedOption: option,
    }),
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { unparseable: text }
  }
  return { status: res.status, body, raw: text }
}

test('setup: the two credentials really are different values, or metric 8 proves nothing', () => {
  assert.notEqual(WA_SECRET, FARM_SECRET)
  assert.ok(baseUrl, 'the booted server never logged a listening address')
})

// The refusals go FIRST, on their own item, and that item is then asserted
// untouched at the end of the file. Ordering matters: a refusal test that ran
// after the item had been legitimately decided would pass for the wrong reason.
test('FARM_SHARED_SECRET on the approval header is 401 over the wire, and moves nothing', async () => {
  const poll = pollFor(REFUSED_ITEM)
  const before = { decisions: decisions(REFUSED_ITEM).length, events: events(REFUSED_ITEM).length }

  const res = await vote({ pollMessageId: poll.poll_msg_id, secret: FARM_SECRET })

  assert.equal(res.status, 401, `FARM_SHARED_SECRET opened the vote route: ${res.raw}`)
  assert.deepEqual(res.body, { error: 'bad_approval_secret' })
  // No oracle, and no echo of either credential.
  assert.ok(!res.raw.includes(FARM_SECRET))
  assert.ok(!res.raw.includes(WA_SECRET))
  assert.equal(itemRow(REFUSED_ITEM).cursor, poll.step_index)
  assert.equal(decisions(REFUSED_ITEM).length, before.decisions)
  assert.equal(events(REFUSED_ITEM).length, before.events)
  assert.equal(pollFor(REFUSED_ITEM).decided_at, null)
})

test('no credential at all is 401, and a wrong one of any length is too', async () => {
  const poll = pollFor(REFUSED_ITEM)
  for (const secret of [null, '', 'x', 'w'.repeat(500), WA_SECRET + 'x', WA_SECRET.toUpperCase()]) {
    const res = await vote({ pollMessageId: poll.poll_msg_id, secret })
    assert.equal(res.status, 401, `secret ${JSON.stringify(secret)} was not refused: ${res.raw}`)
  }
  assert.equal(itemRow(REFUSED_ITEM).cursor, poll.step_index)
  assert.equal(pollFor(REFUSED_ITEM).decided_at, null)
})

test('a voter not on the server allowlist is 403, and moves nothing (metric 5)', async () => {
  const poll = pollFor(REFUSED_ITEM)
  const before = { decisions: decisions(REFUSED_ITEM).length, events: events(REFUSED_ITEM).length, votes: votes().length }

  const res = await vote({ pollMessageId: poll.poll_msg_id, voterJid: STRANGER })

  assert.equal(res.status, 403)
  assert.deepEqual(res.body, { error: 'voter_not_allowed' })
  assert.equal(itemRow(REFUSED_ITEM).cursor, poll.step_index)
  assert.equal(decisions(REFUSED_ITEM).length, before.decisions)
  assert.equal(events(REFUSED_ITEM).length, before.events)
  assert.equal(pollFor(REFUSED_ITEM).decided_at, null)
  // The route refuses before any write, so an unauthorised flood cannot grow
  // this table without bound.
  assert.equal(votes().length, before.votes, 'a rejected voter wrote a gate_poll_vote row')
})

// ---- the legs that do decide ----

test('an Approve tap on the id the bridge minted approves the gate (metric 3)', async () => {
  const poll = pollFor(APPROVE_ITEM)
  const gate = poll.step_index
  assert.equal(itemRow(APPROVE_ITEM).cursor, gate)
  // The join this file exists to prove: the id came back from the stub bridge's
  // /api/send-poll reply, not from this test.
  const sent = bridge.pollSends().find((p) => p.body.name.includes(APPROVE_ITEM))
  assert.ok(sent, `no poll was ever sent to the bridge about ${APPROVE_ITEM}`)
  assert.deepEqual(sent.body.options, [POLL_APPROVE, POLL_SEND_BACK])
  // The stub mints ids of this shape in its /api/send-poll reply. Matching it
  // proves poll_msg_id was read back off the wire rather than invented server
  // side — which is the only reason a real tap can ever be matched to a gate.
  assert.match(poll.poll_msg_id, /^3EB0POLL\d+$/, `poll id ${poll.poll_msg_id} did not come from the bridge reply`)

  const res = await vote({ pollMessageId: poll.poll_msg_id, option: POLL_APPROVE, voterJid: APPROVER_DEVICE })

  assert.equal(res.status, 200, res.raw)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.outcome, 'applied')
  assert.equal(res.body.itemId, APPROVE_ITEM)
  assert.equal(res.body.stepIndex, gate)
  assert.equal(res.body.choice, 'approve')

  const approved = decisions(APPROVE_ITEM).filter((d) => d.step_index === gate && d.decision === 'approved')
  assert.equal(approved.length, 1, 'no approved gate_decision row for the gate that was tapped')
  // Attributed to the proven jid's last four digits, never to 'You'.
  assert.match(approved[0].decided_by, /^\.\.\.3333 via WhatsApp poll$/)
  // The gate opened: the cursor is past it. Only a bound, because the pipeline
  // keeps walking the item forward from here.
  assert.ok(itemRow(APPROVE_ITEM).cursor > gate, `cursor ${itemRow(APPROVE_ITEM).cursor} did not clear gate ${gate}`)
  // By id, not pollFor: the pipeline is already walking BF-145 to its next
  // gate, so the latest poll can change between two reads.
  const tapped = read('SELECT * FROM gate_poll WHERE id = ?', poll.id)[0]
  assert.equal(tapped.poll_msg_id, poll.poll_msg_id)
  assert.ok(tapped.decided_at, `tapped poll ${poll.id} was not marked decided`)
})

test('a replay of that applied vote is 200 duplicate, not a second approval', async () => {
  const poll = read('SELECT * FROM gate_poll WHERE item_id = ? AND poll_msg_id IS NOT NULL ORDER BY id', APPROVE_ITEM)[0]
  const applied = votes().find((v) => v.outcome === 'applied' && v.poll_id === poll.id)
  assert.ok(applied, 'the approve leg left no applied vote row to replay')
  const before = decisions(APPROVE_ITEM).length

  const res = await vote({ pollMessageId: poll.poll_msg_id, option: POLL_APPROVE, voteId: applied.vote_id })

  // 200, deliberately: the bridge retries on 5xx and treats 4xx as final, so a
  // refusal here would look to it like the vote had been rejected.
  assert.equal(res.status, 200, res.raw)
  assert.equal(res.body.outcome, 'duplicate')
  assert.equal(decisions(APPROVE_ITEM).length, before, 'a replayed vote decided the gate a second time')
})

test('a Send back tap routes the item to the gate default rework target (metric 4)', async () => {
  const poll = pollFor(SEND_BACK_ITEM)
  const gate = poll.step_index
  assert.equal(itemRow(SEND_BACK_ITEM).cursor, gate)

  const res = await vote({ pollMessageId: poll.poll_msg_id, option: POLL_SEND_BACK })

  assert.equal(res.status, 200, res.raw)
  assert.equal(res.body.outcome, 'applied')
  assert.equal(res.body.choice, 'send_back')

  const rejected = decisions(SEND_BACK_ITEM).filter((d) => d.step_index === gate && d.decision === 'rejected')
  assert.equal(rejected.length, 1, 'no rejected gate_decision row for the gate that was tapped')
  assert.match(rejected[0].decided_by, /via WhatsApp poll$/)

  // The default rework target, derived by store.requestChanges (the single
  // derivation) — the nearest agent step at or before the gate.
  let expected = gate
  while (expected > 0 && STEPS[expected].kind !== 'agent') expected--
  const fb = feedbackRows(SEND_BACK_ITEM).at(-1)
  assert.equal(fb.target, STEPS[expected].agent, `feedback went to ${fb.target}, not the default rework agent`)
  // A bound, not an equality: the pipeline starts re-running that step at once.
  assert.ok(itemRow(SEND_BACK_ITEM).cursor <= gate)

  // The event names the gate rather than "this step", and invites the
  // follow-up the concierge's existing feedback action already handles.
  const text = events(SEND_BACK_ITEM).map((e) => e.text).join('\n')
  assert.ok(text.includes(STEPS[gate].label), `no event named the gate:\n${text}`)
  assert.ok(!/requested changes on this step/.test(text), 'the send-back event degraded to "this step"')
})

test('a vote on the gate the item has now left changes nothing (metric 6)', async () => {
  // The approve leg above moved this item off its gate, and its poll is the one
  // that carried the decision. A second tap on it must not reach back.
  const poll = read('SELECT * FROM gate_poll WHERE item_id = ? AND poll_msg_id IS NOT NULL ORDER BY id', APPROVE_ITEM)[0]
  const before = { decisions: decisions(APPROVE_ITEM).length, cursor: itemRow(APPROVE_ITEM).cursor }

  const res = await vote({ pollMessageId: poll.poll_msg_id, option: POLL_SEND_BACK })

  assert.equal(res.status, 409, res.raw)
  assert.ok(
    ['already_decided', 'gate_moved', 'ignored_already_decided', 'ignored_stale_gate', 'ignored_superseded'].includes(
      res.body.error,
    ),
    `unexpected refusal: ${res.raw}`,
  )
  assert.equal(decisions(APPROVE_ITEM).length, before.decisions)
})

test('a tap naming a poll this server never sent is 404, and moves nothing', async () => {
  const res = await vote({ pollMessageId: 'NOT-A-POLL-THIS-SERVER-SENT' })
  assert.equal(res.status, 404)
  assert.deepEqual(res.body, { error: 'ignored_unknown_poll' })
})

test('an option string that is neither of the two is 422 — never guessed', async () => {
  const poll = pollFor(REFUSED_ITEM)
  for (const option of ['Approve', '✅Approve', 'approve', '↩ Send back', 'yes']) {
    const res = await vote({ pollMessageId: poll.poll_msg_id, option })
    assert.equal(res.status, 422, `${JSON.stringify(option)} was resolved instead of refused: ${res.raw}`)
  }
  assert.equal(itemRow(REFUSED_ITEM).cursor, poll.step_index, 'a guessed option decided a gate')
  assert.equal(pollFor(REFUSED_ITEM).decided_at, null)
})

test('a malformed body is 400 and never reaches the validator', async () => {
  const send = (headers) =>
    fetch(`${baseUrl}/api/wa/poll-vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ voteId: 'V', pollMessageId: 'P' }), // no voterJid, no selectedOption
    })

  assert.equal((await send({ 'x-wa-approval-secret': WA_SECRET })).status, 400)

  // 400 WITH NO CREDENTIAL TOO, and that is Fastify's lifecycle rather than a
  // hole: schema validation runs before any handler, so the body shape is
  // checked ahead of the 503/401/403 ladder. Verified to be exactly what the
  // sibling approve-via-whatsapp route already does, so the two stay
  // consistent. It leaks nothing that matters — the schema is public, and no
  // item id, poll id or allowlist membership is revealed either way. The
  // oracle assertion that DOES matter is above: a well-formed body from an
  // unauthenticated caller is 401, never an outcome. The no-poll-existence
  // oracle for a rejected voter is pinned in wa-poll-vote-auth.test.mjs.
  const noAuth = await send({})
  assert.equal(noAuth.status, 400)
  const body = await noAuth.text()
  assert.ok(!body.includes(WA_SECRET))
  assert.ok(!body.includes(FARM_SECRET))
})

test('the route needs no login session — the bridge is a daemon and has none', async () => {
  // Concrete rather than inferred: no cookie, no Authorization header, a real
  // credential, and a poll id that does not exist. Reaching the validator at
  // all — 404 from waPollVotes, not an auth refusal — is what proves
  // SESSION_EXEMPT covers this path on the booted server. Every deciding
  // request above was equally sessionless, so if this were wrong they would
  // have failed too.
  const res = await vote({ pollMessageId: 'SESSION-PROBE-NO-SUCH-POLL' })
  assert.equal(res.status, 404, `the route demanded a session: ${res.raw}`)
  assert.deepEqual(res.body, { error: 'ignored_unknown_poll' })
  assert.ok(!/session|login|unauthor/i.test(res.raw))

  const log = serverLog.join('')
  assert.match(log, /Server listening at/, `server.js never finished booting:\n${log}`)
})

test('the outbound poll leg carried no credential, and only the two bridge paths were used', () => {
  assert.ok(bridge.pollSends().length >= WALKERS.length, `only ${bridge.pollSends().length} polls reached the bridge`)
  for (const poll of bridge.pollSends()) {
    assert.deepEqual(Object.keys(poll.body).sort(), ['name', 'options', 'recipient'])
    assert.ok(!('x-wa-approval-secret' in poll.headers), 'the poll send carried the approval credential')
    assert.ok(!('authorization' in poll.headers))
    // The credential travels INBOUND only — bridge to server. It must appear
    // nowhere on the outbound leg (metric 8, guardrail 4).
    assert.ok(!poll.raw.includes(WA_SECRET))
    assert.ok(!poll.raw.includes(FARM_SECRET))
    assert.ok(!/secret|token/i.test(poll.raw))
  }
  assert.equal(
    bridge.requests.length,
    bridge.sends().length + bridge.pollSends().length,
    `the server hit a third bridge path: ${bridge.requests.map((r) => `${r.method} ${r.path}`).join(', ')}`,
  )
})

test('every vote the server accepted is recorded exactly once, with its outcome', () => {
  const all = votes()
  const ids = all.map((v) => v.vote_id)
  assert.equal(new Set(ids).size, ids.length, 'a vote id was recorded twice')
  // Two decided (one approve, one send back); every other row is a refusal
  // that reached the validator. None may be left holding a claim.
  const applied = all.filter((v) => v.outcome === 'applied')
  assert.equal(applied.length, 2, `${applied.length} votes applied, expected exactly 2`)
  assert.deepEqual(applied.map((v) => v.choice).sort(), ['approve', 'send_back'])
  assert.equal(all.filter((v) => v.outcome === 'claimed').length, 0, 'a vote was left holding a claim')
})

test('the item nobody was allowed to decide is exactly where it started', () => {
  const item = itemRow(REFUSED_ITEM)
  const gate = WALKERS.find((w) => w.id === REFUSED_ITEM).gate
  assert.equal(item.cursor, gate, 'a refused vote moved the item after all')
  assert.equal(decisions(REFUSED_ITEM).length, 0, 'a refused vote left a gate_decision row')
  assert.equal(pollFor(REFUSED_ITEM).decided_at, null)
})
