// HTTP-contract tests for the feedback endpoint, driven through the real
// Fastify app via inject() — exact status codes and response bodies.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-app-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, ACCEPT_GATE_INDEX } = await import('../src/lifecycle.js')
const config = await import('../src/config.js')
const { FARM_SHARED_SECRET } = config
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')

// The seeded BF-* demo items would get kicked onto mock timers by
// orchestrator.init below — remove them so only the fixtures run.
store.purgeDemoItems()

const app = buildApp({ logger: false })

// Every /api/* route now requires a logged-in session (HZ-21); this fixture
// user's own gate PIN also stands in for the old shared human-key header.
const { user: fixtureUser, pin: fixturePin, cookie } = loginFixtureUser(auth, config)
// Every call below carries both the session cookie AND the gate PIN header —
// harmless on routes that don't check the PIN, required on the ones that do.
const inject = (opts) =>
  app.inject({ ...opts, headers: { 'x-human-key': fixturePin, ...opts.headers, cookie } })

db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-GATE', 'At a gate', 'Medium', 3)").run()
db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-AGENT', 'On agent step', 'Medium', 11)").run()
db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-CLOSED', 'Closed', 'Medium', ?)",
).run(STEPS.length)

const feedbackPost = (id, payload) =>
  inject({ method: 'POST', url: `/api/items/${id}/feedback`, payload })

test('unknown item returns 404 {error:not_found}', async () => {
  const res = await feedbackPost('NOPE-9', { message: 'hi' })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'not_found' })
})

test('closed item returns 409 {error:closed}', async () => {
  const res = await feedbackPost('T-CLOSED', { message: 'too late' })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'closed' })
})

test('schema rejects an empty, missing or over-length message', async () => {
  assert.equal((await feedbackPost('T-GATE', { message: '' })).statusCode, 400)
  assert.equal((await feedbackPost('T-GATE', { message: 'x'.repeat(2001) })).statusCode, 400)
  assert.equal((await feedbackPost('T-GATE', {})).statusCode, 400)
})

test('feedback at a gate returns {ok:true,queued:true} and stores an undelivered row', async () => {
  const res = await feedbackPost('T-GATE', { message: 'note for the next step' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, queued: true })
  const row = db.prepare("SELECT * FROM feedback WHERE item_id = 'T-GATE' ORDER BY id DESC").get()
  assert.equal(row.message, 'note for the next step')
  assert.equal(row.delivered_at, null)
})

test('feedback on a live agent step returns {ok:true,rerun:true} and re-runs it (attempt N+1)', async () => {
  // Mock mode (FARM_URL unset): init the real runner so kick() creates runs.
  const orchestrator = await import('../src/orchestrator.js')
  orchestrator.init({ info: () => {}, warn: () => {} })
  // init() resumed T-AGENT onto an active run; feedback must supersede it.
  const res = await feedbackPost('T-AGENT', { message: 'change of direction' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, rerun: true })
  const runs = db.prepare("SELECT * FROM step_run WHERE item_id = 'T-AGENT' ORDER BY id").all()
  assert.ok(runs.length >= 2, `expected a superseded run and a fresh attempt, got ${runs.length}`)
  assert.equal(runs.at(-1).status, 'active')
  assert.ok(runs.slice(0, -1).every((r) => r.status !== 'active'))
  assert.equal(runs.at(-1).attempt, runs.length)
  orchestrator.cancel('T-AGENT', 'cancelled') // don't leave the mock timer running
})

// ---- specialist persona endpoint (HZ-4) ----

const personaPost = (id, payload) => inject({ method: 'POST', url: `/api/items/${id}/persona`, payload })

test('setting a persona returns 200, persists, and the snapshot carries it', async () => {
  const res = await personaPost('T-GATE', { persona: 'python_backend' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true })
  assert.equal(db.prepare("SELECT persona FROM work_item WHERE id = 'T-GATE'").get().persona, 'python_backend')
  const snapshot = (await inject({ method: 'GET', url: '/api/items' })).json()
  assert.equal(snapshot.items.find((it) => it.id === 'T-GATE').persona, 'python_backend')
})

