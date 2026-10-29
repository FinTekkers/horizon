// HZ-636: the signed-in customer's billing routes, against a fake Stripe client.
//   GET  /api/billing              plan, current_period_end, card, invoices
//   POST /api/billing/cancel       cancel_at_period_end: true + cancellation_details
//   POST /api/billing/resume       cancel_at_period_end: false
//   POST /api/billing/card-session a card-update-only portal session
// The fake records every method called on it, by path, so a test can prove no
// route ever cancels outright, refunds or changes the plan.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FAKE_STRIPE_ENV, setFakeStripeEnv, stripeError } from './helpers/fakeStripe.mjs'
import { loginFixtureUser } from './helpers/session.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'horizon-billing-subscription-'))
process.env.HORIZON_DB = join(tmp, 'test.db')
process.env.HORIZON_UI_URL = 'https://shoreward.ai/horizon'
delete process.env.HORIZON_REPO
delete process.env.FARM_URL
setFakeStripeEnv()

const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { db } = await import('../src/db.js')

after(() => rmSync(tmp, { recursive: true, force: true }))

// Built, not written out: no live-key literal may appear in the repo.
const FAKE_LIVE_KEY = ['sk', 'live', 'notreal'].join('_')
const PERIOD_END = 1795910400 // 2026-11-29T00:00:00Z
const PERIOD_END_ISO = '2026-11-29T00:00:00.000Z'
const FULL_CARD = {
  brand: 'visa',
  last4: '4242',
  exp_month: 8,
  exp_year: 2028,
  fingerprint: 'fp_secret',
  funding: 'credit',
  country: 'US',
  checks: { cvc_check: 'pass' },
}

function subscriptionFor(customer, { itemPeriod = true, cancel = false, status = 'active', card = FULL_CARD } = {}) {
  return {
    id: `sub_of_${customer}`,
    customer,
    status,
    cancel_at_period_end: cancel,
    ...(itemPeriod ? {} : { current_period_end: PERIOD_END }),
    default_payment_method: card ? { id: 'pm_secret', billing_details: { name: 'Ada' }, card } : null,
    items: {
      data: [
        {
          id: 'si_secret',
          ...(itemPeriod ? { current_period_end: PERIOD_END } : {}),
          price: {
            id: 'price_secret',
            unit_amount: 20000,
            currency: 'usd',
            recurring: { interval: 'month' },
            product: { id: 'prod_secret', name: 'Horizon Platform' },
          },
        },
      ],
    },
  }
}

