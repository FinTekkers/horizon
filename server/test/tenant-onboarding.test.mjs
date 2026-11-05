// HZ-773: a fresh tenant goes from sign-up to a running first item. Their own
// project starts enabled (the owner's later ones keep HZ-207's disabled
// default), so their first item is created and dispatched instead of the
// member:repo 404. Their sign-up PIN, never shown, is revealed once through
// POST /api/auth/gate-pin/first: a login session and x-horizon-csrf only, the
// PIN in that one no-store body, never in a log or a later response. Users
// from before the gate_pin_revealed_at column count as already shown and keep
// their PINs.
//
// The DB starts as a pre-HZ-773 file holding two users with known PINs, so
// db.js's migration runs on them. Through the real app (app.inject); GitHub is
// a stubbed globalThis.fetch.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import Database from 'better-sqlite3'
import { loginFixtureUser, loginFixtureToken } from './helpers/session.mjs'

const dbPath = join(mkdtempSync(join(tmpdir(), 'horizon-tenant-onboarding-')), 'test.db')
const TOKEN_ROOT = mkdtempSync(join(tmpdir(), 'horizon-tenant-onboarding-tokens-'))
process.env.HORIZON_DB = dbPath
process.env.HORIZON_TENANT_TOKEN_ROOT = TOKEN_ROOT
for (const key of ['FARM_HOME', 'FARM_URL', 'GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES']) delete process.env[key]

// Two accounts from before HZ-773, with PINs the test knows.
const LEGACY = [
  { id: 'legacy-owner', email: 'legacy-owner@example.com', pin: '111111' },
  { id: 'legacy-tenant', email: 'legacy-tenant@example.com', pin: '222222' },
]
const hashPin = (pin) => {
  const salt = crypto.randomBytes(16)
  return `${salt.toString('hex')}:${crypto.scryptSync(pin, salt, 32).toString('hex')}`
}
{
  const legacy = new Database(dbPath)
  legacy.exec(`CREATE TABLE user (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, initials TEXT NOT NULL,
    auth_method TEXT NOT NULL CHECK (auth_method IN ('password','google')), google_sub TEXT,
    gate_pin_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT
  )`)
  const insert = legacy.prepare("INSERT INTO user (id, email, name, initials, auth_method, gate_pin_hash) VALUES (?, ?, ?, 'LU', 'password', ?)")
  for (const u of LEGACY) insert.run(u.id, u.email, u.id, hashPin(u.pin))
  legacy.close()
}

// The fake GitHub: an issue POST answers a new issue, everything else 200 [].
let nextIssue = 1
globalThis.fetch = async (url, opts = {}) => {
  const { pathname } = new URL(String(url))
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data })
  const issue = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(pathname)
  if (issue && opts.method === 'POST') {
    const body = JSON.parse(opts.body)
    const number = nextIssue++
    return reply(201, { number, title: body.title, body: body.body, state: 'open', labels: [], html_url: `https://github.com/${issue[1]}/issues/${number}` })
  }
  return reply(200, [])
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const billing = await import('../src/billing.js')
const config = await import('../src/config.js')
const { buildApp } = await import('../src/app.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

const logLines = []
const app = buildApp({
  logger: {
    level: 'trace',
    stream: new Writable({
      write(chunk, _enc, done) {
        logLines.push(chunk.toString())
        done()
      },
    }),
  },
})
await app.ready()
after(() => app.close())

const owner = loginFixtureUser(auth, config)
const FARM = store.createProject('Farm home').id
// Made before this release: a tenant project left disabled.
const OLD_TENANT = Number(db.prepare("INSERT INTO project (name, enabled, isolation) VALUES ('Old tenant', 0, 'tenant')").run().lastInsertRowid)

// The sign-up, then the Google login that adopts its row, as in production.
const TENANT_EMAIL = 'parvati@example.com'
const signup = billing.findOrCreateSignup({ name: 'Parvati Real Estate', email: TENANT_EMAIL, company: 'Parvati' })
assert.equal(auth.setAccountStatus(signup.id, 'active', 'test').ok, true)
const tenantUser = auth.findOrCreateGoogleUser({ sub: 'google-parvati', email: TENANT_EMAIL, name: 'Parvati Real Estate', emailVerified: true })
assert.equal(tenantUser.id, signup.id, 'the Google login adopted the sign-up row')
const tenantCookie = `${config.SESSION_COOKIE_NAME}=${auth.createSession(tenantUser.id)}`

const CSRF = { 'x-horizon-csrf': '1' }
const reveal = (headers) => app.inject({ method: 'POST', url: '/api/auth/gate-pin/first', headers, payload: {} })
const me = async (cookie) => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
  assert.equal(res.statusCode, 200, res.body)
  return res.json().user
}
const revealedAt = (id) => db.prepare('SELECT gate_pin_revealed_at FROM user WHERE id = ?').get(id).gate_pin_revealed_at

test("guardrail 1: the migration counts every existing user as shown, and their old PINs still verify", () => {
  for (const u of LEGACY) {
    assert.ok(revealedAt(u.id), `${u.id} back-filled`)
    assert.equal(auth.gatePinRevealPending(u.id), false)
    assert.equal(auth.verifyGatePin(u.id, u.pin), true, `${u.id}'s PIN still verifies`)
  }
  assert.ok(revealedAt(owner.user.id), 'createUser marks its PIN shown')
  assert.equal(revealedAt(tenantUser.id), null, 'a sign-up has not been shown its PIN')
})

