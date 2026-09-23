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
// HZ-36: deny-by-default means every Google login below needs its email on
// this list — the tests that specifically exercise the allowlist gate
// itself (deny-by-default, no-enumeration parity) manage the env var
// directly, closer to where they run.
process.env.ALLOWED_LOGIN_EMAILS = [
  'admin@example.com',
  'unverified-target@example.com',
  'already-linked-http@example.com',
  'nova@example.com',
  'returning-http@example.com',
  'single-use@example.com',
].join(',')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { buildApp } = await import('../src/app.js')
const { googleAuth } = await import('../src/googleAuth.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const { db } = await import('../src/db.js')

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

// HZ-43: deploy.sh has no session cookie to send, so this is the one route
// besides the above that must stay reachable — pinned here so a future
// SESSION_EXEMPT edit can't silently regress it back to 401.
test('/api/health is 200 with no session cookie (deploy.sh liveness probe)', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(typeof body.itemCount, 'number')
})

test('/api/health is 503 with no leaked detail when the DB read fails', async () => {
  const { db } = await import('../src/db.js')
  const realPrepare = db.prepare
  db.prepare = () => {
    throw new Error('disk I/O error: /some/sensitive/path')
  }
  try {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.json(), { ok: false })
  } finally {
    db.prepare = realPrepare
  }
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

// HZ-37: every browser-facing error on this route family redirects to the
// login page (with a readable ?error= code) instead of rendering raw JSON.
test('google/callback with a missing/mismatched state redirects to the login page with ?error=bad_state, not raw JSON', async () => {
  const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')

  const noState = await app.inject({ method: 'GET', url: '/api/auth/google/callback?code=abc' })
  assert.equal(noState.statusCode, 302)
  assert.equal(noState.headers.location, `${config.UI_URL}/?error=bad_state`)

  const wrongState = await app.inject({
    method: 'GET',
    url: `/api/auth/google/callback?code=abc&state=not-the-right-one`,
    headers: { cookie: `oauth_state=${stateCookie.value}` },
  })
  assert.equal(wrongState.statusCode, 302)
  assert.equal(wrongState.headers.location, `${config.UI_URL}/?error=bad_state`)
})

test('google/callback with a valid state but a failed code exchange redirects with ?error=google_auth_failed, not a 500 or raw JSON', async () => {
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
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, `${config.UI_URL}/?error=google_auth_failed`)
  } finally {
    googleAuth.exchangeCodeForProfile = realExchange
  }
})

// Uses a dedicated account (not ADMIN_EMAIL) so this and the retry test below
// don't fight over google_sub state with the "adopts an account" test further
// down, which needs ADMIN_EMAIL to still be unlinked when it runs.
//
// HZ-36: the allowlist gate at the route now checks emailVerified BEFORE
// findOrCreateGoogleUser is ever called, so an unverified claim is rejected
// with the coarser, non-enumerating ?error=google_login_not_allowed rather
// than reaching auth.js's own unverified-linking check (still exercised
// directly, at the unit level, in auth.test.mjs).
test('google/callback with an unverified email match redirects with ?error=google_login_not_allowed and does not link', async () => {
  const { user: passwordUser } = auth.createUser({
    email: 'unverified-target@example.com',
    name: 'Unverified Target',
    authMethod: 'password',
  })

  const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')
  const realExchange = googleAuth.exchangeCodeForProfile
  googleAuth.exchangeCodeForProfile = async () => ({
    sub: 'google-unverified-target',
    email: 'unverified-target@example.com',
    name: 'Someone Else',
    emailVerified: false,
  })
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=good-code&state=${stateCookie.value}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    })
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, `${config.UI_URL}/?error=google_login_not_allowed`)
    assert.equal(res.cookies.find((c) => c.name === config.SESSION_COOKIE_NAME), undefined, 'no session must start')
  } finally {
    googleAuth.exchangeCodeForProfile = realExchange
  }
  assert.equal(auth.findUserByGoogleSub('google-unverified-target'), null)
  assert.equal(auth.findUserById(passwordUser.id).authMethod, 'password', 'the existing account must be untouched')
})