test('an unknown persona id is rejected at the schema layer (400)', async () => {
  assert.equal((await personaPost('T-GATE', { persona: 'rustacean' })).statusCode, 400)
  assert.equal((await personaPost('T-GATE', {})).statusCode, 400)
})

test('persona on an unknown item is 404, on a closed item 409', async () => {
  assert.equal((await personaPost('NOPE-9', { persona: 'fullstack' })).statusCode, 404)
  const closed = await personaPost('T-CLOSED', { persona: 'fullstack' })
  assert.equal(closed.statusCode, 409)
  assert.deepEqual(closed.json(), { error: 'closed' })
})

// ---- priority endpoint (HZ-7, driven by the WhatsApp concierge) ----

const priorityPost = (id, payload) => inject({ method: 'POST', url: `/api/items/${id}/priority`, payload })

test('setting a priority returns 200, persists, and the snapshot carries it', async () => {
  const res = await priorityPost('T-GATE', { priority: 'Critical' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true })
  assert.equal(db.prepare("SELECT priority FROM work_item WHERE id = 'T-GATE'").get().priority, 'Critical')
  const snapshot = (await inject({ method: 'GET', url: '/api/items' })).json()
  assert.equal(snapshot.items.find((it) => it.id === 'T-GATE').priority, 'Critical')
})

test('a bad or lowercase priority is rejected at the schema layer (400)', async () => {
  assert.equal((await priorityPost('T-GATE', { priority: 'high' })).statusCode, 400)
  assert.equal((await priorityPost('T-GATE', { priority: 'urgent' })).statusCode, 400)
  assert.equal((await priorityPost('T-GATE', {})).statusCode, 400)
})

test('priority on an unknown item is 404, on a closed item 409', async () => {
  assert.equal((await priorityPost('NOPE-9', { priority: 'High' })).statusCode, 404)
  const closed = await priorityPost('T-CLOSED', { priority: 'High' })
  assert.equal(closed.statusCode, 409)
  assert.deepEqual(closed.json(), { error: 'closed' })
})

test('a failing GitHub label mirror still returns 200 and persists', async () => {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, repo, issue) VALUES ('T-GH', 'Synced', 'Medium', 3, 'acme/demo', 7)",
  ).run()
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url))
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' }
  }
  try {
    const res = await priorityPost('T-GH', { priority: 'Low' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true })
    assert.equal(db.prepare("SELECT priority FROM work_item WHERE id = 'T-GH'").get().priority, 'Low')
    // The mirror was attempted (label ensure hits the labels API) but its
    // failure never surfaced to the client.
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(calls.some((u) => u.includes('/repos/acme/demo/labels')))
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---- gate approval (HZ-15: WhatsApp-driven approval + actor attribution) ----

db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-GATE-HK', 'Human-key approval', 'Medium', 3)",
).run()
db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-GATE-WA', 'WhatsApp approval', 'Medium', 3)",
).run()
db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-GATE-STALE', 'Stale step', 'Medium', 3)",
).run()
db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-GATE-NOTGATE', 'On an agent step', 'Medium', 11)",
).run()
db.prepare(
  'INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)',
).run('T-GATE-MERGE', 'Accept gate', 'Medium', ACCEPT_GATE_INDEX, 'acme/demo', 9, 41)
db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-GATE-FINAL', 'One approval from closed', 'Medium', ?)",
).run(STEPS.length - 1)

const approvePost = (id, stepIndex, payload = {}) =>
  inject({ method: 'POST', url: `/api/items/${id}/gates/${stepIndex}/approve`, payload })

