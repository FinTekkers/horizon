// HZ-790: the WhatsApp concierge's two writes that used to go to the
// session-gated /feedback and /priority and get 401 login_required:
//
//   POST /api/items/:id/gates/:step/note-via-whatsapp — a note on an item
//     parked at a gate. Saved as one feedback row; it never decides the gate.
//   POST /api/items/:id/priority-via-whatsapp — the same priority write.
//
// Both run the waCallerOk ladder (503/401/403) before any lookup and write
// nothing on a refusal. The 503 rung is in wa-approval-unconfigured.test.mjs,
// where WA_APPROVAL_SECRET is unset. Its own file because config.js reads the
// environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-wa-gate-note-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'FARM_STEP_INDEXES', 'WA_NOTIFY_ENABLED', 'WA_POLL_ENABLED']) delete process.env[key]

const WA_SECRET = 'wa-approval-secret-for-tests'
process.env.WA_APPROVAL_SECRET = WA_SECRET
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'

const ok = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) })
globalThis.fetch = async (url) => {
  if (String(url).startsWith('https://api.github.com/')) return { ok: false, status: 500, headers: new Headers(), json: async () => ({}) }
  return ok({ ok: true })
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, stepIndexOf } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
// Every log line the app writes, at every level, for the no-echo checks.
const logs = []
const app = buildApp({ logger: { level: 'trace', stream: { write: (line) => logs.push(line) } } })
await app.ready()

after(async () => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
  await app.close()
})

const DAVID = '15550001111@s.whatsapp.net'
const STRANGER = '19998887777@s.whatsapp.net'
const GATE_KEY = 'change.approve-design'
const AGENT_KEY = 'change.draft-plan'
const GATE = stepIndexOf(GATE_KEY)
assert.equal(STEPS[GATE].kind, 'gate')
assert.equal(STEPS[stepIndexOf(AGENT_KEY)].kind, 'agent')

const insertItem = db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, 'Medium', ?)")
const seed = (id, cursor = GATE) => {
  insertItem.run(id, `Gate note fixture ${id}`, cursor)
  return id
}

// The exact key sets the concierge sends (farm/concierge_agent.py), so the two
// halves cannot drift apart unnoticed.
const NOTE = 'Tighten the rollback section, please!\nand keep the old tests'
const noteBody = (over = {}) => ({ message: NOTE, senderJid: DAVID, sender: 'David', ...over })
const priorityBody = (over = {}) => ({ priority: 'High', senderJid: DAVID, sender: 'David', ...over })

const inject = (url, payload, secret) =>
  app.inject({ method: 'POST', url, payload, headers: secret == null ? {} : { 'x-wa-approval-secret': secret } })
const postNote = (id, payload, { secret = WA_SECRET, step = GATE_KEY } = {}) =>
  inject(`/api/items/${id}/gates/${step}/note-via-whatsapp`, payload, secret)
const postPriority = (id, payload, secret = WA_SECRET) => inject(`/api/items/${id}/priority-via-whatsapp`, payload, secret)

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
const rows = () => ({ feedback: count('feedback'), events: count('event'), decisions: count('gate_decision') })
const itemRow = (id) => db.prepare('SELECT cursor, priority FROM work_item WHERE id = ?').get(id)

// [label, secret, senderJid, status, error]: the 401 and 403 rungs.
const REFUSALS = [
  ['no header', null, DAVID, 401, 'bad_approval_secret'],
  ['wrong secret', 'wrong', DAVID, 401, 'bad_approval_secret'],
  ['the farm secret', 'farm-shared-secret-for-tests', DAVID, 401, 'bad_approval_secret'],
  ['a sender off the allowlist', WA_SECRET, STRANGER, 403, 'sender_not_allowed'],
]

test('note-via-whatsapp: 401 and 403 come before any lookup, so an unknown item gets them too', async () => {
  const before = rows()
  for (const [label, secret, senderJid, status, error] of REFUSALS) {
    const res = await postNote('G-NO-SUCH', noteBody({ senderJid }), { secret })
    assert.equal(res.statusCode, status, label)
    assert.deepEqual(res.json(), { error }, label)
  }
  assert.deepEqual(rows(), before)
})

test('note-via-whatsapp: a refused call on an item parked at a gate writes nothing and moves nothing', async () => {
  const id = seed('G-LADDER')
  const before = rows()
  for (const [label, secret, senderJid, status, error] of REFUSALS) {
    const res = await postNote(id, noteBody({ senderJid }), { secret })
    assert.equal(res.statusCode, status, label)
    assert.deepEqual(res.json(), { error }, label)
    assert.ok(!res.body.includes(WA_SECRET), label)
  }
  assert.deepEqual(rows(), before)
  assert.equal(itemRow(id).cursor, GATE)
})

