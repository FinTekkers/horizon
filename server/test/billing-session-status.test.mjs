// HZ-633: GET /api/billing/session-status, against a fake Stripe client. The
// welcome page reads { status, email } and nothing else; the route never
// grants access or sets a cookie.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fakeStripe, setFakeStripeEnv } from './helpers/fakeStripe.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-billing-status-')), 'test.db')
delete process.env.HORIZON_REPO
delete process.env.FARM_URL
setFakeStripeEnv()

const { buildApp } = await import('../src/app.js')

const status = (app, query) => app.inject({ method: 'GET', url: `/api/billing/session-status${query}` })

for (const [id, state] of [
  ['cs_test_complete1', 'complete'],
  ['cs_test_open1', 'open'],
  ['cs_live_expired1', 'expired'],
]) {
  test(`a session in status ${state} returns exactly { status, email } and sets no cookie`, async () => {
    const stripe = fakeStripe()
    stripe.addSession(id, {
      id,
      status: state,
      client_secret: `${id}_secret_x`,
      customer: 'cus_x',
      customer_details: { email: 'ada@example.com', name: 'Ada' },
      client_reference_id: 'user-1',
    })
    const app = buildApp({ logger: false, stripe })
    const res = await status(app, `?session_id=${id}`)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { status: state, email: 'ada@example.com' })
    assert.equal(res.headers['set-cookie'], undefined)
    assert.deepEqual(stripe.calls.sessionsRetrieve, [id])
    await app.close()
  })
}

test('a missing, empty or malformed session_id is 400 with no Stripe call', async () => {
  const stripe = fakeStripe()
  const app = buildApp({ logger: false, stripe })
  for (const query of ['', '?session_id=', '?session_id=foo', '?session_id=cs_test_a%2Fb', `?session_id=cs_test_${'a'.repeat(300)}`]) {
    const res = await status(app, query)
    assert.equal(res.statusCode, 400, query)
    assert.deepEqual(res.json(), { error: 'invalid_session_id' })
  }
  assert.equal(stripe.calls.sessionsRetrieve.length, 0)
  await app.close()
})

test('an unknown session is 404 not_found', async () => {
  const app = buildApp({ logger: false, stripe: fakeStripe() })
  const res = await status(app, '?session_id=cs_test_nosuch')
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'not_found' })
  await app.close()
})
