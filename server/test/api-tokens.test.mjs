// HZ-179: personal API tokens, driven through the real Fastify app.
//
// One test per success-metric line and guardrail: create/list (shown once,
// list never carries the secret), bearer access and its four 401 cases,
// revoke, attribution, the gate routes refusing a token with OR without the
// PIN, token management needing a browser session, the exempt prefixes keeping
// their own credentials, and the raw value never reaching a log line or the DB.
//
// Its own file because config.js reads WA_APPROVAL_SECRET at import time.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-api-tokens-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
// Without these approve-via-whatsapp answers 503 before it ever looks at a
// credential, and a "token gets 401 there" test would be written against the
// wrong code.
process.env.WA_APPROVAL_SECRET = 'wa-approval-secret-for-api-tokens-test'
process.env.WA_APPROVER_JIDS = '15550001111@s.whatsapp.net'
process.env.FARM_SHARED_SECRET = 'farm-shared-secret-for-api-tokens-test'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })

const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
const bob = loginFixtureUser(auth, config, { email: 'bob@example.com', name: 'Bob Example' })

const GATE_INDEX = STEPS.findIndex((s) => s.kind === 'gate')
for (const id of ['TOK-GATE-SESSION', 'TOK-GATE-TOKEN', 'TOK-DEP-1', 'TOK-DEP-2']) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, 'Medium', ?)").run(id, `API token fixture ${id}`, GATE_INDEX)
}
// A conflicted PR at the Accept gate: what resolve-conflicts would act on if
// the caller got past the PIN check.
db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor, repo, pr, pr_mergeable) VALUES ('TOK-CONFLICT', 'API token fixture TOK-CONFLICT', 'Medium', ?, 'FinTekkers/horizon', 501, 0)",
).run(ACCEPT_GATE_INDEX)

const bearer = (token) => ({ authorization: `Bearer ${token}` })

async function createToken(user, payload = { name: 'ci-bot' }) {
  return app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie: user.cookie }, payload })
}

async function newToken(user, name = 'ci-bot', extra = {}) {
  const res = await createToken(user, { name, ...extra })
  assert.equal(res.statusCode, 201, res.body)
  return res.json()
}

const getItems = (headers) => app.inject({ method: 'GET', url: '/api/items', headers })

// ---- metric 1: create, shown once, list shows only the safe fields ----

test('POST /api/tokens returns the raw hz_ token once; GET lists exactly the safe fields', async () => {
  const res = await createToken(alice, { name: 'list-check' })
  assert.equal(res.statusCode, 201)
  const created = res.json()
  assert.match(created.token, /^hz_[A-Za-z0-9_-]{43}$/)
  assert.equal(created.last4, created.token.slice(-4))
  assert.equal(created.name, 'list-check')

  const list = await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie: alice.cookie } })
  assert.equal(list.statusCode, 200)
  const entry = list.json().tokens.find((t) => t.id === created.id)
  assert.deepEqual(Object.keys(entry).sort(), ['createdAt', 'expiresAt', 'id', 'last4', 'lastUsedAt', 'name'])
  assert.equal(entry.last4, created.token.slice(-4))
  assert.equal(entry.createdAt, created.createdAt)
  assert.equal(entry.expiresAt, created.expiresAt)
  assert.equal(list.body.includes(created.token), false, 'the list response carries the raw token')
  assert.equal(list.body.includes(created.token.slice(3, -4)), false, 'the list response carries part of the secret')
})

test('lastUsedAt is null after create and set after the token is used', async () => {
  const created = await newToken(alice, 'last-used')
  const listed = async () =>
    (await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie: alice.cookie } })).json().tokens.find((t) => t.id === created.id)
  assert.equal((await listed()).lastUsedAt, null)
  assert.equal((await getItems(bearer(created.token))).statusCode, 200)
  const lastUsedAt = (await listed()).lastUsedAt
  assert.match(lastUsedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test('expiry defaults to 90 days, allows 365, and rejects 366, 0 and 1.5 with a validation body', async () => {
  const dflt = await newToken(alice, 'default')
  assert.equal((Date.parse(dflt.expiresAt) - Date.parse(dflt.createdAt)) / 86_400_000, 90)
  const max = await newToken(alice, 'max', { expiresInDays: 365 })
  assert.equal((Date.parse(max.expiresAt) - Date.parse(max.createdAt)) / 86_400_000, 365)

  for (const expiresInDays of [366, 0, 1.5]) {
    const res = await createToken(alice, { name: 'bad-expiry', expiresInDays })
    assert.equal(res.statusCode, 400, `expiresInDays ${expiresInDays}`)
    const body = res.json()
    assert.equal(body.statusCode, 400)
    assert.equal(body.error, 'Bad Request')
    assert.match(body.message, /expiresInDays/)
  }
})

test('a missing, empty, blank, over-long or control-character name is rejected with a validation body', async () => {
  for (const payload of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(61) }, { name: 'line\nbreak' }, { name: 'tab\there' }]) {
    const res = await createToken(alice, payload)
    assert.equal(res.statusCode, 400, JSON.stringify(payload))
    const body = res.json()
    assert.equal(body.statusCode, 400)
    assert.equal(body.error, 'Bad Request')
    assert.equal(typeof body.message, 'string')
  }
  assert.equal((await createToken(alice, { name: 'x'.repeat(60) })).statusCode, 201)
})

