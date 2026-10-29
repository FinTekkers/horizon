// HZ-635: a paid Google user who lapses loses access with no server restart —
// at the next reconcileGoogleUsers or at their next request, each proven on
// its own below — and a new paid user signs in to an empty workspace.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-google-entitlement-')), 'test.db')
process.env.ADMIN_EMAIL = 'admin@example.com'
process.env.ADMIN_PASSWORD = 'super-secret'
process.env.GOOGLE_CLIENT_ID = 'test-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
process.env.ALLOWED_LOGIN_EMAILS = 'admin@example.com'
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { buildApp } = await import('../src/app.js')
const { googleAuth } = await import('../src/googleAuth.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const { db } = await import('../src/db.js')
const { reconcileGoogleUsers } = await import('../src/loginAllowlist.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })

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

function cookieFrom(res) {
  const raw = res.cookies.find((c) => c.name === config.SESSION_COOKIE_NAME)
  return raw ? `${raw.name}=${raw.value}` : null
}

const sessionsOf = (userId) => db.prepare('SELECT COUNT(*) AS n FROM session WHERE user_id = ?').get(userId).n
const rowExists = (userId) => db.prepare('SELECT COUNT(*) AS n FROM user WHERE id = ?').get(userId).n === 1

// Records every outbound fetch, so a test can prove nothing here calls Stripe.
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

// A paid, non-allowlisted customer: the sign-up row (HZ-633), made active the
// way HZ-634's webhook does, then signed in with Google. Returns their cookie
// and a personal API token.
async function signedInPaidUser(email) {
  const user = auth.createSignupUser({ email, name: 'Paid Person', company: 'Acme' })
  auth.setAccountStatus(user.id, 'active', 'test')
  const res = await googleAttempt({ sub: `google-${email}`, email, name: 'Paid Person', emailVerified: true })
  assert.equal(res.headers.location, config.UI_URL, 'signs in')
  const cookie = cookieFrom(res)
  const { token } = auth.createApiToken(user.id, 'script')
  return { user, cookie, token }
}

const asCookie = (cookie) => app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
const asToken = (token) => app.inject({ method: 'GET', url: '/api/items', headers: { authorization: `Bearer ${token}` } })

for (const status of ['past_due', 'cancelled']) {
  test(`reconcile alone: a signed-in active user set to ${status} has no sessions after reconcileGoogleUsers, and keeps the row`, async () => {
    await withFetchSpy(async () => {
      const { user } = await signedInPaidUser(`reconcile-${status}@example.com`)
      assert.equal(sessionsOf(user.id), 1)

      auth.setAccountStatus(user.id, status, 'test')
      reconcileGoogleUsers(db) // before any request

      assert.equal(sessionsOf(user.id), 0)
      assert.ok(rowExists(user.id), 'the row and its status survive for a re-payment')
    })
  })

  test(`request alone: a signed-in active user set to ${status} is refused on their next request, cookie and token`, async () => {
    await withFetchSpy(async () => {
      const { user, cookie, token } = await signedInPaidUser(`request-${status}@example.com`)
      assert.equal((await asCookie(cookie)).statusCode, 200)
      assert.equal((await asToken(token)).statusCode, 200)

      auth.setAccountStatus(user.id, status, 'test') // no reconcile, no restart

      const byCookie = await asCookie(cookie)
      assert.equal(byCookie.statusCode, 401)
      assert.deepEqual(byCookie.json(), { error: 'login_required' })
      const byToken = await asToken(token)
      assert.equal(byToken.statusCode, 401)
      assert.deepEqual(byToken.json(), { error: 'invalid_token' })
      assert.equal(sessionsOf(user.id), 0)
      assert.ok(rowExists(user.id))
    })
  })
}

test('the same user goes past_due, then cancelled: each time the next request is refused and reconcile leaves no sessions', async () => {
  const { user, cookie } = await signedInPaidUser('lapses-twice@example.com')
  let current = cookie
  for (const status of ['past_due', 'cancelled']) {
    assert.equal((await asCookie(current)).statusCode, 200)
    auth.setAccountStatus(user.id, status, 'test')
    assert.equal((await asCookie(current)).statusCode, 401)
    reconcileGoogleUsers(db)
    assert.equal(sessionsOf(user.id), 0)
    // Pays again, signs in again, ready for the next lapse.
    auth.setAccountStatus(user.id, 'active', 'test')
    const again = await googleAttempt({ sub: 'google-lapses-twice@example.com', email: 'lapses-twice@example.com', name: 'Paid Person', emailVerified: true })
    assert.equal(again.headers.location, config.UI_URL)
    current = cookieFrom(again)
  }
})

test('a new non-allowlisted active user signs in to an empty project list, never another user\'s projects', async () => {
  const admin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD },
  })
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie: cookieFrom(admin) },
    payload: { name: 'Admin Only Project' },
  })
  assert.equal(created.statusCode, 200)

  const { cookie } = await signedInPaidUser('new-paid@example.com')
  const board = await asCookie(cookie)
  assert.equal(board.statusCode, 200)
  assert.deepEqual(board.json().projects, [])
})