// The burned unverified attempt above must not permanently block the real
// owner — a fresh, VERIFIED sign-in for the same address succeeds right after.
test('a fresh verified Google sign-in succeeds right after an unverified attempt was blocked', async () => {
  const passwordUser = auth.findUserByEmail('unverified-target@example.com')
  assert.ok(passwordUser, 'the previous test must have seeded this account')

  const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')
  const realExchange = googleAuth.exchangeCodeForProfile
  googleAuth.exchangeCodeForProfile = async () => ({
    sub: 'google-verified-target',
    email: 'unverified-target@example.com',
    name: 'Unverified Target',
    emailVerified: true,
  })
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=good-code&state=${stateCookie.value}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    })
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, config.UI_URL)
    const cookie = res.cookies.find((c) => c.name === config.SESSION_COOKIE_NAME)
    assert.ok(cookie, 'expected a session cookie on the successful retry')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `${cookie.name}=${cookie.value}` } })
    assert.equal(me.json().user.id, passwordUser.id, 'must link the same row, not create a new one')
  } finally {
    googleAuth.exchangeCodeForProfile = realExchange
  }
})

// HZ-37 guardrail: never re-link or merge rows — a row already linked to a
// DIFFERENT Google identity must reject a second one, even when verified.
test('google/callback with a verified email match already linked to a different google_sub is blocked, not relinked', async () => {
  auth.createUser({
    email: 'already-linked-http@example.com',
    name: 'Already Linked',
    authMethod: 'google',
    googleSub: 'google-sub-original-http',
  })

  const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')
  const realExchange = googleAuth.exchangeCodeForProfile
  googleAuth.exchangeCodeForProfile = async () => ({
    sub: 'google-sub-different-http',
    email: 'already-linked-http@example.com',
    name: 'Already Linked',
    emailVerified: true,
  })
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=good-code&state=${stateCookie.value}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    })
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, `${config.UI_URL}/?error=google_link_blocked`)
  } finally {
    googleAuth.exchangeCodeForProfile = realExchange
  }
  assert.equal(
    db.prepare('SELECT google_sub FROM user WHERE email = ?').get('already-linked-http@example.com').google_sub,
    'google-sub-original-http',
    'the original link must not be overwritten',
  )
})

