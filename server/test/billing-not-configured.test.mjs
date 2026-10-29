// HZ-633: the billing routes' refusals. Bad input is 400 before any Stripe
// call; missing keys are 503 with no Stripe call; and no secret key reaches a
// response body or a log line on any path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FAKE_STRIPE_ENV, fakeStripe, setFakeStripeEnv, stripeError } from './helpers/fakeStripe.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-billing-refusals-')), 'test.db')
delete process.env.HORIZON_REPO
delete process.env.FARM_URL
setFakeStripeEnv()

const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/db.js')

const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM user').get().n
const VALID = { name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Ltd' }

function checkout(app, payload, headers = { 'content-type': 'application/json' }) {
  return app.inject({ method: 'POST', url: '/api/billing/checkout-session', headers, payload })
}
const status = (app, id = 'cs_test_abc') => app.inject({ method: 'GET', url: `/api/billing/session-status?session_id=${id}` })

// Each case resets the keys it removes.
function withoutEnv(names, fn) {
  return async () => {
    for (const name of names) delete process.env[name]
    try {
      await fn()
    } finally {
      setFakeStripeEnv()
    }
  }
}

test('a bad email, a missing name or company, or a non-object body is 400 with no Stripe call', async () => {
  const stripe = fakeStripe()
  const app = buildApp({ logger: false, stripe })
  const usersBefore = userCount()
  const cases = [
    [JSON.stringify({ ...VALID, email: 'not-an-email' }), 'email'],
    [JSON.stringify({ ...VALID, email: 'a b@example.com' }), 'email'],
    [JSON.stringify({ ...VALID, email: `${'a'.repeat(250)}@example.com` }), 'email'],
    [JSON.stringify({ name: VALID.name, company: VALID.company }), 'email'],
    [JSON.stringify({ ...VALID, name: '' }), 'name'],
    [JSON.stringify({ ...VALID, name: '   ' }), 'name'],
    [JSON.stringify({ email: VALID.email, company: VALID.company }), 'name'],
    [JSON.stringify({ ...VALID, company: '' }), 'company'],
    [JSON.stringify({ name: VALID.name, email: VALID.email }), 'company'],
    [JSON.stringify({ ...VALID, company: 'c'.repeat(201) }), 'company'],
  ]
  for (const [payload, field] of cases) {
    const res = await checkout(app, payload)
    assert.equal(res.statusCode, 400, payload)
    assert.deepEqual(res.json(), { error: 'invalid_signup', field }, payload)
  }
  for (const payload of [undefined, '', '[]', '"ada@example.com"', 'null', '{not json']) {
    const res = await checkout(app, payload)
    assert.equal(res.statusCode, 400, String(payload))
  }
  const noType = await checkout(app, undefined, {})
  assert.equal(noType.statusCode, 400)
  assert.equal(stripe.totalCalls(), 0)
  assert.equal(userCount(), usersBefore)
  await app.close()
})

for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID']) {
  test(
    `with ${name} unset both routes are 503 with no Stripe call`,
    withoutEnv([name], async () => {
      const stripe = fakeStripe()
      const app = buildApp({ logger: false, stripe })
      const usersBefore = userCount()
      const a = await checkout(app, JSON.stringify(VALID))
      assert.equal(a.statusCode, 503)
      assert.deepEqual(a.json(), { error: 'billing_not_configured' })
      const b = await status(app)
      assert.equal(b.statusCode, 503)
      assert.deepEqual(b.json(), { error: 'billing_not_configured' })
      assert.equal(stripe.totalCalls(), 0)
      assert.equal(userCount(), usersBefore)
      await app.close()
    }),
  )
}

test(
  'with STRIPE_PUBLISHABLE_KEY unset only checkout-session is 503; session-status still answers',
  withoutEnv(['STRIPE_PUBLISHABLE_KEY'], async () => {
    const stripe = fakeStripe()
    stripe.addSession('cs_test_abc', { status: 'open', customer_details: { email: 'ada@example.com' } })
    const app = buildApp({ logger: false, stripe })
    const a = await checkout(app, JSON.stringify(VALID))
    assert.equal(a.statusCode, 503)
    assert.deepEqual(a.json(), { error: 'billing_not_configured' })
    assert.equal(stripe.calls.customersCreate.length + stripe.calls.sessionsCreate.length, 0)
    const b = await status(app)
    assert.equal(b.statusCode, 200)
    assert.deepEqual(b.json(), { status: 'open', email: 'ada@example.com' })
    await app.close()
  }),
)

test('no Stripe secret or webhook secret appears in any body or log line, on any path', async () => {
  const lines = []
  const logger = { level: 'trace', stream: { write: (line) => lines.push(line) } }
  const bodies = []
  const record = (res) => {
    bodies.push(res.body, JSON.stringify(res.headers))
    return res
  }
  const secrets = [FAKE_STRIPE_ENV.STRIPE_SECRET_KEY, FAKE_STRIPE_ENV.STRIPE_WEBHOOK_SECRET]
  const leaky = `Invalid API Key provided: ${FAKE_STRIPE_ENV.STRIPE_SECRET_KEY} (webhook ${FAKE_STRIPE_ENV.STRIPE_WEBHOOK_SECRET})`

  const stripe = fakeStripe()
  stripe.addSession('cs_test_ok', { status: 'complete', customer_details: { email: 'ada@example.com' } })
  const app = buildApp({ logger, stripe })
  // 200 on both routes.
  assert.equal(record(await checkout(app, JSON.stringify({ ...VALID, email: 'logs@example.com' }))).statusCode, 200)
  assert.equal(record(await status(app, 'cs_test_ok')).statusCode, 200)
  // 400 on both routes.
  assert.equal(record(await checkout(app, JSON.stringify({ ...VALID, email: 'x' }))).statusCode, 400)
  assert.equal(record(await status(app, 'bad')).statusCode, 400)
  // 502 on both routes, from errors whose message carries the keys.
  stripe.fail.sessionsCreate = stripeError('api_key_expired', leaky)
  stripe.fail.sessionsRetrieve = stripeError('api_key_expired', leaky)
  const failedCheckout = record(await checkout(app, JSON.stringify({ ...VALID, email: 'logs@example.com' })))
  assert.equal(failedCheckout.statusCode, 502)
  assert.deepEqual(failedCheckout.json(), { error: 'billing_unavailable' })
  const failedStatus = record(await status(app, 'cs_test_ok'))
  assert.equal(failedStatus.statusCode, 502)
  assert.deepEqual(failedStatus.json(), { error: 'billing_unavailable' })
  // 503 on both routes.
  delete process.env.STRIPE_PRICE_ID
  try {
    assert.equal(record(await checkout(app, JSON.stringify(VALID))).statusCode, 503)
    assert.equal(record(await status(app, 'cs_test_ok')).statusCode, 503)
  } finally {
    setFakeStripeEnv()
  }
  await app.close()

  const logged = lines.join('')
  assert.ok(logged.includes('billing: checkout session failed'), 'the 502 path really logged')
  assert.ok(logged.includes('api_key_expired'), 'the log keeps the Stripe error code')
  for (const secret of secrets) {
    assert.ok(!logged.includes(secret), 'a Stripe secret reached the log')
    assert.ok(!bodies.some((body) => body.includes(secret)), 'a Stripe secret reached a response')
  }
  // The session-status URL carries the session id, which returns an email: it stays out of the request log.
  assert.ok(!logged.includes('cs_test_ok'), 'the session_id reached the request log')
})