// ---- metric 2: bearer access, and the four 401 cases ----

test('a valid bearer token reads GET /api/items with no cookie', async () => {
  const { token } = await newToken(alice)
  const res = await getItems(bearer(token))
  assert.equal(res.statusCode, 200)
  assert.ok(Array.isArray(res.json().items))
})

test('an expired token gets 401 invalid_token', async () => {
  const created = await newToken(alice, 'expiring')
  assert.equal((await getItems(bearer(created.token))).statusCode, 200, 'positive control')
  db.prepare('UPDATE api_token SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), created.id)
  const res = await getItems(bearer(created.token))
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'invalid_token' })
})

test('a revoked token gets 401 invalid_token', async () => {
  const created = await newToken(alice, 'to-revoke')
  assert.equal((await getItems(bearer(created.token))).statusCode, 200, 'positive control')
  auth.revokeApiToken(alice.user.id, created.id)
  const res = await getItems(bearer(created.token))
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'invalid_token' })
})

test('a malformed token gets 401 invalid_token', async () => {
  for (const value of ['abc', 'hz_short', `hz_${'A'.repeat(44)}`]) {
    const res = await getItems(bearer(value))
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: 'invalid_token' })
  }
})

test('an unknown well-formed token gets 401 invalid_token', async () => {
  const res = await getItems(bearer(`hz_${'Q'.repeat(43)}`))
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'invalid_token' })
})

// ---- metric 3: revoke through the API, next request fails ----

test('DELETE /api/tokens/:id revokes: the next bearer request gets 401 and the list drops it', async () => {
  const created = await newToken(alice, 'revoke-me')
  assert.equal((await getItems(bearer(created.token))).statusCode, 200, 'positive control')
  const del = await app.inject({ method: 'DELETE', url: `/api/tokens/${created.id}`, headers: { cookie: alice.cookie } })
  assert.equal(del.statusCode, 200)
  assert.deepEqual(del.json(), { ok: true })

  const after = await getItems(bearer(created.token))
  assert.equal(after.statusCode, 401)
  assert.deepEqual(after.json(), { error: 'invalid_token' })
  const list = await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie: alice.cookie } })
  assert.equal(list.json().tokens.some((t) => t.id === created.id), false)
})

test('another user cannot revoke or see your token', async () => {
  const created = await newToken(alice, 'alice-only')
  const del = await app.inject({ method: 'DELETE', url: `/api/tokens/${created.id}`, headers: { cookie: bob.cookie } })
  assert.equal(del.statusCode, 404)
  assert.deepEqual(del.json(), { error: 'token_not_found' })
  assert.equal((await getItems(bearer(created.token))).statusCode, 200)
  const bobs = await app.inject({ method: 'GET', url: '/api/tokens', headers: { cookie: bob.cookie } })
  assert.equal(bobs.json().tokens.some((t) => t.id === created.id), false)
})

test('revoking an unknown id is 404 token_not_found', async () => {
  const res = await app.inject({ method: 'DELETE', url: '/api/tokens/tok_nope', headers: { cookie: alice.cookie } })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'token_not_found' })
})

// ---- metric 4: attribution ----

test('an action taken with a token is attributed to its user, with the token name', async () => {
  const { token } = await newToken(alice, 'deps-bot')
  const res = await app.inject({
    method: 'POST',
    url: '/api/items/TOK-DEP-1/dependencies',
    headers: bearer(token),
    payload: { dependsOnId: 'TOK-DEP-2' },
  })
  assert.equal(res.statusCode, 200, res.body)
  const items = (await getItems(bearer(token))).json().items
  const event = items.find((i) => i.id === 'TOK-DEP-1').events[0]
  assert.equal(event.who, 'Alice Example (token: deps-bot)')
  assert.match(event.text, /added a dependency on TOK-DEP-2/)
})

