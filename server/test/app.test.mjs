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
const orchestrator = await import('../src/orchestrator.js')

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

// ---- abandon (HZ-59): soft delete, gated by the human gate PIN exactly like gate approval ----

db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-ABANDON-AUTH', 'PIN-gated abandon', 'Medium', 4)").run()
db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-ABANDON-HAPPY', 'Abandon happy path', 'Medium', 11)").run()
db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-ABANDON-CLOSED', 'Already closed', 'Medium', ?)").run(STEPS.length)
db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor, repo, issue) VALUES ('T-ABANDON-GH', 'Synced with GitHub', 'Medium', 4, 'acme/demo', 12)",
).run()

const abandonPost = (id, payload = {}) => inject({ method: 'POST', url: `/api/items/${id}/abandon`, payload })

test('abandon without a session cookie is 401 login_required', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/items/T-ABANDON-AUTH/abandon',
    payload: { reason: 'nope' },
  })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('abandon with a session but no gate PIN header is 401 human_gate_key_required, and nothing is written', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/items/T-ABANDON-AUTH/abandon',
    payload: { reason: 'nope' },
    headers: { cookie },
  })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
  assert.equal(db.prepare("SELECT abandoned_at FROM work_item WHERE id = 'T-ABANDON-AUTH'").get().abandoned_at, null)
})

test('abandon with a session but the wrong gate PIN is 401 human_gate_key_required — a farm/agent with DB+API access still cannot self-approve', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/items/T-ABANDON-AUTH/abandon',
    payload: { reason: 'nope' },
    headers: { cookie, 'x-human-key': 'wrong-pin' },
  })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
})

test('abandon with a missing or blank reason is rejected at the schema layer (400)', async () => {
  assert.equal((await abandonPost('T-ABANDON-AUTH', {})).statusCode, 400)
  assert.equal((await abandonPost('T-ABANDON-AUTH', { reason: '' })).statusCode, 400)
})

test('abandon on an unknown item is 404', async () => {
  const res = await abandonPost('NOPE-9', { reason: 'gone' })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'not_found' })
})

test('abandon on an already-closed item is 409 {error:closed} — abandoned is not a way to re-close delivered work', async () => {
  const res = await abandonPost('T-ABANDON-CLOSED', { reason: 'too late' })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'closed' })
})

test('abandon: 200, marks the item abandoned with the reason and the logged-in user as actor, cancels the active run, and logs an event', async () => {
  // Put T-ABANDON-HAPPY (an agent step) onto an active mock run first, so
  // this proves the run is really cancelled via /steps/cancel semantics —
  // not just that the cursor freezes.
  orchestrator.kick('T-ABANDON-HAPPY')
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'T-ABANDON-HAPPY' AND status = 'active'").get().n,
    1,
  )

  const res = await abandonPost('T-ABANDON-HAPPY', { reason: 'priorities changed' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true })

  const row = db.prepare("SELECT * FROM work_item WHERE id = 'T-ABANDON-HAPPY'").get()
  assert.ok(row.abandoned_at)
  assert.equal(row.abandoned_reason, 'priorities changed')
  assert.equal(row.abandoned_by, fixtureUser.name)
  assert.equal(row.cursor, 11, 'abandonment does not advance or reset cursor — it is not modeled as completed')

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'T-ABANDON-HAPPY' AND status = 'active'").get().n,
    0,
    'the in-flight run must be cancelled, not left to finish',
  )
  const event = db.prepare("SELECT who, text FROM event WHERE item_id = 'T-ABANDON-HAPPY' ORDER BY id DESC LIMIT 1").get()
  assert.equal(event.who, fixtureUser.name)
  assert.equal(event.text, 'abandoned this item: priorities changed')
})

test('abandoning an already-abandoned item is 409 already_abandoned', async () => {
  const res = await abandonPost('T-ABANDON-HAPPY', { reason: 'again' })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'already_abandoned' })
})

test('a fully abandoned item is never dispatched again even if kicked or resumed', async () => {
  orchestrator.kick('T-ABANDON-HAPPY')
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'T-ABANDON-HAPPY' AND status = 'active'").get().n,
    0,
  )
})