// A Proxy fake: every method path called ('subscriptions.update', …) is
// recorded with its args. Unknown methods are recorded too, then throw.
function recordingStripe({ subscriptions = {}, customers = {}, portalConfigs = [], fail = {} } = {}) {
  const calls = []
  const impl = {
    'subscriptions.retrieve': async (id) => {
      if (!Object.hasOwn(subscriptions, id)) throw stripeError('resource_missing')
      return structuredClone(subscriptions[id])
    },
    'subscriptions.update': async (id, params) => {
      const sub = subscriptions[id]
      sub.cancel_at_period_end = params.cancel_at_period_end
      return structuredClone(sub)
    },
    'customers.retrieve': async (id) => customers[id] ?? { id, invoice_settings: { default_payment_method: null } },
    'invoices.list': async ({ customer }) => ({
      data: [
        {
          id: 'in_secret',
          customer,
          created: 1793232000,
          total: 20000,
          currency: 'usd',
          status: 'paid',
          invoice_pdf: 'https://pay.stripe.com/invoice/acct_1/test_inv/pdf',
          hosted_invoice_url: 'https://invoice.stripe.com/secret',
          customer_email: 'ada@example.com',
        },
      ],
    }),
    'billingPortal.configurations.list': async () => ({ data: portalConfigs }),
    'billingPortal.configurations.create': async (params) => ({ id: 'bpc_created', ...params }),
    'billingPortal.sessions.create': async () => ({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/test_abc' }),
  }
  const node = (path) =>
    new Proxy(function () {}, {
      get: (_t, key) => (typeof key === 'string' ? node(path ? `${path}.${key}` : key) : undefined),
      apply: async (_t, _this, args) => {
        calls.push({ method: path, args })
        if (fail[path]) throw fail[path]
        if (!impl[path]) throw new Error(`unexpected Stripe call ${path}`)
        return impl[path](...args)
      },
    })
  const fake = node('')
  return { stripe: fake, calls, methods: () => calls.map((c) => c.method), callsTo: (m) => calls.filter((c) => c.method === m) }
}

let seq = 0
function customerUser(withSubscription = true) {
  seq += 1
  const fixture = loginFixtureUser(auth, config, { email: `cust${seq}@example.com`, name: `Customer ${seq}` })
  const customer = `cus_user${seq}`
  if (withSubscription) {
    db.prepare('UPDATE user SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?').run(
      customer,
      `sub_of_${customer}`,
      fixture.user.id,
    )
  }
  return { ...fixture, customer, subscription: `sub_of_${customer}` }
}

const statusOf = (userId) => db.prepare('SELECT account_status FROM user WHERE id = ?').get(userId).account_status
const eventCount = (userId) => db.prepare('SELECT COUNT(*) AS n FROM user_event WHERE user_id = ?').get(userId).n

function call(app, method, url, cookie, body) {
  const headers = cookie ? { cookie } : {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) })
}
const ROUTES = [
  ['GET', '/api/billing', undefined],
  ['POST', '/api/billing/cancel', {}],
  ['POST', '/api/billing/resume', {}],
  ['POST', '/api/billing/card-session', {}],
]

test('cancel maps each reason to the same feedback value, sends no feedback for {}, and 400s an unknown reason; resume sends false', async () => {
  const u = customerUser()
  const fake = recordingStripe({ subscriptions: { [u.subscription]: subscriptionFor(u.customer) } })
  const app = buildApp({ logger: false, stripe: fake.stripe })

  for (const reason of ['too_expensive', 'missing_features', 'unused', 'switched_service', 'other']) {
    const res = await call(app, 'POST', '/api/billing/cancel', u.cookie, { reason, comment: '  it was fine  ' })
    assert.equal(res.statusCode, 200, reason)
    assert.equal(res.json().plan.cancel_at_period_end, true)
    assert.equal(res.json().plan.current_period_end, PERIOD_END_ISO)
    const [id, params] = fake.callsTo('subscriptions.update').at(-1).args
    assert.equal(id, u.subscription)
    assert.equal(params.cancel_at_period_end, true)
    assert.deepEqual(params.cancellation_details, { feedback: reason, comment: 'it was fine' })
  }

  const bare = await call(app, 'POST', '/api/billing/cancel', u.cookie, {})
  assert.equal(bare.statusCode, 200)
  const bareParams = fake.callsTo('subscriptions.update').at(-1).args[1]
  assert.equal(bareParams.cancel_at_period_end, true)
  assert.equal(bareParams.cancellation_details, undefined)

  const before = fake.calls.length
  for (const body of [{ reason: 'too_complex' }, { reason: '__proto__' }, { reason: 'constructor' }]) {
    const res = await call(app, 'POST', '/api/billing/cancel', u.cookie, body)
    assert.equal(res.statusCode, 400, JSON.stringify(body))
  }
  assert.equal(fake.calls.length, before, 'no Stripe call for an unknown reason')

  const resumed = await call(app, 'POST', '/api/billing/resume', u.cookie, {})
  assert.equal(resumed.statusCode, 200)
  assert.equal(resumed.json().plan.cancel_at_period_end, false)
  const [resumeId, resumeParams] = fake.callsTo('subscriptions.update').at(-1).args
  assert.equal(resumeId, u.subscription)
  assert.equal(resumeParams.cancel_at_period_end, false)
  assert.equal(resumeParams.cancellation_details, undefined)
  await app.close()
})

