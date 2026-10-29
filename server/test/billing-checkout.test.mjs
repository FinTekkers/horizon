// HZ-633: POST /api/billing/checkout-session, against a fake Stripe client.
// The route finds or creates a pending_payment sign-up row and its Stripe
// customer, then returns { clientSecret, publishableKey } and nothing else. It
// never starts a session, sets a cookie or changes an existing account.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FAKE_STRIPE_ENV, fakeStripe, setFakeStripeEnv } from './helpers/fakeStripe.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-billing-checkout-')), 'test.db')
process.env.ADMIN_EMAIL = 'admin@example.com'
process.env.ADMIN_PASSWORD = 'super-secret'
process.env.ALLOWED_LOGIN_EMAILS = ''
delete process.env.HORIZON_REPO
delete process.env.FARM_URL
setFakeStripeEnv()

const { buildApp } = await import('../src/app.js')
const { SIGNUP_RETURN_URL } = await import('../src/billing.js')
const auth = await import('../src/auth.js')
const { db } = await import('../src/db.js')
const { reconcileGoogleUsers } = await import('../src/loginAllowlist.js')

const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM user').get().n
const sessionCount = () => db.prepare('SELECT COUNT(*) AS n FROM session').get().n
const row = (email) => db.prepare('SELECT * FROM user WHERE lower(email) = lower(?)').get(email)

function appWith(stripe) {
  return buildApp({ logger: false, stripe })
}

function signup(app, body) {
  return app.inject({
    method: 'POST',
    url: '/api/billing/checkout-session',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  })
}