test('abandon closes the linked GitHub issue as not planned — and the DB write happens BEFORE the GitHub call, so the self-triggered issues.closed webhook is always safe', async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null
    calls.push({ url: String(url), body })
    if (String(url).endsWith('/repos/acme/demo/issues/12') && opts?.method === 'PATCH') {
      // At the instant this PATCH fires, the DB must already read abandoned —
      // proving store.abandonItem ran first, not after the GitHub call.
      assert.ok(
        db.prepare("SELECT abandoned_at FROM work_item WHERE id = 'T-ABANDON-GH'").get().abandoned_at,
        'GitHub close must not race ahead of the DB write (HZ-59 self-webhook race)',
      )
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
  }
  try {
    const res = await abandonPost('T-ABANDON-GH', { reason: 'duplicate of another item' })
    assert.equal(res.statusCode, 200)
    const patchCall = calls.find((c) => c.url.endsWith('/repos/acme/demo/issues/12'))
    assert.ok(patchCall, 'expected a PATCH to close the issue')
    assert.deepEqual(patchCall.body, { state: 'closed', state_reason: 'not_planned' })
    const event = db.prepare("SELECT text FROM event WHERE item_id = 'T-ABANDON-GH' ORDER BY id DESC LIMIT 1").get()
    assert.match(event.text, /closed issue #12 on GitHub as not planned/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('abandon still returns 200 {ok:true} when the GitHub close fails — best-effort, never blocks the abandonment', async () => {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, repo, issue) VALUES ('T-ABANDON-GH-FAIL', 'GitHub close fails', 'Medium', 4, 'acme/demo', 13)",
  ).run()
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' })
  try {
    const res = await abandonPost('T-ABANDON-GH-FAIL', { reason: 'stopping this' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true })
    assert.ok(db.prepare("SELECT abandoned_at FROM work_item WHERE id = 'T-ABANDON-GH-FAIL'").get().abandoned_at)
    const event = db.prepare("SELECT text FROM event WHERE item_id = 'T-ABANDON-GH-FAIL' ORDER BY id DESC LIMIT 1").get()
    assert.match(event.text, /could not close issue #13/)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---- HZ-92: /api/items/:id/resolve-conflicts — HTTP contract ----
// The fast path is still an Accept-gate action: same session + gate-PIN
// requirement as /reject, verified here without a real farm (FARM_URL is
// deleted at the top of this file) so a missing farm reports cleanly instead
// of hanging. The resolved/escalated behavior itself (a real farmd reply)
// is covered by server/test/orchestrator-resolve-conflicts.test.mjs.

db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor, repo, pr, pr_mergeable) VALUES ('T-CONFLICT', 'Conflicted PR', 'Medium', ?, 'acme/demo', 55, 0)",
).run(ACCEPT_GATE_INDEX)
db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-CONFLICT-NOTGATE', 'On an agent step', 'Medium', 11)",
).run()

const resolveConflictsPost = (id) => inject({ method: 'POST', url: `/api/items/${id}/resolve-conflicts`, payload: {} })

test('resolve-conflicts without a session cookie is 401 (HZ-21)', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/items/T-CONFLICT/resolve-conflicts', payload: {} })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('resolve-conflicts with a session but the wrong gate PIN is 401 human_gate_key_required', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/items/T-CONFLICT/resolve-conflicts',
    payload: {},
    headers: { cookie, 'x-human-key': 'wrong-pin' },
  })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
})

test('resolve-conflicts on an unknown item is 404 {error:not_found}', async () => {
  const res = await resolveConflictsPost('NOPE-9')
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'not_found' })
})

test('resolve-conflicts on an item not at the Accept gate is 409 {error:not_at_accept_gate}', async () => {
  const res = await resolveConflictsPost('T-CONFLICT-NOTGATE')
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'not_at_accept_gate' })
})

test('resolve-conflicts with no farm configured is 409 {error:farm_unavailable}, and the gate is untouched', async () => {
  const res = await resolveConflictsPost('T-CONFLICT')
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'farm_unavailable' })
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'T-CONFLICT'").get().cursor, ACCEPT_GATE_INDEX)
})
