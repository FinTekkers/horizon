// HTTP-contract tests for the auth routes themselves (HZ-21): hardcoded
// login, Google SSO, session/me/logout, gate-PIN regeneration, and the
// general /api/* session gate. The Google flow is exercised end-to-end via
// app.inject() by stubbing googleAuth.exchangeCodeForProfile at its own
// module boundary — no real network call to Google, no manual click-through.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-app-auth-')), 'test.db')
process.env.ADMIN_EMAIL = 'admin@example.com'
process.env.ADMIN_PASSWORD = 'super-secret'
process.env.GOOGLE_CLIENT_ID = 'test-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { buildApp } = await import('../src/app.js')
const { googleAuth } = await import('../src/googleAuth.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })

function cookieFrom(res) {
  const raw = res.cookies.find((c) => c.name === config.SESSION_COOKIE_NAME)
  return raw ? `${raw.name}=${raw.value}` : null
}

// ---- general session gate ----

test('a plain /api/* request with no session cookie is 401 login_required', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/items' })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('/api/auth/me is 401 with no session', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/me' })
  assert.equal(res.statusCode, 401)
})

test('the GitHub webhook route stays reachable with no session (separate trust boundary)', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/webhooks/github', payload: { zen: 'ok' } })
  assert.equal(res.statusCode, 503) // no secret configured, but NOT 401
})

// ---- hardcoded password login ----

test('logging in with the wrong password is 401 invalid_credentials, no cookie set', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@example.com', password: 'wrong' },
  })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'invalid_credentials' })
  assert.equal(cookieFrom(res), null)
})

test('a short/missing field is rejected at the schema layer (400)', async () => {
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a', password: '' } })).statusCode,
    400,
  )
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} })).statusCode, 400)
})

let sessionCookie
let loggedInUser

test('logging in with the right hardcoded credential succeeds, sets an httpOnly session cookie, and creates the account', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@example.com', password: 'super-secret' },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.user.email, 'admin@example.com')
  assert.equal(body.user.authMethod, 'password')
  loggedInUser = body.user

  const cookie = res.cookies.find((c) => c.name === config.SESSION_COOKIE_NAME)
  assert.ok(cookie, 'expected a session cookie to be set')
  assert.equal(cookie.httpOnly, true)
  assert.equal(cookie.sameSite, 'Lax')
  sessionCookie = `${cookie.name}=${cookie.value}`
})

test('the session cookie authenticates subsequent requests', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sessionCookie } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().user.id, loggedInUser.id)

  const items = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: sessionCookie } })
  assert.equal(items.statusCode, 200)
})

test('logging in again with the same credential reuses the same account (no duplicate)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@example.com', password: 'super-secret' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().user.id, loggedInUser.id)
})

test('logout clears the session — the old cookie no longer authenticates', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: sessionCookie } })
  assert.equal(res.statusCode, 200)
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sessionCookie } })
  assert.equal(me.statusCode, 401)
})

// ---- gate PIN regeneration (separate from login) ----

test('gate-pin/regenerate requires a session but returns a usable PIN', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@example.com', password: 'super-secret' },
  })
  const cookie = cookieFrom(login)

  const anon = await app.inject({ method: 'POST', url: '/api/auth/gate-pin/regenerate' })
  assert.equal(anon.statusCode, 401)

  const res = await app.inject({ method: 'POST', url: '/api/auth/gate-pin/regenerate', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  const { pin } = res.json()
  assert.match(pin, /^\d{6}$/)
  assert.ok(auth.verifyGatePin(loggedInUser.id, pin))
})

// ---- Google SSO (stubbed at the googleAuth module boundary — no real network) ----

test('google/start redirects to the built auth URL and sets a short-lived state cookie', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  assert.equal(res.statusCode, 302)
  assert.match(res.headers.location, /^https:\/\/accounts\.google\.com/)
  const state = res.cookies.find((c) => c.name === 'oauth_state')
  assert.ok(state, 'expected an oauth_state cookie')
})

test('google/callback with a missing/mismatched state is 400 bad_state', async () => {
  const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')

  const noState = await app.inject({ method: 'GET', url: '/api/auth/google/callback?code=abc' })
  assert.equal(noState.statusCode, 400)
  assert.deepEqual(noState.json(), { error: 'bad_state' })

  const wrongState = await app.inject({
    method: 'GET',
    url: `/api/auth/google/callback?code=abc&state=not-the-right-one`,
    headers: { cookie: `oauth_state=${stateCookie.value}` },
  })
  assert.equal(wrongState.statusCode, 400)
})

test('google/callback with a valid state but a failed code exchange is 400 google_auth_failed, not a 500', async () => {
  const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')
  const realExchange = googleAuth.exchangeCodeForProfile
  googleAuth.exchangeCodeForProfile = async () => {
    throw new Error('invalid_grant')
  }
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=bad-code&state=${stateCookie.value}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    })
    assert.equal(res.statusCode, 400)
    assert.deepEqual(res.json(), { error: 'google_auth_failed' })
  } finally {
    googleAuth.exchangeCodeForProfile = realExchange
  }
})

