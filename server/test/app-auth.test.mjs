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
  'pending-new@example.com',
  'pending-returning@example.com',
  'allowlisted-fresh@example.com',
  'allowlisted-cancelled@example.com',
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

// HZ-633: only the two exact billing paths skip the login gate. Neighbouring
// paths and methods still need a session, and the exempt list grew by exactly
// those two entries. HZ-634's Stripe webhook is the one later entry.
test('only the two exact /api/billing paths skip the login gate', async () => {
  const { SESSION_EXEMPT } = await import('../src/app.js')
  assert.equal(SESSION_EXEMPT.length, 12)
  for (const [method, url] of [
    ['GET', '/api/billing/checkout-session/x'],
    ['POST', '/api/billing/checkout-session/x'],
    ['GET', '/api/billing/anything'],
    ['POST', '/api/billing/session-status/x'],
    ['GET', '/api/billing/session-statusx'],
    ['GET', '/api/billing'],
    ['POST', '/api/billing/stripe-webhook/x'],
    ['POST', '/api/billing/stripe-webhookx'],
  ]) {
    const res = await app.inject({ method, url })
    assert.equal(res.statusCode, 401, `${method} ${url}`)
    assert.deepEqual(res.json(), { error: 'login_required' })
  }
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
// with the coarser, non-enumerating ?error=subscription_inactive rather
// than reaching auth.js's own unverified-linking check (still exercised
// directly, at the unit level, in auth.test.mjs).
test('google/callback with an unverified email match redirects with ?error=subscription_inactive and does not link', async () => {
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
    assert.equal(res.headers.location, `${config.UI_URL}/?error=subscription_inactive`)
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
  assert.equal(unverifiedAllowlisted.headers.location, `${config.UI_URL}/?error=subscription_inactive`)
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
    assert.equal(res.headers.location, `${config.UI_URL}/?error=subscription_inactive`)
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
  assert.equal(res.headers.location, `${config.UI_URL}/?error=subscription_inactive`)
  // The route rejection doesn't touch existing rows — that's reconcileGoogleUsers's
  // job at boot (see loginAllowlist.test.mjs), a separate concern from login-time gating.
  assert.equal(
    db.prepare('SELECT google_sub FROM user WHERE id = ?').get(passwordUser.id).google_sub,
    'google-formerly-allowed',
  )
})

// ---- account status (HZ-632) ----
// /api/auth/me reports the stored account_status and nothing else about the
// user changes. An allowlisted email signs in whatever its status (HZ-635), so
// a pending_payment invitee signs in exactly as before.

async function googleSignIn(profile) {
  const res = await googleAttempt(profile)
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, config.UI_URL, 'redirects to the UI with no ?error=')
  const cookie = cookieFrom(res)
  assert.ok(cookie, 'expected a session cookie after Google login')
  return cookie
}

test('/api/auth/me returns the stored account_status; every other field is unchanged', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@example.com', password: 'super-secret' },
  })
  assert.equal(login.statusCode, 200)
  const { id } = login.json().user
  auth.setAccountStatus(id, 'past_due', 'test')
  try {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieFrom(login) } })
    assert.equal(me.statusCode, 200)
    assert.deepEqual(me.json().user, {
      id,
      email: 'admin@example.com',
      name: 'Admin',
      initials: 'AD',
      authMethod: 'password',
      isAdmin: true,
      account_status: 'past_due',
    })
  } finally {
    auth.setAccountStatus(id, 'active', 'test')
  }
})

test('a new allowlisted Google user starts pending_payment and still signs in', async () => {
  const cookie = await googleSignIn({
    sub: 'google-pending-new',
    email: 'pending-new@example.com',
    name: 'Pending New',
    emailVerified: true,
  })
  const row = db.prepare('SELECT id, account_status FROM user WHERE google_sub = ?').get('google-pending-new')
  assert.equal(row.account_status, 'pending_payment', 'set by the column default, not by the test')
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().user.id, row.id)
  assert.equal(me.json().user.account_status, 'pending_payment')
})