test('all four routes are 401 signed out and 404 for a user with no subscription, with no Stripe call', async () => {
  const fake = recordingStripe()
  const app = buildApp({ logger: false, stripe: fake.stripe })
  const none = customerUser(false)
  for (const [method, url, body] of ROUTES) {
    const out = await call(app, method, url, null, body)
    assert.equal(out.statusCode, 401, `${method} ${url} signed out`)
    const missing = await call(app, method, url, none.cookie, body)
    assert.equal(missing.statusCode, 404, `${method} ${url} without a subscription`)
    assert.deepEqual(missing.json(), { error: 'no_subscription' })
  }
  assert.equal(fake.calls.length, 0)
  await app.close()
})

for (const itemPeriod of [true, false]) {
  test(`GET /api/billing returns the plan, current_period_end (${itemPeriod ? 'on the item' : 'top level'}), a 4-key card and 5-key invoices`, async () => {
    const u = customerUser()
    const fake = recordingStripe({ subscriptions: { [u.subscription]: subscriptionFor(u.customer, { itemPeriod }) } })
    const app = buildApp({ logger: false, stripe: fake.stripe })
    const res = await call(app, 'GET', '/api/billing', u.cookie)
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.deepEqual(body.plan, {
      product: 'Horizon Platform',
      amount: 20000,
      currency: 'usd',
      interval: 'month',
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: PERIOD_END_ISO,
    })
    assert.deepEqual(body.card, { brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2028 })
    assert.equal(body.invoices.length, 1)
    assert.deepEqual(body.invoices[0], {
      date: '2026-10-29T00:00:00.000Z',
      amount: 20000,
      currency: 'usd',
      status: 'paid',
      invoice_pdf: 'https://pay.stripe.com/invoice/acct_1/test_inv/pdf',
    })
    for (const secret of ['fp_secret', 'pm_secret', 'in_secret', 'si_secret', 'prod_secret', 'price_secret', u.customer, u.subscription]) {
      assert.ok(!res.body.includes(secret), `${secret} leaked`)
    }
    assert.deepEqual(fake.callsTo('invoices.list')[0].args[0], { customer: u.customer, limit: 12 })
    await app.close()
  })
}

test('card-session opens a payment_method_update flow on a card-only configuration, returning to UI_URL/billing', async () => {
  const u = customerUser()
  const fake = recordingStripe({
    subscriptions: { [u.subscription]: subscriptionFor(u.customer) },
    // A stale config with the right tag but cancel left on is not reused.
    portalConfigs: [
      {
        id: 'bpc_wrong',
        metadata: { horizon_portal: 'card_update_only' },
        features: { payment_method_update: { enabled: true }, subscription_cancel: { enabled: true } },
      },
    ],
  })
  const app = buildApp({ logger: false, stripe: fake.stripe })
  const res = await call(app, 'POST', '/api/billing/card-session', u.cookie, {})
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { url: 'https://billing.stripe.com/p/session/test_abc' })

  const [created] = fake.callsTo('billingPortal.configurations.create')
  assert.deepEqual(created.args[0].features, {
    payment_method_update: { enabled: true },
    customer_update: { enabled: false },
    invoice_history: { enabled: false },
    subscription_cancel: { enabled: false },
    subscription_update: { enabled: false },
  })
  const [session] = fake.callsTo('billingPortal.sessions.create')
  assert.deepEqual(session.args[0], {
    customer: u.customer,
    configuration: 'bpc_created',
    return_url: 'https://shoreward.ai/horizon/billing',
    flow_data: {
      type: 'payment_method_update',
      after_completion: { type: 'redirect', redirect: { return_url: 'https://shoreward.ai/horizon/billing' } },
    },
  })

  // A second session reuses the configuration rather than creating another.
  assert.equal((await call(app, 'POST', '/api/billing/card-session', u.cookie, {})).statusCode, 200)
  assert.equal(fake.callsTo('billingPortal.configurations.create').length, 1)
  assert.equal(fake.callsTo('billingPortal.sessions.create')[1].args[0].configuration, 'bpc_created')
  await app.close()
})

