// HZ-140: the approve-via-whatsapp auth matrix, driven through the real
// Fastify app.
//
// The forgery this closes: farm/tmux_mgr.py used to forward FARM_SHARED_SECRET
// into every agent session, and this route was guarded by nothing else, so any
// agent with Bash could approve its own gate. Two assertions carry that here —
// FARM_SHARED_SECRET is refused (401), and a caller-supplied sender that is
// not on the server's own allowlist is refused (403). The Python half of the
// same metric, that an agent session no longer even holds a credential to
// send, lives in farm/tests/test_tmux_env.py.
//
// Its own file because config.js reads the environment at import time and
// these vars must be set before that import.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withGreenPremerge } from './helpers/greenPremerge.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-wa-approval-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const WA_SECRET = 'wa-approval-secret-for-tests'
process.env.WA_APPROVAL_SECRET = WA_SECRET
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net,15550002222'
process.env.FARM_SHARED_SECRET = 'farm-shared-secret-for-tests'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const { FARM_SHARED_SECRET, WA_APPROVAL_SECRET } = await import('../src/config.js')
const store = await import('../src/store.js')
const premerge = await import('../src/premerge.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })

const DAVID = '15550001111@s.whatsapp.net'
const EVAN = '15550002222@s.whatsapp.net'
const STRANGER = '19998887777@s.whatsapp.net'

// Gate steps, found the same way app.test.mjs does — by label, never by a
// hardcoded index.
const GATE_INDEX = STEPS.findIndex((s) => s.kind === 'gate')
const NOT_GATE_INDEX = STEPS.findIndex((s) => s.kind === 'agent')

const ITEMS = [
  ['W-OK', GATE_INDEX],
  ['W-REJECT', GATE_INDEX],
  ['W-FORGE', GATE_INDEX],
  ['W-SUFFIX', GATE_INDEX],
  ['W-NOTGATE', NOT_GATE_INDEX],
  ['W-STALE', GATE_INDEX],
  ['W-NONAME', GATE_INDEX],
]
for (const [id, cursor] of ITEMS) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
    id,
    `WhatsApp approval fixture ${id}`,
    'Medium',
    cursor,
  )
}
db.prepare(
  'INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)',
).run('W-MERGE', 'Accept gate', 'Medium', ACCEPT_GATE_INDEX, 'acme/demo', 9, 41)