// ---- metric 5: gates refuse a token, with or without the PIN ----

const GATE_ROUTES = [
  { label: 'approve', url: `/api/items/TOK-GATE-TOKEN/gates/${GATE_INDEX}/approve`, payload: {} },
  { label: 'reject', url: '/api/items/TOK-GATE-TOKEN/reject', payload: { feedback: 'no' } },
  { label: 'resolve-conflicts', url: '/api/items/TOK-CONFLICT/resolve-conflicts', payload: {} },
]

test('positive control: a session with the PIN approves, so the token-with-PIN 401 below is not a wrong PIN', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/TOK-GATE-SESSION/gates/${GATE_INDEX}/approve`,
    headers: { cookie: alice.cookie, 'x-human-key': alice.pin },
    payload: {},
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(store.getItem('TOK-GATE-SESSION').cursor, GATE_INDEX + 1)
})

test('a valid token WITHOUT the PIN gets 401 human_gate_key_required on approve, reject and resolve-conflicts', async () => {
  const { token } = await newToken(alice, 'gate-no-pin')
  for (const route of GATE_ROUTES) {
    const res = await app.inject({ method: 'POST', url: route.url, headers: bearer(token), payload: route.payload })
    assert.equal(res.statusCode, 401, route.label)
    assert.deepEqual(res.json(), { error: 'human_gate_key_required' }, route.label)
  }
  assert.equal(store.getItem('TOK-GATE-TOKEN').cursor, GATE_INDEX)
})

test('a valid token WITH the correct PIN still gets 401 on approve, reject and resolve-conflicts', async () => {
  const { token } = await newToken(alice, 'gate-with-pin')
  for (const route of GATE_ROUTES) {
    const res = await app.inject({
      method: 'POST',
      url: route.url,
      headers: { ...bearer(token), 'x-human-key': alice.pin },
      payload: route.payload,
    })
    assert.equal(res.statusCode, 401, route.label)
    assert.deepEqual(res.json(), { error: 'human_gate_key_required' }, route.label)
  }
  assert.equal(store.getItem('TOK-GATE-TOKEN').cursor, GATE_INDEX, 'the gate moved')
})

test('a token with the PIN gets 401 on the other human-gated routes too', async () => {
  const { token } = await newToken(alice, 'other-gates')
  const headers = { ...bearer(token), 'x-human-key': alice.pin }
  for (const [method, url, payload] of [
    ['POST', '/api/items/TOK-GATE-TOKEN/phases/0/restart', {}],
    ['POST', '/api/items/TOK-GATE-TOKEN/abandon', { reason: 'nope' }],
    ['PUT', '/api/definitions/role/pm', { content: 'x' }],
  ]) {
    const res = await app.inject({ method, url, headers, payload })
    assert.equal(res.statusCode, 401, url)
    assert.deepEqual(res.json(), { error: 'human_gate_key_required' }, url)
  }
})

test('a token gets 401 on approve-via-whatsapp, with or without the PIN', async () => {
  const { token } = await newToken(alice, 'wa')
  const url = `/api/items/TOK-GATE-TOKEN/gates/${GATE_INDEX}/approve-via-whatsapp`
  const payload = { senderJid: '15550001111@s.whatsapp.net' }
  for (const headers of [bearer(token), { ...bearer(token), 'x-human-key': alice.pin }]) {
    const res = await app.inject({ method: 'POST', url, headers, payload })
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: 'bad_approval_secret' })
  }
  assert.equal(store.getItem('TOK-GATE-TOKEN').cursor, GATE_INDEX)
})

// ---- guardrail: token management and the PIN need a browser session ----

test('a token cannot create, list or revoke tokens (403 session_required)', async () => {
  const created = await newToken(alice, 'self-manage')
  for (const [method, url, payload] of [
    ['POST', '/api/tokens', { name: 'minted-by-token' }],
    ['GET', '/api/tokens', undefined],
    ['DELETE', `/api/tokens/${created.id}`, undefined],
  ]) {
    const res = await app.inject({ method, url, headers: bearer(created.token), payload })
    assert.equal(res.statusCode, 403, `${method} ${url}`)
    assert.deepEqual(res.json(), { error: 'session_required' })
  }
  assert.equal((await getItems(bearer(created.token))).statusCode, 200, 'the DELETE must not have revoked it')
  assert.equal(auth.listApiTokens(alice.user.id).some((t) => t.name === 'minted-by-token'), false)
})

test('the token routes with no credential at all are 401 login_required', async () => {
  for (const [method, url, payload] of [
    ['POST', '/api/tokens', { name: 'anon' }],
    ['GET', '/api/tokens', undefined],
    ['DELETE', '/api/tokens/tok_x', undefined],
  ]) {
    const res = await app.inject({ method, url, payload })
    assert.equal(res.statusCode, 401, `${method} ${url}`)
    assert.deepEqual(res.json(), { error: 'login_required' })
  }
})

test('a token cannot regenerate the gate PIN', async () => {
  const { token } = await newToken(alice, 'pin-regen')
  const res = await app.inject({ method: 'POST', url: '/api/auth/gate-pin/regenerate', headers: bearer(token) })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'login_required' })
  assert.ok(auth.verifyGatePin(alice.user.id, alice.pin), 'the PIN changed')
})

// ---- guardrail: session-cookie auth is unchanged ----

test('no cookie and no Authorization, or an unknown cookie, is still 401 login_required', async () => {
  for (const headers of [{}, { cookie: `${config.SESSION_COOKIE_NAME}=not-a-session` }, { authorization: 'Basic YTpi' }]) {
    const res = await getItems(headers)
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: 'login_required' })
  }
})

test('a valid session wins over a garbage bearer; a stale cookie falls through to a valid bearer', async () => {
  assert.equal((await getItems({ cookie: alice.cookie, ...bearer('garbage') })).statusCode, 200)
  const { token } = await newToken(alice, 'fallthrough')
  assert.equal((await getItems({ cookie: `${config.SESSION_COOKIE_NAME}=stale`, ...bearer(token) })).statusCode, 200)
})

// ---- guardrail: the exempt prefixes keep their own credentials ----

test('/api/farm/*, /api/webhooks/* and /api/wa/* answer a bearer token exactly as they answer nothing', async () => {
  const { token } = await newToken(alice, 'exempt')
  for (const [method, url, payload] of [
    ['GET', '/api/farm/snapshot', undefined],
    ['POST', '/api/webhooks/github', { zen: 'ok' }],
    ['POST', '/api/wa/poll-vote', { voteId: 'v', pollMessageId: 'p', voterJid: '15550001111@s.whatsapp.net', selectedOption: 'Approve' }],
  ]) {
    const none = await app.inject({ method, url, payload })
    const withToken = await app.inject({ method, url, payload, headers: bearer(token) })
    assert.notEqual(none.statusCode, 200, `${url} accepted no credential at all`)
    assert.equal(withToken.statusCode, none.statusCode, url)
    assert.equal(withToken.body, none.body, url)
  }
})

// ---- guardrail: the raw value is never logged or persisted ----

test('the raw token never reaches a log line or the database', async () => {
  const lines = []
  const logged = buildApp({ logger: { level: 'trace', stream: { write: (line) => lines.push(line) } } })
  await logged.ready()
  try {
    const create = await logged.inject({ method: 'POST', url: '/api/tokens', headers: { cookie: alice.cookie }, payload: { name: 'log-check' } })
    assert.equal(create.statusCode, 201)
    const { token } = create.json()
    assert.equal((await logged.inject({ method: 'GET', url: '/api/items', headers: bearer(token) })).statusCode, 200)
    const unknown = `hz_${'Z'.repeat(43)}`
    assert.equal((await logged.inject({ method: 'GET', url: '/api/items', headers: bearer(unknown) })).statusCode, 401)
    assert.equal(
      (await logged.inject({ method: 'POST', url: '/api/tokens', headers: { cookie: alice.cookie, ...bearer(token) }, payload: { name: '' } })).statusCode,
      400,
    )

    assert.ok(lines.length >= 4, `only ${lines.length} log lines captured — the capture is not wired`)
    const all = lines.join('')
    assert.equal(all.includes(token), false, 'the raw token was logged')
    assert.equal(all.includes(unknown), false, 'a presented bearer value was logged')

    const rows = db.prepare('SELECT * FROM api_token').all()
    assert.ok(rows.length > 0)
    assert.equal(JSON.stringify(rows).includes(token), false, 'the raw token is in api_token')
    assert.equal(JSON.stringify(rows).includes(token.slice(3, -4)), false, 'the secret part is in api_token')
  } finally {
    await logged.close()
  }
})