test('no route cancels outright, refunds or changes the plan; a failed portal configuration is 502 with no url', async () => {
  const u = customerUser()
  const fake = recordingStripe({ subscriptions: { [u.subscription]: subscriptionFor(u.customer) } })
  const app = buildApp({ logger: false, stripe: fake.stripe })
  for (const [method, url, body] of ROUTES) assert.equal((await call(app, method, url, u.cookie, body)).statusCode, 200, url)
  assert.equal((await call(app, 'POST', '/api/billing/cancel', u.cookie, { reason: 'unused' })).statusCode, 200)

  const methods = new Set(fake.methods())
  for (const banned of ['subscriptions.cancel', 'subscriptions.del', 'subscriptions.resume', 'refunds.create', 'subscriptionItems.create', 'subscriptionItems.update', 'subscriptionItems.del']) {
    assert.ok(!methods.has(banned), `${banned} was called`)
  }
  assert.ok([...methods].every((m) => !/refund|subscriptionItems|prices|subscriptionSchedules/.test(m)), [...methods].join(','))
  for (const { args } of fake.callsTo('subscriptions.update')) {
    assert.deepEqual(Object.keys(args[1]).filter((k) => !['cancel_at_period_end', 'cancellation_details', 'expand'].includes(k)), [])
  }

  const failing = recordingStripe({
    subscriptions: { [u.subscription]: subscriptionFor(u.customer) },
    fail: { 'billingPortal.configurations.create': stripeError('invalid_request') },
  })
  const app2 = buildApp({ logger: false, stripe: failing.stripe })
  const res = await call(app2, 'POST', '/api/billing/card-session', u.cookie, {})
  assert.equal(res.statusCode, 502)
  assert.deepEqual(res.json(), { error: 'billing_unavailable' })
  assert.equal(failing.callsTo('billingPortal.sessions.create').length, 0)
  await app.close()
  await app2.close()
})

test("each user's calls reach Stripe with their own ids only; ids in a body are 400 and ?customer= is ignored", async () => {
  const a = customerUser()
  const b = customerUser()
  const fake = recordingStripe({
    subscriptions: { [a.subscription]: subscriptionFor(a.customer), [b.subscription]: subscriptionFor(b.customer) },
  })
  const app = buildApp({ logger: false, stripe: fake.stripe })
  for (const [method, url, body] of ROUTES) {
    assert.equal((await call(app, method, `${url}?customer=${b.customer}&subscription=${b.subscription}`, a.cookie, body)).statusCode, 200, url)
  }
  const sent = JSON.stringify(fake.calls.map((c) => c.args))
  assert.ok(sent.includes(a.customer) && sent.includes(a.subscription))
  assert.ok(!sent.includes(b.customer) && !sent.includes(b.subscription), 'B’s ids reached Stripe on A’s calls')

  const before = fake.calls.length
  for (const url of ['/api/billing/cancel', '/api/billing/resume', '/api/billing/card-session']) {
    for (const extra of [{ customer: b.customer }, { subscription_id: b.subscription }]) {
      const res = await call(app, 'POST', url, a.cookie, extra)
      assert.equal(res.statusCode, 400, `${url} ${JSON.stringify(extra)}`)
    }
  }
  assert.equal(fake.calls.length, before)

  // A subscription Stripe says belongs to another customer is not shown.
  const crossed = recordingStripe({ subscriptions: { [a.subscription]: subscriptionFor(b.customer) } })
  const app2 = buildApp({ logger: false, stripe: crossed.stripe })
  assert.equal((await call(app2, 'GET', '/api/billing', a.cookie)).statusCode, 404)
  assert.equal(crossed.callsTo('subscriptions.update').length, 0)
  await app.close()
  await app2.close()
})