test('a valid sign-up returns the client secret and publishable key, and creates the session exactly as specified', async () => {
  const stripe = fakeStripe()
  const app = appWith(stripe)
  const res = await signup(app, { name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Ltd' })
  assert.equal(res.statusCode, 200)

  const user = row('ada@example.com')
  assert.equal(user.account_status, 'pending_payment')
  assert.equal(user.name, 'Ada Lovelace')
  assert.equal(user.company, 'Analytical Ltd')
  assert.equal(user.last_login_at, null)

  assert.equal(stripe.calls.customersCreate.length, 1)
  assert.deepEqual(stripe.calls.customersCreate[0], {
    params: { email: 'ada@example.com', name: 'Ada Lovelace', metadata: { horizon_user_id: user.id, company: 'Analytical Ltd' } },
    options: { idempotencyKey: `hz-signup-customer-${user.id}` },
  })
  assert.equal(user.stripe_customer_id, 'cus_fake1')

  assert.equal(stripe.calls.sessionsCreate.length, 1)
  assert.deepEqual(stripe.calls.sessionsCreate[0], {
    mode: 'subscription',
    ui_mode: 'embedded_page',
    line_items: [{ price: FAKE_STRIPE_ENV.STRIPE_PRICE_ID, quantity: 1 }],
    customer: 'cus_fake1',
    client_reference_id: user.id,
    return_url: 'https://shoreward.ai/welcome.html?session_id={CHECKOUT_SESSION_ID}',
  })
  assert.equal(SIGNUP_RETURN_URL, 'https://shoreward.ai/welcome.html?session_id={CHECKOUT_SESSION_ID}')

  assert.deepEqual(res.json(), {
    clientSecret: 'cs_test_fake2_secret_fake2',
    publishableKey: FAKE_STRIPE_ENV.STRIPE_PUBLISHABLE_KEY,
  })
  await app.close()
})

test('a second call with the same email reuses the user and the Stripe customer', async () => {
  const stripe = fakeStripe()
  const app = appWith(stripe)
  const body = { name: 'Grace Hopper', email: 'grace@example.com', company: 'Navy' }
  assert.equal((await signup(app, body)).statusCode, 200)
  const before = userCount()
  const res = await signup(app, { ...body, email: 'Grace@Example.com' })
  assert.equal(res.statusCode, 200)
  assert.equal(userCount(), before)
  assert.equal(stripe.calls.customersCreate.length, 1)
  assert.equal(stripe.calls.sessionsCreate.length, 2)
  const customerId = row('grace@example.com').stripe_customer_id
  assert.deepEqual(
    stripe.calls.sessionsCreate.map((params) => params.customer),
    [customerId, customerId],
  )
  await app.close()
})

test('two concurrent same-email calls share one user, one idempotency key and one customer', async () => {
  const stripe = fakeStripe()
  const app = appWith(stripe)
  const before = userCount()
  const body = { name: 'Katherine Johnson', email: 'katherine@example.com', company: 'NASA' }
  const results = await Promise.all([signup(app, body), signup(app, body)])
  assert.deepEqual(
    results.map((res) => res.statusCode),
    [200, 200],
  )
  assert.equal(userCount(), before + 1)
  const user = row('katherine@example.com')
  assert.ok(stripe.calls.customersCreate.length >= 1)
  assert.deepEqual(
    [...new Set(stripe.calls.customersCreate.map((call) => call.options.idempotencyKey))],
    [`hz-signup-customer-${user.id}`],
  )
  assert.deepEqual(
    stripe.calls.sessionsCreate.map((params) => params.customer),
    [user.stripe_customer_id, user.stripe_customer_id],
  )
  await app.close()
})

test('the response sets no cookie, creates no login session and carries only the two keys', async () => {
  const app = appWith(fakeStripe())
  const sessionsBefore = sessionCount()
  const res = await signup(app, { name: 'Mary Somerville', email: 'mary@example.com', company: 'RAS' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['set-cookie'], undefined)
  assert.deepEqual(res.cookies, [])
  assert.equal(sessionCount(), sessionsBefore)
  assert.deepEqual(Object.keys(res.json()).sort(), ['clientSecret', 'publishableKey'])
  await app.close()
})

test('an existing active user keeps status, name, company and customer id, and no customer is created', async () => {
  const { user } = auth.createUser({ email: 'active@example.com', name: 'Active Person', authMethod: 'password' })
  db.prepare('UPDATE user SET company = ?, stripe_customer_id = ? WHERE id = ?').run('Old Co', 'cus_existing', user.id)
  assert.equal(auth.setAccountStatus(user.id, 'active', 'test').ok, true)

  const stripe = fakeStripe()
  const app = appWith(stripe)
  const res = await signup(app, { name: 'Someone Else', email: 'ACTIVE@example.com', company: 'New Co' })
  assert.equal(res.statusCode, 200)
  const after = row('active@example.com')
  assert.equal(after.account_status, 'active')
  assert.equal(after.name, 'Active Person')
  assert.equal(after.company, 'Old Co')
  assert.equal(after.stripe_customer_id, 'cus_existing')
  assert.equal(stripe.calls.customersCreate.length, 0)
  assert.equal(stripe.calls.sessionsCreate[0].customer, 'cus_existing')
  assert.equal(stripe.calls.sessionsCreate[0].client_reference_id, user.id)
  await app.close()
})

test('a sign-up row cannot log in and survives the boot-time Google reconcile; ADMIN_EMAIL is refused', async () => {
  const stripe = fakeStripe()
  const app = appWith(stripe)
  assert.equal((await signup(app, { name: 'Lin Signup', email: 'lin@example.com', company: 'Lin Co' })).statusCode, 200)

  for (const password of ['', 'anything', 'super-secret']) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lin@example.com', password } })
    assert.ok([400, 401].includes(res.statusCode), `login with ${JSON.stringify(password)} was ${res.statusCode}`)
    assert.equal(res.headers['set-cookie'], undefined)
  }

  reconcileGoogleUsers(db)
  assert.ok(row('lin@example.com'), 'the sign-up row survives reconcileGoogleUsers')

  const callsBefore = stripe.totalCalls()
  const usersBefore = userCount()
  const admin = await signup(app, { name: 'Not Admin', email: 'Admin@Example.com', company: 'X' })
  assert.equal(admin.statusCode, 400)
  assert.deepEqual(admin.json(), { error: 'invalid_signup', field: 'email' })
  assert.equal(stripe.totalCalls(), callsBefore)
  assert.equal(userCount(), usersBefore)
  assert.equal(row('admin@example.com'), undefined)
  await app.close()
})