test('guardrail 2: /auth/me says a reveal is pending, and carries no PIN', async () => {
  const user = await me(tenantCookie)
  assert.equal(user.gatePinRevealPending, true)
  assert.equal(Object.hasOwn(user, 'pin'), false)
  assert.equal((await me(owner.cookie)).gatePinRevealPending, false)
})

test('guardrail 2: no session, an API token, or a request without x-horizon-csrf is refused and changes nothing', async () => {
  const hashBefore = db.prepare('SELECT gate_pin_hash FROM user WHERE id = ?').get(tenantUser.id).gate_pin_hash
  const anon = await reveal(CSRF)
  assert.equal(anon.statusCode, 401)
  assert.deepEqual(anon.json(), { error: 'login_required' })
  const token = loginFixtureToken(auth, tenantUser)
  const byToken = await reveal({ ...token.headers, ...CSRF })
  assert.equal(byToken.statusCode, 401)
  assert.equal(Object.hasOwn(byToken.json(), 'pin'), false)
  const noCsrf = await reveal({ cookie: tenantCookie })
  assert.equal(noCsrf.statusCode, 403)
  assert.deepEqual(noCsrf.json(), { error: 'csrf_required' })
  const crossSite = await reveal({ cookie: tenantCookie, ...CSRF, origin: 'https://evil.example' })
  assert.equal(crossSite.statusCode, 403)
  assert.equal(Object.hasOwn(crossSite.json(), 'pin'), false)
  assert.equal(revealedAt(tenantUser.id), null)
  assert.equal(db.prepare('SELECT gate_pin_hash FROM user WHERE id = ?').get(tenantUser.id).gate_pin_hash, hashBefore)
})

test('metric 3 / guardrail 2: the first reveal answers a working PIN once, no-store and unlogged; later calls and the owner get 409', async () => {
  const logStart = logLines.length
  const res = await reveal({ cookie: tenantCookie, ...CSRF })
  assert.equal(res.statusCode, 200, res.body)
  const { ok, pin } = res.json()
  assert.equal(ok, true)
  assert.match(pin, /^\d{6}$/)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(auth.verifyGatePin(tenantUser.id, pin), true, 'the shown PIN is the account PIN')
  const logged = logLines.slice(logStart).join('')
  assert.ok(logged.length > 0, 'the request was logged')
  assert.doesNotMatch(logged, new RegExp(`(^|\\D)${pin}(\\D|$)`), 'the PIN is in no log line')

  const again = await reveal({ cookie: tenantCookie, ...CSRF })
  assert.equal(again.statusCode, 409)
  assert.deepEqual(again.json(), { error: 'pin_already_shown' })
  assert.equal(auth.verifyGatePin(tenantUser.id, pin), true, 'a second call changes nothing')
  const byOwner = await reveal({ cookie: owner.cookie, ...CSRF })
  assert.equal(byOwner.statusCode, 409)
  assert.equal(Object.hasOwn(byOwner.json(), 'pin'), false)

  const after = await me(tenantCookie)
  assert.equal(after.gatePinRevealPending, false)
  assert.equal(Object.hasOwn(after, 'pin'), false)
  assert.equal(auth.verifyGatePin(owner.user.id, owner.pin), true, "the owner's PIN is unchanged")
  for (const u of LEGACY) assert.equal(auth.verifyGatePin(u.id, u.pin), true, `${u.id}'s PIN is unchanged`)
})

test("metric 4: a fresh tenant's own project starts enabled, and their first item is created and dispatched to the first step", async () => {
  const created = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie: tenantCookie }, payload: { name: 'Parvati Co' } })
  assert.equal(created.statusCode, 200, created.body)
  const { id, isolation } = created.json()
  assert.equal(isolation, 'tenant')
  assert.equal(store.listProjects().find((p) => p.id === id).enabled, true)

  // What the real repo connect leaves behind: the repo row and the token file.
  const REPO = 'parvati/site'
  assert.equal(store.setTenantConnection(id, REPO, 'test').ok, true)
  writeFileSync(join(TOKEN_ROOT, String(id)), `github_pat_${'p'.repeat(60)}`)
  chmodSync(join(TOKEN_ROOT, String(id)), 0o600)

  const item = await app.inject({
    method: 'POST',
    url: '/api/items',
    headers: { cookie: tenantCookie },
    payload: { title: 'First item', outcome: 'The site has a contact page.', metric: 'The page loads.', repo: REPO },
  })
  // The route answers 200 on success (its documented status); the point is it is not the guard's 404.
  assert.equal(item.statusCode, 200, item.body)
  const itemId = item.json().id
  const enabled = store.listItems({ scope: 'enabled' }).find((it) => it.id === itemId)
  assert.ok(enabled, "the item is in the farm's enabled scope")
  assert.equal(enabled.cursor, 0, 'at the first step')
})

test("guardrail 1: the owner's later project still starts disabled, and an existing tenant project stays disabled", async () => {
  const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie: owner.cookie }, payload: { name: 'Owner second' } })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().isolation, 'internal')
  const projects = store.listProjects()
  assert.equal(projects.find((p) => p.id === res.json().id).enabled, false)
  assert.equal(projects.find((p) => p.id === FARM).enabled, true)
  assert.equal(projects.find((p) => p.id === OLD_TENANT).enabled, false)
})