test('note-via-whatsapp: a missing or empty senderJid is 400, never the allowlist', async () => {
  const id = seed('G-NOJID')
  const before = rows()
  const { senderJid: _dropped, ...noJid } = noteBody()
  for (const payload of [noJid, noteBody({ senderJid: '' })]) {
    const res = await postNote(id, payload)
    assert.equal(res.statusCode, 400)
  }
  assert.deepEqual(rows(), before)
})

test('note-via-whatsapp: a key outside the concierge payload is 400', async () => {
  const id = seed('G-EXTRA')
  const before = rows()
  const res = await postNote(id, noteBody({ target: 'Eng' }))
  assert.equal(res.statusCode, 400)
  assert.deepEqual(rows(), before)
})

test('note-via-whatsapp: an unknown item is 404 for an allowed sender', async () => {
  const res = await postNote('G-NO-SUCH', noteBody())
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'not_found' })
})

test('note-via-whatsapp: a gate the item has already passed is 409 not_at_gate and writes no row', async () => {
  const passed = seed('G-PASSED', GATE + 1)
  const running = seed('G-AGENT', stepIndexOf(AGENT_KEY))
  const before = rows()
  for (const id of [passed, running]) {
    const res = await postNote(id, noteBody())
    assert.equal(res.statusCode, 409, id)
    assert.deepEqual(res.json(), { error: 'not_at_gate' }, id)
  }
  assert.deepEqual(rows(), before)
  assert.equal(itemRow(passed).cursor, GATE + 1)
})

test('note-via-whatsapp: a good call saves one feedback row with the exact note and never moves the gate', async () => {
  const id = seed('G-OK')
  const before = rows()
  const res = await postNote(id, noteBody())
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true, queued: true })

  const feedback = db.prepare('SELECT message, source, delivered_at FROM feedback WHERE item_id = ?').all(id)
  assert.deepEqual(feedback, [{ message: NOTE, source: 'whatsapp', delivered_at: null }])
  assert.equal(itemRow(id).cursor, GATE)
  assert.equal(count('gate_decision'), before.decisions)
  const event = db.prepare('SELECT who, text FROM event WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(id)
  assert.equal(event.who, 'David via WhatsApp')
  assert.ok(event.text.startsWith('left feedback: '))
})

test('priority-via-whatsapp: 401 and 403 come before any lookup and leave the priority alone', async () => {
  const id = seed('P-LADDER')
  const before = rows()
  for (const target of ['P-NO-SUCH', id]) {
    for (const [label, secret, senderJid, status, error] of REFUSALS) {
      const res = await postPriority(target, priorityBody({ senderJid }), secret)
      assert.equal(res.statusCode, status, `${target} ${label}`)
      assert.deepEqual(res.json(), { error }, `${target} ${label}`)
      assert.ok(!res.body.includes(WA_SECRET), label)
    }
  }
  assert.equal(itemRow(id).priority, 'Medium')
  assert.deepEqual(rows(), before)
})

test('priority-via-whatsapp: a missing senderJid or a bad priority is 400', async () => {
  const id = seed('P-BAD')
  const { senderJid: _dropped, ...noJid } = priorityBody()
  for (const payload of [noJid, priorityBody({ senderJid: '' }), priorityBody({ priority: 'Urgent' }), priorityBody({ note: 'x' })]) {
    const res = await postPriority(id, payload)
    assert.equal(res.statusCode, 400, JSON.stringify(payload))
  }
  assert.equal(itemRow(id).priority, 'Medium')
})

test('priority-via-whatsapp: an unknown item is 404; a good call sets the priority', async () => {
  const missing = await postPriority('P-NO-SUCH', priorityBody())
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missing.json(), { error: 'not_found' })

  const id = seed('P-OK')
  const res = await postPriority(id, priorityBody({ priority: 'Critical' }))
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().ok, true)
  assert.equal(store.getItem(id).priority, 'Critical')
})

// Guardrail 1: the WhatsApp credential opens only the two routes above. The
// browser routes still answer a caller with no session 401 login_required.
test('/feedback and /priority with a valid WhatsApp credential and no session are still 401 login_required', async () => {
  const id = seed('B-UNCHANGED')
  const before = rows()
  for (const [url, payload] of [
    [`/api/items/${id}/feedback`, { message: NOTE, senderJid: DAVID }],
    [`/api/items/${id}/priority`, { priority: 'High', senderJid: DAVID }],
  ]) {
    const res = await inject(url, payload, WA_SECRET)
    assert.equal(res.statusCode, 401, url)
    assert.deepEqual(res.json(), { error: 'login_required' }, url)
  }
  assert.deepEqual(rows(), before)
  assert.equal(itemRow(id).priority, 'Medium')
})

test('no log line written by these calls carries the secret', () => {
  assert.ok(logs.length > 0)
  for (const line of logs) assert.ok(!String(line).includes(WA_SECRET))
})