const post = (id, stepIndex, payload, headers = {}) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/gates/${stepIndex}/approve-via-whatsapp`, payload, headers })

const approve = (id, stepIndex, payload, secret = WA_SECRET) =>
  post(id, stepIndex, payload, { 'x-wa-approval-secret': secret })

const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const decisionCount = () => db.prepare('SELECT COUNT(*) AS n FROM gate_decision').get().n
const eventCount = () => db.prepare('SELECT COUNT(*) AS n FROM event').get().n

// Asserts that nothing at all moved — not the cursor, not gate_decision, not
// the event log. Every reject path below goes through this.
async function assertNothingChanged(id, run) {
  const before = { cursor: cursorOf(id), decisions: decisionCount(), events: eventCount() }
  const res = await run()
  assert.equal(cursorOf(id), before.cursor, 'cursor moved')
  assert.equal(decisionCount(), before.decisions, 'a gate_decision row was written')
  assert.equal(eventCount(), before.events, 'an event row was written')
  return res
}

test('setup: the two credentials are genuinely different values', () => {
  // Otherwise "FARM_SHARED_SECRET is rejected" below would pass or fail for
  // entirely the wrong reason.
  assert.equal(WA_APPROVAL_SECRET, WA_SECRET)
  assert.notEqual(FARM_SHARED_SECRET, WA_APPROVAL_SECRET)
  assert.ok(GATE_INDEX > 0 && NOT_GATE_INDEX >= 0)
})

test('the dedicated approval credential + an allowlisted sender approves the gate', async () => {
  const res = await approve('W-OK', GATE_INDEX, { senderJid: DAVID, sender: 'David', notes: 'looks good' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, closed: false })
  assert.equal(cursorOf('W-OK'), GATE_INDEX + 1)
  assert.equal(
    db.prepare("SELECT decided_by FROM gate_decision WHERE item_id = 'W-OK'").get().decided_by,
    'David via WhatsApp',
  )
})

test('an allowlisted jid carrying a device suffix still approves', async () => {
  const res = await approve('W-SUFFIX', GATE_INDEX, { senderJid: '15550002222:12@s.whatsapp.net', sender: 'Evan' })
  assert.equal(res.statusCode, 200)
  assert.equal(cursorOf('W-SUFFIX'), GATE_INDEX + 1)
})

test('with no display name the actor falls back to the last 4 digits of the proven jid', async () => {
  const res = await approve('W-NONAME', GATE_INDEX, { senderJid: EVAN })
  assert.equal(res.statusCode, 200)
  assert.equal(
    db.prepare("SELECT decided_by FROM gate_decision WHERE item_id = 'W-NONAME'").get().decided_by,
    '...2222 via WhatsApp',
  )
})

test('FARM_SHARED_SECRET is refused: 401 and the gate is untouched', async () => {
  const res = await assertNothingChanged('W-FORGE', () =>
    post('W-FORGE', GATE_INDEX, { senderJid: DAVID, sender: 'David' }, { 'x-farm-secret': FARM_SHARED_SECRET }),
  )
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'bad_approval_secret' })
})

test('FARM_SHARED_SECRET sent on the approval header is refused too', async () => {
  const res = await assertNothingChanged('W-FORGE', () =>
    approve('W-FORGE', GATE_INDEX, { senderJid: DAVID, sender: 'David' }, FARM_SHARED_SECRET),
  )
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'bad_approval_secret' })
})

test('the forgery path: an agent-environment request cannot approve a gate', async () => {
  // farm/tests/test_tmux_env.py proves an agent session's environment holds
  // neither credential. This is what such a process can therefore send: no
  // header at all, or the FARM_* value it used to inherit. Both are 401 and
  // the gate does not move.
  for (const headers of [{}, { 'x-farm-secret': FARM_SHARED_SECRET }, { 'x-wa-approval-secret': '' }]) {
    const res = await assertNothingChanged('W-FORGE', () =>
      post('W-FORGE', GATE_INDEX, { senderJid: DAVID, sender: 'David' }, headers),
    )
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: 'bad_approval_secret' })
  }
})

test('a sender not on the server allowlist is refused: 403 and the gate is untouched', async () => {
  const res = await assertNothingChanged('W-REJECT', () =>
    approve('W-REJECT', GATE_INDEX, { senderJid: STRANGER, sender: 'David' }),
  )
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.json(), { error: 'sender_not_allowed' })
})

test('a friendly display name does not launder a non-allowlisted jid', async () => {
  // The old bug in one line: `sender` was free text and was the only identity
  // the server saw. It is a label now; senderJid is what is checked.
  const res = await assertNothingChanged('W-REJECT', () =>
    approve('W-REJECT', GATE_INDEX, { senderJid: STRANGER, sender: 'David' }),
  )
  assert.equal(res.statusCode, 403)
})

test('a wrong credential AND a bad sender is 401 — auth runs first, so the allowlist is no oracle', async () => {
  const res = await assertNothingChanged('W-REJECT', () =>
    approve('W-REJECT', GATE_INDEX, { senderJid: STRANGER, sender: 'nobody' }, 'wrong-secret'),
  )
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'bad_approval_secret' })
})

test('a rejected sender on an unknown item is 403, not 404 — no item-existence oracle', async () => {
  const res = await approve('NOPE-9', 0, { senderJid: STRANGER, sender: 'nobody' })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.json(), { error: 'sender_not_allowed' })
})

test('a wrong credential of a different length is 401, never a 500', async () => {
  for (const secret of ['x', 'x'.repeat(4096), `${WA_SECRET}-and-more`]) {
    const res = await approve('W-REJECT', GATE_INDEX, { senderJid: DAVID }, secret)
    assert.equal(res.statusCode, 401)
  }
})

test('an empty, missing or non-string senderJid is rejected by the schema or the allowlist', async () => {
  for (const payload of [{}, { senderJid: '' }, { senderJid: null }, { senderJid: 42 }, { sender: 'David' }]) {
    const res = await assertNothingChanged('W-REJECT', () => approve('W-REJECT', GATE_INDEX, payload))
    assert.ok([400, 403].includes(res.statusCode), `expected 400/403, got ${res.statusCode}`)
  }
})

test('no response body ever echoes either credential', async () => {
  const bodies = []
  bodies.push((await approve('W-REJECT', GATE_INDEX, { senderJid: DAVID })).body)
  bodies.push((await approve('W-REJECT', GATE_INDEX, { senderJid: STRANGER })).body)
  bodies.push((await post('W-REJECT', GATE_INDEX, { senderJid: DAVID }, {})).body)
  for (const body of bodies) {
    assert.ok(!body.includes(WA_APPROVAL_SECRET))
    assert.ok(!body.includes(FARM_SHARED_SECRET))
  }
})

// ---- the pre-HZ-140 outcomes, re-run under the new credential ----

test('404 for an unknown item, with a valid credential and an allowlisted sender', async () => {
  const res = await approve('NOPE-9', 0, { senderJid: DAVID, sender: 'David' })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'not_found' })
})

test('409 not_at_gate when the item is not on a gate step', async () => {
  const res = await approve('W-NOTGATE', NOT_GATE_INDEX, { senderJid: DAVID, sender: 'David' })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'not_at_gate' })
})

test('409 stale_step when the step index no longer matches the cursor', async () => {
  const res = await approve('W-STALE', GATE_INDEX - 1, { senderJid: DAVID, sender: 'David' })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'stale_step' })
})

test('502 when the PR merge fails, and the gate stays open', async () => {
  const mergeRefused = async () => ({
    ok: false,
    status: 405,
    json: async () => ({ message: 'required checks pending' }),
    text: async () => '',
  })
  await withGreenPremerge(premerge, mergeRefused, async () => {
    const res = await approve('W-MERGE', ACCEPT_GATE_INDEX, { senderJid: EVAN, sender: 'Evan' })
    assert.equal(res.statusCode, 502)
    assert.match(res.json().error, /merge failed/)
    assert.equal(cursorOf('W-MERGE'), ACCEPT_GATE_INDEX)
  })
})

// ---- guardrail 4: farmd's own routes are untouched ----

test('x-farm-secret still opens /api/farm/snapshot in the same run', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/farm/snapshot',
    headers: { 'x-farm-secret': FARM_SHARED_SECRET },
  })
  assert.equal(res.statusCode, 200)
  assert.ok(Array.isArray(res.json().items))
})

test('the approval credential does NOT open /api/farm/snapshot', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/farm/snapshot',
    headers: { 'x-farm-secret': WA_APPROVAL_SECRET },
  })
  assert.equal(res.statusCode, 401)
})