test('a returning Google user moved to pending_payment signs in again as the same user', async () => {
  const profile = {
    sub: 'google-pending-returning',
    email: 'pending-returning@example.com',
    name: 'Pending Returning',
    emailVerified: true,
  }
  const first = await googleSignIn(profile)
  const firstMe = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first } })
  const { id } = firstMe.json().user
  auth.setAccountStatus(id, 'active', 'test')
  assert.deepEqual(auth.setAccountStatus(id, 'pending_payment', 'test'), { ok: true, from: 'active', to: 'pending_payment' })

  const second = await googleSignIn(profile)
  assert.notEqual(second, first, 'a new session')
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: second } })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().user.id, id)
  assert.equal(me.json().user.account_status, 'pending_payment')
})

// ---- paid accounts sign in with Google (HZ-635) ----
// A paid customer's row comes from the shoreward.ai sign-up (HZ-633:
// 'password' auth, google_sub NULL) and HZ-634's webhook sets its status. The
// first Google sign-in links the sub through the adopt path.

const REFUSED = `${config.UI_URL}/?error=subscription_inactive`

function paidSignup(email, status) {
  const user = auth.createSignupUser({ email, name: 'Paid Person', company: 'Acme' })
  if (status !== 'pending_payment') assert.equal(auth.setAccountStatus(user.id, status, 'test').ok, true)
  return user
}

const sessionsOf = (userId) => db.prepare('SELECT COUNT(*) AS n FROM session WHERE user_id = ?').get(userId).n

// Records every outbound fetch, so a test can prove sign-in never calls Stripe.
async function withFetchSpy(run) {
  const realFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = (input, init) => {
    urls.push(String(input?.url ?? input))
    return realFetch(input, init)
  }
  try {
    await run()
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(urls.filter((url) => url.includes('stripe.com')), [], 'no Stripe API call')
}

test('google/callback: allowlisted, active and cancelling users get a working session; pending_payment, past_due and cancelled are refused', async () => {
  await withFetchSpy(async () => {
    const allowed = [
      { email: 'allowlisted-fresh@example.com', status: null }, // allowlisted, no row yet
      { email: 'paid-active@example.com', status: 'active' },
      { email: 'paid-cancelling@example.com', status: 'cancelling' },
    ]
    for (const { email, status } of allowed) {
      if (status) paidSignup(email, status)
      const res = await googleAttempt({ sub: `google-${email}`, email, name: 'Paid Person', emailVerified: true })
      assert.equal(res.headers.location, config.UI_URL, `${email} signs in`)
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieFrom(res) } })
      assert.equal(me.statusCode, 200, `${email}'s cookie works`)
      assert.equal(me.json().user.email, email)
    }
    for (const status of ['pending_payment', 'past_due', 'cancelled']) {
      const email = `paid-${status}@example.com`
      const user = paidSignup(email, status)
      const res = await googleAttempt({ sub: `google-${email}`, email, name: 'Paid Person', emailVerified: true })
      assert.equal(res.statusCode, 302)
      assert.equal(res.headers.location, REFUSED, `${status} is refused`)
      assert.equal(cookieFrom(res), null, 'no session cookie')
      assert.equal(sessionsOf(user.id), 0, 'no session row')
      assert.equal(db.prepare('SELECT google_sub FROM user WHERE id = ?').get(user.id).google_sub, null, 'not linked')
    }
  })
})

test('google/callback: a status that lapses between the pre-check and findOrCreateGoogleUser still redirects to subscription_inactive', async () => {
  const email = 'paid-race@example.com'
  const user = paidSignup(email, 'active')
  // The route reads emailVerified once in googleLoginAllowed, then again in
  // findOrCreateGoogleUser; the status lapses on that second read.
  let reads = 0
  const profile = { sub: 'google-paid-race', email, name: 'Paid Person' }
  Object.defineProperty(profile, 'emailVerified', {
    enumerable: true,
    get() {
      reads += 1
      if (reads === 2) auth.setAccountStatus(user.id, 'past_due', 'test')
      return true
    },
  })
  const res = await googleAttempt(profile)
  assert.ok(reads >= 2, 'both gates ran')
  assert.equal(res.headers.location, REFUSED, 'not google_link_blocked')
  assert.equal(sessionsOf(user.id), 0)
})