test('google/callback with a NEW google account creates a user and starts a session', async () => {
  const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')
  const realExchange = googleAuth.exchangeCodeForProfile
  googleAuth.exchangeCodeForProfile = async () => ({
    sub: 'google-new-1',
    email: 'nova@example.com',
    name: 'Nova Newuser',
  })
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=good-code&state=${stateCookie.value}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    })
    assert.equal(res.statusCode, 302)
    const cookie = res.cookies.find((c) => c.name === config.SESSION_COOKIE_NAME)
    assert.ok(cookie, 'expected a session cookie after Google login')
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    assert.equal(me.statusCode, 200)
    const { user } = me.json()
    assert.equal(user.email, 'nova@example.com')
    assert.equal(user.name, 'Nova Newuser')
    assert.equal(user.initials, 'NN')
    assert.equal(user.authMethod, 'google')
  } finally {
    googleAuth.exchangeCodeForProfile = realExchange
  }
})

test('google/callback with a RETURNING google account logs into the SAME user, no duplicate', async () => {
  async function googleLogin() {
    const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
    const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=good-code&state=${stateCookie.value}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    })
    const cookie = res.cookies.find((c) => c.name === config.SESSION_COOKIE_NAME)
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    return me.json().user
  }

  const realExchange = googleAuth.exchangeCodeForProfile
  googleAuth.exchangeCodeForProfile = async () => ({
    sub: 'google-returning-1',
    email: 'returning-http@example.com',
    name: 'Returning Http',
  })
  try {
    const first = await googleLogin()
    const second = await googleLogin()
    assert.equal(second.id, first.id)
  } finally {
    googleAuth.exchangeCodeForProfile = realExchange
  }
})

// The production failure this pins: davidjdoherty@gmail.com had logged in by
// password (google_sub NULL), so the Google callback 500'd on
// `UNIQUE constraint failed: user.email` every time.
test('google/callback adopts an account that already exists from password login', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD },
  })
  assert.equal(login.statusCode, 200)
  const passwordUser = login.json().user

  const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')
  const realExchange = googleAuth.exchangeCodeForProfile
  googleAuth.exchangeCodeForProfile = async () => ({
    sub: 'google-adopts-admin',
    email: config.ADMIN_EMAIL,
    name: 'Admin',
  })
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=good-code&state=${stateCookie.value}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    })
    assert.equal(res.statusCode, 302, 'must redirect, not 500 on the email constraint')

    const cookie = res.cookies.find((c) => c.name === config.SESSION_COOKIE_NAME)
    assert.ok(cookie, 'expected a session cookie')
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    assert.equal(me.json().user.id, passwordUser.id, 'should be the same account, linked')
  } finally {
    googleAuth.exchangeCodeForProfile = realExchange
  }
})

// A failed callback used to clear oauth_state before validating it, so the
// natural retry (back, pick another account, same state replayed) reported
// `bad_state` and masked the original error.
test('a failed callback leaves oauth_state intact so the retry still validates', async () => {
  const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')
  const realExchange = googleAuth.exchangeCodeForProfile
  googleAuth.exchangeCodeForProfile = async () => {
    throw new Error('invalid_grant')
  }
  try {
    const failed = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=bad-code&state=${stateCookie.value}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    })
    assert.equal(failed.json().error, 'google_auth_failed')

    // Assert on the RESPONSE, not on a follow-up inject: inject re-sends
    // whatever cookie header we hand it, so replaying the state here would
    // pass whether or not the server cleared it. A real browser obeys the
    // clearing Set-Cookie, so that is what has to be absent.
    const cleared = failed.cookies.find((c) => c.name === 'oauth_state')
    assert.equal(cleared, undefined, 'a failed exchange must not clear the nonce the retry needs')
  } finally {
    googleAuth.exchangeCodeForProfile = realExchange
  }
})

test('a SUCCESSFUL callback does clear oauth_state — the nonce is single-use', async () => {
  const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')
  const realExchange = googleAuth.exchangeCodeForProfile
  googleAuth.exchangeCodeForProfile = async () => ({
    sub: 'google-single-use',
    email: 'single-use@example.com',
    name: 'Single Use',
  })
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=good-code&state=${stateCookie.value}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    })
    assert.equal(res.statusCode, 302)
    const cleared = res.cookies.find((c) => c.name === 'oauth_state')
    assert.ok(cleared, 'expected the nonce to be cleared once consumed')
    assert.equal(cleared.value, '')
  } finally {
    googleAuth.exchangeCodeForProfile = realExchange
  }
})

test('google/start is 503 when Google is not configured', async () => {
  const { GOOGLE_CLIENT_ID } = config
  process.env.GOOGLE_CLIENT_ID = ''
  // googleAuth.configured() reads the live env-derived constants, which are
  // captured at module load — simulate "not configured" by stubbing
  // configured() itself rather than reloading the module.
  const realConfigured = googleAuth.configured
  googleAuth.configured = () => false
  try {
    const res = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.json(), { error: 'google_sso_not_configured' })
  } finally {
    googleAuth.configured = realConfigured
    process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID
  }
})