test('google/callback with a NEW google account creates a user and starts a session', async () => {
  const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')
  const realExchange = googleAuth.exchangeCodeForProfile
  googleAuth.exchangeCodeForProfile = async () => ({
    sub: 'google-new-1',
    email: 'nova@example.com',
    name: 'Nova Newuser',
    emailVerified: true,
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
    emailVerified: true,
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
// `UNIQUE constraint failed: user.email` every time. This exercises the full
// success metric through the real HTTP endpoints, not DB reads: password
// login, Google link, same id, and BOTH login paths still work afterwards.
test('google/callback adopts an account that already exists from password login, and both login paths work afterwards', async () => {
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
    emailVerified: true,
  })
  let googleCookie
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=good-code&state=${stateCookie.value}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    })
    assert.equal(res.statusCode, 302, 'must redirect, not 500 on the email constraint')

    googleCookie = res.cookies.find((c) => c.name === config.SESSION_COOKIE_NAME)
    assert.ok(googleCookie, 'expected a session cookie')
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${googleCookie.name}=${googleCookie.value}` },
    })
    assert.equal(me.json().user.id, passwordUser.id, 'should be the same account, linked')
    assert.equal(
      db.prepare('SELECT google_sub FROM user WHERE id = ?').get(passwordUser.id).google_sub,
      'google-adopts-admin',
    )
  } finally {
    googleAuth.exchangeCodeForProfile = realExchange
  }

  // The Google-issued session still works.
  const meAfterGoogle = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie: `${googleCookie.name}=${googleCookie.value}` },
  })
  assert.equal(meAfterGoogle.statusCode, 200)
  assert.equal(meAfterGoogle.json().user.id, passwordUser.id)

  // And password login into the SAME now-linked account still works too.
  const secondPasswordLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD },
  })
  assert.equal(secondPasswordLogin.statusCode, 200)
  assert.equal(secondPasswordLogin.json().user.id, passwordUser.id, 'password login after linking must still resolve the same account')
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
    assert.equal(failed.statusCode, 302)
    assert.equal(failed.headers.location, `${config.UI_URL}/?error=google_auth_failed`)

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
    emailVerified: true,
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

test('google/start redirects to the login page with ?error=google_sso_not_configured when Google is not configured, not raw JSON', async () => {
  const { GOOGLE_CLIENT_ID } = config
  process.env.GOOGLE_CLIENT_ID = ''
  // googleAuth.configured() reads the live env-derived constants, which are
  // captured at module load — simulate "not configured" by stubbing
  // configured() itself rather than reloading the module.
  const realConfigured = googleAuth.configured
  googleAuth.configured = () => false
  try {
    const res = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, `${config.UI_URL}/?error=google_sso_not_configured`)
  } finally {
    googleAuth.configured = realConfigured
    process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID
  }
})

// ---- Login allowlist (HZ-36) ----
// ALLOWED_LOGIN_EMAILS is a plain Set, mutated in place per test (not
// reassigned) since config.js's own module-load parse is the only place the
// underlying env var is read — this is the same trick used throughout this
// suite to flip module-captured config for one test.

async function googleAttempt(profile) {
  const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' })
  const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')
  const realExchange = googleAuth.exchangeCodeForProfile
  googleAuth.exchangeCodeForProfile = async () => profile
  try {
    return await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=good-code&state=${stateCookie.value}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    })
  } finally {
    googleAuth.exchangeCodeForProfile = realExchange
  }
}

test('google/callback: an unverified-but-allowlisted claim and a verified-but-non-allowlisted address get IDENTICAL rejections (no enumeration)', async () => {
  const unverifiedAllowlisted = await googleAttempt({
    sub: 'google-parity-unverified',
    email: 'admin@example.com', // on the allowlist, but the claim itself is unverified
    name: 'Parity One',
    emailVerified: false,
  })
  const verifiedNotAllowlisted = await googleAttempt({
    sub: 'google-parity-not-allowlisted',
    email: 'outsider@example.com', // verified, but never added to the allowlist
    name: 'Parity Two',
    emailVerified: true,
  })

  assert.equal(unverifiedAllowlisted.statusCode, verifiedNotAllowlisted.statusCode)
  assert.equal(unverifiedAllowlisted.headers.location, verifiedNotAllowlisted.headers.location)
  assert.equal(unverifiedAllowlisted.headers.location, `${config.UI_URL}/?error=google_login_not_allowed`)
  assert.equal(auth.findUserByGoogleSub('google-parity-unverified'), null)
  assert.equal(auth.findUserByGoogleSub('google-parity-not-allowlisted'), null)
})

test('deny-by-default: with ALLOWED_LOGIN_EMAILS empty, every Google login is rejected, but password login still works', async () => {
  const saved = new Set(config.ALLOWED_LOGIN_EMAILS)
  config.ALLOWED_LOGIN_EMAILS.clear()
  try {
    const res = await googleAttempt({
      sub: 'google-deny-default',
      email: config.ADMIN_EMAIL,
      name: 'Admin',
      emailVerified: true,
    })
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, `${config.UI_URL}/?error=google_login_not_allowed`)
    assert.equal(auth.findUserByGoogleSub('google-deny-default'), null)

    const passwordLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD },
    })
    assert.equal(passwordLogin.statusCode, 200, 'the password path must be unaffected by an empty Google allowlist')
  } finally {
    config.ALLOWED_LOGIN_EMAILS.clear()
    for (const email of saved) config.ALLOWED_LOGIN_EMAILS.add(email)
  }
})

// A password-auth row that previously linked a google_sub (the "adopt" path)
// must still be blocked at the route the moment its email leaves the
// allowlist — the route check runs before any DB lookup, so it can't matter
// that the row itself still remembers the link.
test('a password account previously linked to a google_sub is blocked at the route once its email leaves the allowlist', async () => {
  const email = 'formerly-allowed@example.com'
  config.ALLOWED_LOGIN_EMAILS.add(email)
  const { user: passwordUser } = auth.createUser({ email, name: 'Formerly Allowed', authMethod: 'password' })
  const linked = auth.findOrCreateGoogleUser({
    sub: 'google-formerly-allowed',
    email,
    name: 'Formerly Allowed',
    emailVerified: true,
  })
  assert.equal(linked.id, passwordUser.id)
  assert.equal(
    db.prepare('SELECT google_sub FROM user WHERE id = ?').get(passwordUser.id).google_sub,
    'google-formerly-allowed',
  )

  config.ALLOWED_LOGIN_EMAILS.delete(email)
  const res = await googleAttempt({
    sub: 'google-formerly-allowed',
    email,
    name: 'Formerly Allowed',
    emailVerified: true,
  })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, `${config.UI_URL}/?error=google_login_not_allowed`)
  // The route rejection doesn't touch existing rows — that's reconcileGoogleUsers's
  // job at boot (see loginAllowlist.test.mjs), a separate concern from login-time gating.
  assert.equal(
    db.prepare('SELECT google_sub FROM user WHERE id = ?').get(passwordUser.id).google_sub,
    'google-formerly-allowed',
  )
})