test('google/callback: an unknown account_status is refused, and a profile with no row is refused and writes no row', async () => {
  const email = 'paid-bogus@example.com'
  const user = paidSignup(email, 'pending_payment')
  // The CHECK on account_status forbids this value; a row that holds one
  // anyway must still fail closed.
  db.pragma('ignore_check_constraints = ON')
  try {
    db.prepare("UPDATE user SET account_status = 'bogus' WHERE id = ?").run(user.id)
  } finally {
    db.pragma('ignore_check_constraints = OFF')
  }
  const bogus = await googleAttempt({ sub: 'google-paid-bogus', email, name: 'Paid Person', emailVerified: true })
  assert.equal(bogus.headers.location, REFUSED)
  assert.equal(sessionsOf(user.id), 0)

  const usersBefore = db.prepare('SELECT COUNT(*) AS n FROM user').get().n
  const nobody = await googleAttempt({ sub: 'google-no-row', email: 'no-row@example.com', name: 'Nobody', emailVerified: true })
  assert.equal(nobody.headers.location, REFUSED)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user').get().n, usersBefore, 'no row written')
  assert.equal(auth.findUserByEmailCI('no-row@example.com'), null)
})

test('google/callback adopts a paid sign-up row: google_sub is linked and account_status stays active', async () => {
  const email = 'paid-adopt@example.com'
  const user = paidSignup(email, 'active')
  await withFetchSpy(async () => {
    const res = await googleAttempt({ sub: 'google-paid-adopt', email, name: 'Paid Person', emailVerified: true })
    assert.equal(res.headers.location, config.UI_URL)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieFrom(res) } })
    assert.equal(me.json().user.id, user.id, 'the sign-up row, not a new one')
  })
  const row = db.prepare('SELECT google_sub, account_status FROM user WHERE id = ?').get(user.id)
  assert.equal(row.google_sub, 'google-paid-adopt')
  assert.equal(row.account_status, 'active')
})

test('an allowlisted email that is cancelled still signs in with Google and keeps its sessions through reconcile', async () => {
  const { reconcileGoogleUsers } = await import('../src/loginAllowlist.js')
  const email = 'allowlisted-cancelled@example.com'
  const cookie = await googleSignIn({ sub: 'google-allowlisted-cancelled', email, name: 'Single Use', emailVerified: true })
  const { id } = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json().user
  auth.setAccountStatus(id, 'cancelled', 'test')

  const again = await googleSignIn({ sub: 'google-allowlisted-cancelled', email, name: 'Single Use', emailVerified: true })
  reconcileGoogleUsers(db)
  assert.equal(sessionsOf(id), 2)
  for (const c of [cookie, again]) {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: c } })
    assert.equal(me.statusCode, 200)
  }
})

test('password sign-in is unchanged: the non-allowlisted ADMIN_EMAIL row with a cancelled status still logs in', async () => {
  config.ALLOWED_LOGIN_EMAILS.delete(config.ADMIN_EMAIL)
  const admin = auth.findUserByEmail(config.ADMIN_EMAIL)
  try {
    auth.setAccountStatus(admin.id, 'cancelled', 'test')
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD },
    })
    assert.equal(login.statusCode, 200)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieFrom(login) } })
    assert.equal(me.statusCode, 200)
    assert.equal(me.json().user.email, config.ADMIN_EMAIL)
  } finally {
    auth.setAccountStatus(admin.id, 'active', 'test')
    config.ALLOWED_LOGIN_EMAILS.add(config.ADMIN_EMAIL)
  }
})
