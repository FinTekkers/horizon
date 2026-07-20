// HTTP-contract tests for the feedback endpoint, driven through the real
// Fastify app via inject() — exact status codes and response bodies.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-app-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { STEPS } = await import('../src/lifecycle.js')
const store = await import('../src/store.js')

// The seeded BF-* demo items would get kicked onto mock timers by
// orchestrator.init below — remove them so only the fixtures run.
store.purgeDemoItems()

const app = buildApp({ logger: false })

db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-GATE', 'At a gate', 'Medium', 3)").run()
db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-AGENT', 'On agent step', 'Medium', 11)").run()
db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-CLOSED', 'Closed', 'Medium', ?)",
).run(STEPS.length)

const feedbackPost = (id, payload) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/feedback`, payload })

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

const personaPost = (id, payload) => app.inject({ method: 'POST', url: `/api/items/${id}/persona`, payload })

test('setting a persona returns 200, persists, and the snapshot carries it', async () => {
  const res = await personaPost('T-GATE', { persona: 'python_backend' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true })
  assert.equal(db.prepare("SELECT persona FROM work_item WHERE id = 'T-GATE'").get().persona, 'python_backend')
  const snapshot = (await app.inject({ method: 'GET', url: '/api/items' })).json()
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

test('webhook endpoint reports 503 when no secret is configured', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    payload: { zen: 'ok' },
  })
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().error, 'webhooks_not_configured')
})
