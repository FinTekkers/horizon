// HZ-654: a user removed from ALLOWED_LOGIN_EMAILS is disabled, not deleted.
// Its row stays; its new sign-in, existing session and API token are refused
// through the real routes. By the owner's ruling of 30 Oct, re-enabling never
// brings old credentials back: sessions and tokens issued before the disable
// stay refused, and the user signs in afresh. Clock edges are pinned by
// writing created_at directly, never by sleeping.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-disabled-user-')), 'test.db')
process.env.ADMIN_EMAIL = 'admin@example.com'
process.env.ADMIN_PASSWORD = 'super-secret'
process.env.GOOGLE_CLIENT_ID = 'test-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
process.env.ALLOWED_LOGIN_EMAILS = 'gone@example.com,back@example.com,edge@example.com'
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { buildApp } = await import('../src/app.js')
const { googleAuth } = await import('../src/googleAuth.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { db } = await import('../src/db.js')
const { reconcileGoogleUsers } = await import('../src/loginAllowlist.js')
const { disableUser, enableUser } = await import('../src/membership.js')

const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const cookieOf = (token) => `${config.SESSION_COOKIE_NAME}=${token}`
const sessionStatus = async (token) =>
  (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: cookieOf(token) } })).statusCode
const tokenStatus = async (raw) =>
  (await app.inject({ method: 'GET', url: '/api/items', headers: { authorization: `Bearer ${raw}` } })).statusCode
const userRow = (id) => db.prepare('SELECT * FROM user WHERE id = ?').get(id)
const sessionCount = (userId) => db.prepare('SELECT COUNT(*) AS n FROM session WHERE user_id = ?').get(userId).n

function tableCounts() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]))
}

// Runs fn (sync or async) with only `emails` allowlisted, then restores the list.
async function withAllowlist(emails, fn) {
  const saved = new Set(config.ALLOWED_LOGIN_EMAILS)
  config.ALLOWED_LOGIN_EMAILS.clear()
  for (const email of emails) config.ALLOWED_LOGIN_EMAILS.add(email)
  try {
    return await fn()
  } finally {
    config.ALLOWED_LOGIN_EMAILS.clear()
    for (const email of saved) config.ALLOWED_LOGIN_EMAILS.add(email)
  }
}

