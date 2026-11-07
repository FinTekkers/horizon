// HZ-786: POST /api/items/:id/retry-via-whatsapp — a WhatsApp note on a
// running agent step re-runs that step through store.moveByHuman Retry, the
// same path the UI's /move Retry takes. The 401 and 403 rungs of the caller
// ladder run before any lookup and write nothing; a stale or not-running item
// is refused with 409 and writes nothing; a good call writes one item_move
// retry row and one feedback row carrying the note. The 503 rung is in
// wa-approval-unconfigured.test.mjs, where WA_APPROVAL_SECRET is unset.
//
// Its own file because config.js reads the environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-wa-retry-')), 'test.db')
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
const app = buildApp({ logger: false })
await app.ready()

after(async () => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
  await app.close()
})

const DAVID = '15550001111@s.whatsapp.net'
const STRANGER = '19998887777@s.whatsapp.net'
const AGENT_KEY = 'change.draft-plan'
const GATE_KEY = 'change.approve-design'
assert.equal(STEPS[stepIndexOf(AGENT_KEY)].kind, 'agent')
assert.equal(STEPS[stepIndexOf(GATE_KEY)].kind, 'gate')

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, paused, abandoned_at) VALUES (?, ?, ?, ?, ?, ?)')
const insertRun = db.prepare("INSERT INTO step_run (item_id, step_index, agent, status) VALUES (?, ?, 'Eng', 'active')")
// An item at `key`, with an active run there unless `running` is false.
function seed(id, key, { running = true, paused = 0, abandoned = null, cursor = stepIndexOf(key) } = {}) {
  insertItem.run(id, `Retry fixture ${id}`, 'Medium', cursor, paused, abandoned)
  if (running) insertRun.run(id, cursor)
  return id
}

// The exact key set the concierge sends (farm/concierge_agent.py
// _retry_via_whatsapp), so the two halves cannot drift apart unnoticed.
const body = (from, note = 'use the shorter copy, please!\nand keep the tests') => ({
  senderJid: DAVID,
  sender: 'David',
  from,
  note,
})
const post = (id, payload, secret = WA_SECRET) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/retry-via-whatsapp`,
    payload,
    headers: secret == null ? {} : { 'x-wa-approval-secret': secret },
  })

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
const rows = () => ({ moves: count('item_move'), feedback: count('feedback'), events: count('event') })

test('the route is reachable with no session: the ladder answers, not the login gate', async () => {
  const res = await post('R-NOSESSION', body(AGENT_KEY), 'wrong')
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'bad_approval_secret' })
})

test('401 and 403 come before any lookup and write no row', async () => {
  const id = seed('R-LADDER', AGENT_KEY)
  const before = rows()
  for (const secret of [null, 'wrong', 'farm-shared-secret-for-tests']) {
    const res = await post(id, body(AGENT_KEY), secret)
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: 'bad_approval_secret' })
  }
  const stranger = await post(id, { ...body(AGENT_KEY), senderJid: STRANGER })
  assert.equal(stranger.statusCode, 403)
  assert.deepEqual(stranger.json(), { error: 'sender_not_allowed' })
  // 403 for an unknown item too: a refused sender learns nothing about ids.
  const unknown = await post('R-NO-SUCH', { ...body(AGENT_KEY), senderJid: STRANGER })
  assert.equal(unknown.statusCode, 403)
  assert.deepEqual(rows(), before)
})

test('an unknown item is 404 for an allowed sender', async () => {
  const res = await post('R-NO-SUCH', body(AGENT_KEY))
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'not_found' })
})

test('a key outside the concierge payload is refused with 400', async () => {
  const id = seed('R-EXTRA', AGENT_KEY)
  const before = rows()
  const res = await post(id, { ...body(AGENT_KEY), to: GATE_KEY })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(rows(), before)
})

test('a blank note is refused with 400 and writes no row', async () => {
  const id = seed('R-BLANK', AGENT_KEY)
  const before = rows()
  const res = await post(id, body(AGENT_KEY, '  \n '))
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { error: 'note_required' })
  assert.deepEqual(rows(), before)
})

test('stale_step: a `from` the item has left is 409 and writes no row', async () => {
  const id = seed('R-STALE', AGENT_KEY)
  const before = rows()
  const res = await post(id, body(GATE_KEY))
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'stale_step' })
  assert.deepEqual(rows(), before)
})

test('not_running_step: a gate, a queued, a paused, an abandoned and a closed item write no row', async () => {
  const cases = [
    seed('R-GATE', GATE_KEY, { running: false }),
    seed('R-QUEUED', AGENT_KEY, { running: false }),
    seed('R-PAUSED', AGENT_KEY, { paused: 1 }),
    seed('R-ABANDONED', AGENT_KEY, { abandoned: '2026-11-01 00:00:00' }),
  ]
  const before = rows()
  for (const id of cases) {
    const from = id === 'R-GATE' ? GATE_KEY : AGENT_KEY
    const res = await post(id, body(from))
    assert.equal(res.statusCode, 409, id)
    assert.deepEqual(res.json(), { error: 'not_running_step' }, id)
  }
  // Closed, with a leftover active run: its step key is 'closed'.
  const closed = seed('R-CLOSED', AGENT_KEY, { cursor: stepIndexOf('change.review-close') + 1 })
  const res = await post(closed, body('closed'))
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'not_running_step' })
  assert.deepEqual(rows(), before)
})

test('a good call re-runs the step: one retry move row and one feedback row with the note', async () => {
  const id = seed('R-OK', AGENT_KEY)
  const note = 'use the shorter copy, please!\nand keep the tests'
  const res = await post(id, body(AGENT_KEY, note))
  assert.equal(res.statusCode, 200, res.body)
  const answer = res.json()
  assert.equal(answer.ok, true)
  assert.equal(answer.move.action, 'retry')
  assert.equal(answer.move.fromKey, AGENT_KEY)
  assert.equal(answer.move.toKey, AGENT_KEY)
  assert.equal(answer.move.who, 'David via WhatsApp')

  const moves = db.prepare('SELECT who, from_key, to_key, action, note FROM item_move WHERE item_id = ?').all(id)
  assert.deepEqual(moves, [{ who: 'David via WhatsApp', from_key: AGENT_KEY, to_key: AGENT_KEY, action: 'retry', note }])
  const feedback = db.prepare('SELECT message, step_key FROM feedback WHERE item_id = ?').all(id)
  assert.deepEqual(feedback, [{ message: note, step_key: AGENT_KEY }])
  assert.equal(db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor, stepIndexOf(AGENT_KEY))
})