test('cancel and resume leave account_status and the user_event rows unchanged', async () => {
  const u = customerUser()
  const fake = recordingStripe({ subscriptions: { [u.subscription]: subscriptionFor(u.customer) } })
  const app = buildApp({ logger: false, stripe: fake.stripe })
  const status = statusOf(u.user.id)
  const events = eventCount(u.user.id)
  assert.equal((await call(app, 'POST', '/api/billing/cancel', u.cookie, { reason: 'other', comment: 'x' })).statusCode, 200)
  assert.equal(statusOf(u.user.id), status)
  assert.equal(eventCount(u.user.id), events)
  assert.equal((await call(app, 'POST', '/api/billing/resume', u.cookie, {})).statusCode, 200)
  assert.equal(statusOf(u.user.id), status)
  assert.equal(eventCount(u.user.id), events)
  await app.close()
})

test('a Stripe error carrying ids, a full card and the key is logged as its type and code only', async () => {
  const u = customerUser()
  const leaks = [u.customer, u.subscription, '4242424242424242', FAKE_STRIPE_ENV.STRIPE_SECRET_KEY, FAKE_LIVE_KEY]
  const err = Object.assign(new Error(`card 4242424242424242 for ${u.customer} ${u.subscription} with ${FAKE_STRIPE_ENV.STRIPE_SECRET_KEY}`), {
    type: 'StripeCardError',
    code: 'card_declined',
    raw: { customer: u.customer, subscription: u.subscription, card: { number: '4242424242424242' }, key: FAKE_LIVE_KEY },
  })
  const lines = []
  const logger = { level: 'trace', stream: { write: (line) => lines.push(line) } }
  const methods = ['subscriptions.retrieve', 'subscriptions.update', 'billingPortal.configurations.list']
  const bodies = []
  for (const method of methods) {
    const fake = recordingStripe({ subscriptions: { [u.subscription]: subscriptionFor(u.customer) }, fail: { [method]: err } })
    const app = buildApp({ logger, stripe: fake.stripe })
    for (const [m, url, body] of ROUTES) {
      const res = await call(app, m, url, u.cookie, body)
      bodies.push(res.body)
    }
    await app.close()
  }
  const logged = lines.join('')
  assert.ok(logged.includes('card_declined'), 'the 502 path logged the Stripe code')
  assert.ok(logged.includes('billing: cancel failed'))
  for (const leak of leaks) {
    assert.ok(!logged.includes(leak), `${leak} reached the log`)
    assert.ok(!bodies.some((body) => body.includes(leak)), `${leak} reached a response`)
  }
})

test('with STRIPE_SECRET_KEY unset all four routes are 503 and /api/auth/me still answers 200', async () => {
  const u = customerUser()
  const fake = recordingStripe({ subscriptions: { [u.subscription]: subscriptionFor(u.customer) } })
  const app = buildApp({ logger: false, stripe: fake.stripe })
  delete process.env.STRIPE_SECRET_KEY
  try {
    for (const [method, url, body] of ROUTES) {
      const res = await call(app, method, url, u.cookie, body)
      assert.equal(res.statusCode, 503, url)
      assert.deepEqual(res.json(), { error: 'billing_not_configured' })
    }
    assert.equal((await call(app, 'GET', '/api/auth/me', u.cookie)).statusCode, 200)
  } finally {
    setFakeStripeEnv()
  }
  assert.equal(fake.calls.length, 0)
  await app.close()
})

test('changing billing needs a browser session: a personal API token gets 403 with no Stripe call', async () => {
  const u = customerUser()
  const fake = recordingStripe({ subscriptions: { [u.subscription]: subscriptionFor(u.customer) } })
  const app = buildApp({ logger: false, stripe: fake.stripe })
  const { token } = auth.createApiToken(u.user.id, 'billing-test')
  for (const [method, url, body] of ROUTES) {
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    })
    assert.equal(res.statusCode, 403, url)
  }
  assert.equal(fake.calls.length, 0)
  await app.close()
})