const approveViaWhatsappPost = (id, stepIndex, payload, headers = {}) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/gates/${stepIndex}/approve-via-whatsapp`, payload, headers })

test('session route: approving a gate advances the cursor and attributes the logged-in user\'s name', async () => {
  const res = await approvePost('T-GATE-HK', 3)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, closed: false })
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'T-GATE-HK'").get().cursor, 4)
  assert.equal(
    db.prepare("SELECT decided_by FROM gate_decision WHERE item_id = 'T-GATE-HK'").get().decided_by,
    fixtureUser.name,
  )
  assert.equal(
    db.prepare("SELECT who FROM event WHERE item_id = 'T-GATE-HK' ORDER BY id DESC LIMIT 1").get().who,
    fixtureUser.name,
  )
})

test('approving the closing gate reports closed: true and advances the cursor past the last step', async () => {
  const res = await approvePost('T-GATE-FINAL', STEPS.length - 1)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, closed: true })
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'T-GATE-FINAL'").get().cursor, STEPS.length)
})

test('approving without a session cookie is 401 (HZ-21)', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/items/T-GATE-HK/gates/4/approve', payload: {} })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('approving with a session but the wrong gate PIN is 401 human_gate_key_required', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/items/T-GATE-HK/gates/4/approve',
    payload: {},
    headers: { cookie, 'x-human-key': 'wrong-pin' },
  })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
})

test('approve-via-whatsapp: 401 without the farm secret, and the gate is untouched', async () => {
  const res = await approveViaWhatsappPost('T-GATE-WA', 3, { sender: 'David' })
  assert.equal(res.statusCode, 401)
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'T-GATE-WA'").get().cursor, 3)
})

test('approve-via-whatsapp: 200, advances the cursor, and attributes the named sender', async () => {
  const res = await approveViaWhatsappPost(
    'T-GATE-WA',
    3,
    { sender: 'David', notes: 'looks good' },
    { 'x-farm-secret': FARM_SHARED_SECRET },
  )
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, closed: false })
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'T-GATE-WA'").get().cursor, 4)
  assert.equal(
    db.prepare("SELECT decided_by FROM gate_decision WHERE item_id = 'T-GATE-WA'").get().decided_by,
    'David via WhatsApp',
  )
  assert.equal(
    db.prepare("SELECT who FROM event WHERE item_id = 'T-GATE-WA' ORDER BY id DESC LIMIT 1").get().who,
    'David via WhatsApp',
  )
})

test('approve-via-whatsapp: 404 for an unknown item', async () => {
  const res = await approveViaWhatsappPost('NOPE-9', 0, { sender: 'David' }, { 'x-farm-secret': FARM_SHARED_SECRET })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'not_found' })
})

test('approve-via-whatsapp: 409 not_at_gate when the item is not currently on a gate step', async () => {
  const res = await approveViaWhatsappPost(
    'T-GATE-NOTGATE',
    11,
    { sender: 'David' },
    { 'x-farm-secret': FARM_SHARED_SECRET },
  )
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'not_at_gate' })
})

test('approve-via-whatsapp: 409 stale_step when the step index no longer matches the cursor', async () => {
  const res = await approveViaWhatsappPost('T-GATE-STALE', 1, { sender: 'David' }, { 'x-farm-secret': FARM_SHARED_SECRET })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'stale_step' })
})

test('approve-via-whatsapp: 502 when the PR merge fails, and the gate stays open', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 405,
    json: async () => ({ message: 'required checks pending' }),
    text: async () => '',
  })
  try {
    const res = await approveViaWhatsappPost(
      'T-GATE-MERGE',
      ACCEPT_GATE_INDEX,
      { sender: 'Evan' },
      { 'x-farm-secret': FARM_SHARED_SECRET },
    )
    assert.equal(res.statusCode, 502)
    assert.match(res.json().error, /merge failed/)
    assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'T-GATE-MERGE'").get().cursor, ACCEPT_GATE_INDEX)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('run-log tail reports 503 when no farm is configured', async () => {
  const res = await inject({ method: 'GET', url: '/api/runs/7/log' })
  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.json(), { error: 'farm unavailable' })
})

test('webhook endpoint reports 503 when no secret is configured', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    payload: { zen: 'ok' },
  })
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().error, 'webhooks_not_configured')
})