// The real callback with Google's code exchange stubbed at its module boundary.
async function googleSignIn(profile) {
  const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  const state = start.cookies.find((c) => c.name === 'oauth_state').value
  const real = googleAuth.exchangeCodeForProfile
  googleAuth.exchangeCodeForProfile = async () => ({ emailVerified: true, ...profile })
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=c&state=${state}`,
      headers: { cookie: `oauth_state=${state}` },
    })
    return { status: res.statusCode, location: res.headers.location, session: res.cookies.find((c) => c.name === config.SESSION_COOKIE_NAME)?.value }
  } finally {
    googleAuth.exchangeCodeForProfile = real
  }
}

// ---- metric 3: removed from the allowlist -> disabled, and refused everywhere ----

test('a user removed from the allowlist keeps its row and gets disabled_at; its session, token and new sign-in are refused', async () => {
  const profile = { sub: 'sub-gone', email: 'gone@example.com', name: 'Gone' }
  const first = await googleSignIn(profile)
  assert.equal(first.location, config.UI_URL, 'sanity: an allowlisted sign-in works')
  const user = auth.findUserByGoogleSub('sub-gone')
  const token = auth.createApiToken(user.id, 'script').token
  assert.equal(await sessionStatus(first.session), 200)
  assert.equal(await tokenStatus(token), 200)

  const before = tableCounts()
  await withAllowlist(['back@example.com', 'edge@example.com'], () => reconcileGoogleUsers(db))
  const afterCounts = tableCounts()
  for (const [table, n] of Object.entries(before)) {
    assert.equal(afterCounts[table], table === 'user_event' ? n + 1 : n, `${table} row count`)
  }

  assert.equal(userRow(user.id).email, 'gone@example.com', 'the row is kept')
  assert.ok(userRow(user.id).disabled_at, 'disabled_at is set')
  const sessionRes = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: cookieOf(first.session) } })
  assert.deepEqual([sessionRes.statusCode, sessionRes.json()], [401, { error: 'login_required' }])
  const tokenRes = await app.inject({ method: 'GET', url: '/api/items', headers: { authorization: `Bearer ${token}` } })
  assert.deepEqual([tokenRes.statusCode, tokenRes.json()], [401, { error: 'invalid_token' }])

  const sessions = sessionCount(user.id)
  const offList = await withAllowlist(['back@example.com'], () => googleSignIn(profile))
  // HZ-635: every not-allowlisted-or-unpaid refusal shares this one code.
  assert.equal(offList.location, `${config.UI_URL}/?error=subscription_inactive`)
  assert.equal(offList.session, undefined)

  // Still disabled while the address is back on the list but not yet reconciled.
  const disabled = await googleSignIn(profile)
  assert.equal(disabled.status, 302)
  assert.equal(disabled.location, `${config.UI_URL}/?error=google_link_blocked`)
  assert.equal(disabled.session, undefined, 'no session cookie')
  assert.equal(sessionCount(user.id), sessions, 'no new session row')
})

test('a disabled password account is refused at POST /api/auth/login', async () => {
  const login = () => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.com', password: 'super-secret' } })
  assert.equal((await login()).statusCode, 200)
  const admin = auth.findUserByEmail('admin@example.com')
  disableUser(db, admin.id, 'test')
  try {
    const res = await login()
    assert.deepEqual([res.statusCode, res.json()], [401, { error: 'invalid_credentials' }])
  } finally {
    enableUser(db, admin.id, 'test')
  }
})

// ---- ruling 7 / O5: re-enable keeps old credentials dead ----

test('after re-enable, credentials from before the disable stay refused in both timestamp formats; ones at or after the cutoff and a fresh sign-in work', async () => {
  const profile = { sub: 'sub-back', email: 'back@example.com', name: 'Back' }
  const user = auth.findOrCreateGoogleUser({ ...profile, emailVerified: true })
  // A disable at .400 of a whole second, a minute ago; its cutoff is the next second.
  const disabledAt = Math.floor((Date.now() - 60_000) / 1000) * 1000 + 400
  const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
  const isoTime = (ms) => new Date(ms).toISOString()
  const session = (createdAt) => {
    const token = auth.createSession(user.id)
    db.prepare('UPDATE session SET created_at = ? WHERE id = ?').run(createdAt, sha256(token))
    return token
  }
  const apiToken = (createdAt) => {
    const created = auth.createApiToken(user.id, `t-${createdAt}`)
    db.prepare('UPDATE api_token SET created_at = ? WHERE id = ?').run(createdAt, created.id)
    return created.token
  }
  const old = {
    sessionSameSecond: session(sqlTime(disabledAt)), // second precision: same second as the disable
    sessionEarlier: session(sqlTime(disabledAt - 5000)),
    tokenMsBefore: apiToken(isoTime(disabledAt - 300)), // milliseconds before, same second
    tokenEarlier: apiToken(isoTime(disabledAt - 5000)),
  }
  const atCutoff = { session: session(sqlTime(disabledAt + 600)), token: apiToken(isoTime(disabledAt + 600)) }
  for (const t of [old.sessionSameSecond, old.sessionEarlier]) assert.equal(await sessionStatus(t), 200, 'sanity: works before the disable')
  for (const t of [old.tokenMsBefore, old.tokenEarlier]) assert.equal(await tokenStatus(t), 200, 'sanity: works before the disable')

  assert.equal(disableUser(db, user.id, 'test', { now: disabledAt }), true)
  assert.equal(userRow(user.id).credentials_valid_after, isoTime(disabledAt + 600))
  assert.equal(await sessionStatus(atCutoff.session), 401, 'everything is refused while disabled')
  assert.equal(await tokenStatus(atCutoff.token), 401)

  await withAllowlist(['back@example.com'], () => reconcileGoogleUsers(db))
  assert.equal(userRow(user.id).disabled_at, null, 're-enabled by the allowlist')
  assert.equal(userRow(user.id).credentials_valid_after, isoTime(disabledAt + 600), 'the cutoff never moves back')

  for (const t of [old.sessionSameSecond, old.sessionEarlier]) assert.equal(await sessionStatus(t), 401)
  for (const t of [old.tokenMsBefore, old.tokenEarlier]) assert.equal(await tokenStatus(t), 401)
  assert.equal(await sessionStatus(atCutoff.session), 200, 'a session created at the cutoff works')
  assert.equal(await tokenStatus(atCutoff.token), 200, 'a token created at the cutoff works')

  const fresh = await googleSignIn(profile)
  assert.equal(fresh.location, config.UI_URL)
  assert.equal(await sessionStatus(fresh.session), 200, 'a fresh sign-in works')
  assert.equal(await tokenStatus(auth.createApiToken(user.id, 'fresh').token), 200, 'a fresh token works')
  assert.deepEqual(
    db.prepare('SELECT kind FROM user_event WHERE user_id = ? ORDER BY id').all(user.id).map((e) => e.kind),
    ['disabled', 'enabled'],
  )
})

test('disabling an already disabled user writes nothing and never moves the cutoff back', () => {
  const user = auth.findOrCreateGoogleUser({ sub: 'sub-edge', email: 'edge@example.com', name: 'Edge', emailVerified: true })
  const later = Date.now() + 10_000
  disableUser(db, user.id, 'test', { now: later })
  const row = userRow(user.id)
  const events = db.prepare('SELECT COUNT(*) AS n FROM user_event WHERE user_id = ?').get(user.id).n
  assert.equal(disableUser(db, user.id, 'test', { now: later - 60_000 }), false)
  assert.deepEqual(userRow(user.id), row)
  enableUser(db, user.id, 'test')
  disableUser(db, user.id, 'test', { now: later - 60_000 })
  assert.equal(userRow(user.id).credentials_valid_after, row.credentials_valid_after, 'an earlier disable keeps the later cutoff')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_event WHERE user_id = ?').get(user.id).n, events + 2)
})
