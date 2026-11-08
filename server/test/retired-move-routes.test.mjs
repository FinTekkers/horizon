// HZ-712 metric 1 and guardrail 3: the old move routes — send-back (/reject),
// restart phase, forward to Accept and gate approve — answer 410 naming
// POST /api/items/:id/move, and so does a /feedback note that would re-run a
// running agent step. A stub never reads the item (an unknown id is 410 too)
// and changes nothing: no item field, event, move log row, gate decision,
// feedback row or farm message. A note on an item at a gate still queues
// through /feedback, and approve-via-whatsapp still reaches its own handler.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-retired-move-routes-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'WA_APPROVAL_SECRET', 'WA_NOTIFY_ENABLED', 'WA_POLL_ENABLED']) delete process.env[key]

const farmCalls = []
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.startsWith('http://farm.test')) farmCalls.push(u)
  if (u.startsWith('https://api.github.com/')) return { ok: false, status: 500, headers: new Headers(), json: async () => ({}) }
  return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true }), text: async () => '{"ok":true}' }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { RETIRED_MOVE_ROUTES } = await import('../src/retiredRoutes.js')
const { stepIndexOf } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
await app.ready()
const { pin, cookie } = loginFixtureUser(auth, config)

after(() => app.close())

const insert = db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, ?, ?, ?)')
function seed(id, key) {
  insert.run(id, `Item ${id}`, 'Medium', stepIndexOf(key), 'change')
  return id
}
const post = (url, payload = {}, headers = { cookie, 'x-human-key': pin }) => app.inject({ method: 'POST', url, payload, headers })

// Each retired route with a real url for item `id` and a body its old handler took.
function calls(id) {
  return [
    { url: `/api/items/${id}/reject`, payload: { target: 'Architect', feedback: 'redo it' } },
    { url: `/api/items/${id}/phases/0/restart`, payload: { reason: 'start over' } },
    { url: `/api/items/${id}/forward-to-accept`, payload: {} },
    { url: `/api/items/${id}/gates/13/approve`, payload: { notes: 'ship it' } },
    { url: `/api/items/${id}/gates/change.accept-code/approve`, payload: { notes: 'ship it' } },
  ]
}

function snapshot(id) {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE item_id = ?`).get(id).n
  return {
    item: db.prepare('SELECT * FROM work_item WHERE id = ?').get(id),
    events: count('event'),
    moves: count('item_move'),
    gateDecisions: count('gate_decision'),
    feedback: count('feedback'),
    stepRuns: count('step_run'),
    farmCalls: farmCalls.length,
  }
}

function assertRetired(res, label) {
  assert.equal(res.statusCode, 410, `${label}: ${res.body}`)
  assert.deepEqual(res.json(), { error: 'route_retired', use: 'POST /api/items/:id/move' }, label)
}

test('the retired list names the four old move routes', () => {
  assert.deepEqual(
    RETIRED_MOVE_ROUTES.map((r) => `${r.method} ${r.url}`),
    [
      'POST /api/items/:id/reject',
      'POST /api/items/:id/phases/:phase/restart',
      'POST /api/items/:id/forward-to-accept',
      'POST /api/items/:id/gates/:step/approve',
    ],
  )
})

test('each retired route answers a member exactly 410, naming POST /api/items/:id/move', async () => {
  const id = seed('RT-1', 'change.accept-code')
  for (const { url, payload } of calls(id)) assertRetired(await post(url, payload), url)
})

test('an unknown item id is still 410, not 404 — the stub never reads the item', async () => {
  for (const { url, payload } of calls('RT-NOPE')) assertRetired(await post(url, payload), url)
})

test('an unauthenticated call is the scope check’s 401, not a 410', async () => {
  const id = seed('RT-ANON', 'change.accept-code')
  for (const { url, payload } of calls(id)) {
    const res = await post(url, payload, {})
    assert.equal(res.statusCode, 401, `${url}: ${res.body}`)
  }
})

test('a /feedback note that would re-run a running agent step answers 410 and writes nothing', async () => {
  const id = seed('RT-RERUN', 'change.implement')
  const res = await post(`/api/items/${id}/feedback`, { message: 'use the other API' })
  assertRetired(res, '/feedback re-run')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE item_id = ?').get(id).n, 0)
})

test('a /feedback note on an item at a gate still queues and is saved', async () => {
  const id = seed('RT-GATE', 'change.approve-design')
  const res = await post(`/api/items/${id}/feedback`, { message: 'mind the cache' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().queued, true)
  assert.deepEqual(
    db.prepare('SELECT message FROM feedback WHERE item_id = ?').all(id).map((r) => r.message),
    ['mind the cache'],
  )
})

test('calling every stub changes no item field, event, move, gate decision, feedback row or farm message', async () => {
  // On an agent step, so /feedback takes its re-run branch.
  const id = seed('RT-QUIET', 'change.implement')
  const before = snapshot(id)
  for (const { url, payload } of calls(id)) assertRetired(await post(url, payload), url)
  assertRetired(await post(`/api/items/${id}/feedback`, { message: 'a note that must not land' }), '/feedback')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(snapshot(id), before)
})

test('approve-via-whatsapp is not retired: it reaches its own handler', async () => {
  const id = seed('RT-WA', 'change.accept-code')
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/gates/change.accept-code/approve-via-whatsapp`,
    payload: { senderJid: '447700900000@s.whatsapp.net', sender: 'Owner' },
  })
  // No WA_APPROVAL_SECRET on this host: its own fail-closed answer.
  assert.equal(res.statusCode, 503, res.body)
  assert.equal(res.json().error, 'wa_approval_not_configured')
})
