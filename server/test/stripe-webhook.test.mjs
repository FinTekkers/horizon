// HZ-634: POST /api/billing/stripe-webhook. Each event is signed here the way
// Stripe signs it (HMAC-SHA256 of `${t}.${body}`), with a test secret, and sent
// through fastify.inject. The owner's email goes to a stub mailer that records
// every message. Every test seeds its own user, Stripe ids and event ids.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { FAKE_STRIPE_ENV, setFakeStripeEnv } from './helpers/fakeStripe.mjs'
import { repoFiles, relative, stripComments } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-stripe-webhook-')), 'test.db')
process.env.ADMIN_EMAIL = 'admin@example.com'
process.env.ADMIN_PASSWORD = 'super-secret'
process.env.ALLOWED_LOGIN_EMAILS = ''
process.env.OWNER_NOTIFY_EMAIL = 'owner@example.com'
delete process.env.HORIZON_REPO
delete process.env.FARM_URL
setFakeStripeEnv()

const SECRET = FAKE_STRIPE_ENV.STRIPE_WEBHOOK_SECRET
const URL_PATH = '/api/billing/stripe-webhook'

const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const { db } = await import('../src/db.js')

function stubMailer() {
  const sent = []
  return { sent, sendMail: async (msg) => void sent.push(msg) }
}

function appWith(mailer = stubMailer(), logger = false) {
  return { app: buildApp({ logger, mailer }), mailer }
}

const now = () => Math.floor(Date.now() / 1000)

function sign(body, { secret = SECRET, t = now() } = {}) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

// Sends `event` (an object, or an exact body string) signed for `signedBody`
// (default: the body sent). header: null sends no Stripe-Signature at all.
function post(app, event, { header, signedBody, secret, t, contentType = 'application/json' } = {}) {
  const body = typeof event === 'string' ? event : JSON.stringify(event)
  const headers = { 'content-type': contentType }
  const sig = header === undefined ? sign(signedBody ?? body, { secret, t }) : header
  if (sig !== null) headers['stripe-signature'] = sig
  return app.inject({ method: 'POST', url: URL_PATH, headers, payload: body })
}

let seq = 0
// A fresh pending_payment sign-up with its own Stripe ids, as HZ-633 leaves it.
function seedUser({ company = 'Analytical Ltd', name = 'Ada Lovelace', withCustomer = true } = {}) {
  seq += 1
  const tag = `${process.pid}_${seq}`
  const email = `user${tag}@example.com`
  const user = auth.createSignupUser({ email, name, company })
  const customer = `cus_test_${tag}`
  if (withCustomer) auth.setStripeCustomerId(user.id, customer)
  return { id: user.id, email, name, company, customer, subscription: `sub_test_${tag}`, tag }
}

const row = (id) => db.prepare('SELECT * FROM user WHERE id = ?').get(id)
const statusOf = (id) => row(id).account_status
const eventRows = (id) => db.prepare('SELECT COUNT(*) AS n FROM stripe_event WHERE id = ?').get(id).n
const allEventRows = () => db.prepare('SELECT COUNT(*) AS n FROM stripe_event').get().n

const evtId = (label) => `evt_test_${label}_${process.pid}_${++seq}`

function checkoutEvent(user, { ref = user.id, email = user.email, company = 'Analytical Ltd', id = evtId('checkout') } = {}) {
  return {
    id,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_test_${user.tag}`,
        object: 'checkout.session',
        client_reference_id: ref,
        customer: user.customer,
        subscription: user.subscription,
        customer_details: { email, name: user.name, business_name: null },
        custom_fields: company ? [{ key: 'company', type: 'text', text: { value: company } }] : [],
      },
    },
  }
}

function invoiceEvent(type, user, { id = evtId('invoice'), customer = user.customer, subscription = user.subscription } = {}) {
  return {
    id,
    object: 'event',
    type,
    data: {
      object: {
        id: `in_test_${user.tag}`,
        object: 'invoice',
        customer,
        customer_email: user.email,
        parent: { type: 'subscription_details', subscription_details: { subscription } },
      },
    },
  }
}

function subscriptionEvent(type, user, { cancel = false, status = 'active', id = evtId('sub') } = {}) {
  return {
    id,
    object: 'event',
    type,
    data: { object: { id: user.subscription, object: 'subscription', customer: user.customer, cancel_at_period_end: cancel, status } },
  }
}

async function send(app, event, opts) {
  const res = await post(app, event, opts)
  assert.equal(res.statusCode, 200, res.body)
  return res
}

test('each of the five events, signed, sets the listed status; checkout stores the customer, subscription and company', async () => {
  const { app } = appWith()
  const user = seedUser({ company: null, withCustomer: false })
  assert.equal(statusOf(user.id), 'pending_payment')

  await send(app, checkoutEvent(user, { company: 'Difference Engines plc' }))
  const afterCheckout = row(user.id)
  assert.equal(afterCheckout.account_status, 'active')
  assert.equal(afterCheckout.stripe_customer_id, user.customer)
  assert.equal(afterCheckout.stripe_subscription_id, user.subscription)
  assert.equal(afterCheckout.company, 'Difference Engines plc')

  await send(app, invoiceEvent('invoice.payment_failed', user))
  assert.equal(statusOf(user.id), 'past_due')
  await send(app, invoiceEvent('invoice.paid', user))
  assert.equal(statusOf(user.id), 'active')
  await send(app, subscriptionEvent('customer.subscription.updated', user, { cancel: true }))
  assert.equal(statusOf(user.id), 'cancelling')
  await send(app, subscriptionEvent('customer.subscription.deleted', user, { status: 'canceled' }))
  assert.equal(statusOf(user.id), 'cancelled')

  // Every change went through setAccountStatus, so each left an audit row.
  const audit = db
    .prepare("SELECT new_value, who FROM user_event WHERE user_id = ? AND kind = 'account_status' ORDER BY id")
    .all(user.id)
  assert.deepEqual(
    audit.map((a) => a.new_value),
    ['active', 'past_due', 'active', 'cancelling', 'cancelled'],
  )
  assert.ok(audit.every((a) => a.who === 'stripe-webhook'))
})

test('customer.subscription.updated without a cancel, status active, takes cancelling back to active and sends no email', async () => {
  const { app, mailer } = appWith()
  const user = seedUser()
  await send(app, checkoutEvent(user))
  await send(app, subscriptionEvent('customer.subscription.updated', user, { cancel: true }))
  assert.equal(statusOf(user.id), 'cancelling')
  const mails = mailer.sent.length

  await send(app, subscriptionEvent('customer.subscription.updated', user, { cancel: false, status: 'active' }))
  assert.equal(statusOf(user.id), 'active')
  assert.equal(mailer.sent.length, mails)
})

test('invoice.payment_failed then customer.subscription.updated with status past_due keeps past_due', async () => {
  const { app } = appWith()
  const user = seedUser()
  await send(app, checkoutEvent(user))
  await send(app, invoiceEvent('invoice.payment_failed', user))
  assert.equal(statusOf(user.id), 'past_due')

  await send(app, subscriptionEvent('customer.subscription.updated', user, { cancel: false, status: 'past_due' }))
  assert.equal(statusOf(user.id), 'past_due')
})

test('a replayed event id answers 2xx with duplicate: true, leaves the status unchanged and sends no email', async () => {
  const { app, mailer } = appWith()
  const user = seedUser()
  const checkout = checkoutEvent(user)
  await send(app, checkout)
  assert.equal(mailer.sent.length, 1)
  const failed = invoiceEvent('invoice.payment_failed', user)
  await send(app, failed)
  assert.equal(statusOf(user.id), 'past_due')

  // The checkout replay would set 'active' and the failure replay is a no-op
  // on its own value; neither may apply.
  for (const event of [checkout, failed]) {
    const res = await send(app, event)
    assert.deepEqual(res.json(), { received: true, duplicate: true })
    assert.equal(statusOf(user.id), 'past_due')
    assert.equal(eventRows(event.id), 1)
  }
  assert.equal(mailer.sent.length, 1)
})

test('a missing header, a wrong secret or a stale timestamp answers 400 and changes nothing', async () => {
  const { app, mailer } = appWith()
  const user = seedUser()
  const before = row(user.id)
  const events = allEventRows()
  const cases = [
    ['missing header', { header: null }],
    ['wrong secret', { secret: 'not-the-webhook-secret' }],
    ['stale t', { t: now() - 301 }],
  ]
  for (const [label, opts] of cases) {
    const event = checkoutEvent(user)
    const res = await post(app, event, opts)
    assert.equal(res.statusCode, 400, label)
    assert.deepEqual(res.json(), { error: 'bad_signature' }, label)
    assert.equal(eventRows(event.id), 0, label)
  }
  assert.equal(allEventRows(), events)
  assert.deepEqual(row(user.id), before)
  assert.equal(mailer.sent.length, 0)
})

test('a tampered body, t=abc or a wrong-length v1 answers 400 without throwing', async () => {
  const { app } = appWith()
  const user = seedUser()
  const before = row(user.id)
  const events = allEventRows()
  const signedFor = JSON.stringify(invoiceEvent('invoice.payment_failed', user))
  const sent = checkoutEvent(user)
  const good = sign(JSON.stringify(sent)).split(',')[1]
  const cases = [
    ['tampered body', { signedBody: signedFor }],
    ['t=abc', { header: `t=abc,${good}` }],
    ['short v1', { header: `t=${now()},v1=abcd` }],
    ['long v1', { header: `t=${now()},${good}00` }],
    ['no v1', { header: `t=${now()}` }],
    ['garbage', { header: ',,=,' }],
  ]
  for (const [label, opts] of cases) {
    const res = await post(app, sent, opts)
    assert.equal(res.statusCode, 400, label)
    assert.deepEqual(res.json(), { error: 'bad_signature' }, label)
  }
  assert.equal(allEventRows(), events)
  assert.deepEqual(row(user.id), before)
})

test('checkout sends the owner exactly one email with name, email and company; a later invoice.paid sends none', async () => {
  const { app, mailer } = appWith()
  const user = seedUser({ name: 'Grace Hopper', company: 'Compilers Inc' })
  await send(app, checkoutEvent(user))
  assert.equal(mailer.sent.length, 1)
  const [mail] = mailer.sent
  assert.equal(mail.to, 'owner@example.com')
  assert.match(mail.subject, /Grace Hopper/)
  assert.match(mail.text, /name: Grace Hopper/)
  assert.match(mail.text, new RegExp(`email: ${user.email}`))
  assert.match(mail.text, /company: Compilers Inc/)
  assert.ok(row(user.id).owner_notified_at)

  await send(app, invoiceEvent('invoice.paid', user))
  assert.equal(statusOf(user.id), 'active')
  assert.equal(mailer.sent.length, 1)
})

test('invoice.paid before checkout, then checkout with a company field, sends exactly one email with the company', async () => {
  const { app, mailer } = appWith()
  const user = seedUser({ company: null })
  await send(app, invoiceEvent('invoice.paid', user))
  assert.equal(statusOf(user.id), 'active')
  assert.equal(mailer.sent.length, 0)

  await send(app, checkoutEvent(user, { company: 'Late Arrivals Ltd' }))
  assert.equal(mailer.sent.length, 1)
  assert.match(mailer.sent[0].text, /company: Late Arrivals Ltd/)
})

test('checkout with no client_reference_id matches the user by a mixed-case email and turns them active', async () => {
  const { app } = appWith()
  const user = seedUser({ withCustomer: false })
  const mixed = user.email.replace(/^user/, 'User').replace('@example.com', '@Example.COM')
  assert.notEqual(mixed, user.email)
  await send(app, checkoutEvent(user, { ref: null, email: mixed }))
  const after = row(user.id)
  assert.equal(after.account_status, 'active')
  assert.equal(after.stripe_customer_id, user.customer)
  assert.equal(after.stripe_subscription_id, user.subscription)
})

test('a pretty-printed, non-ASCII event sent as application/json; charset=utf-8 verifies against its exact bytes', async () => {
  const { app, mailer } = appWith()
  const user = seedUser({ name: 'José Núñez', company: 'Café Ltd' })
  const body = JSON.stringify(checkoutEvent(user), null, 2)
  await send(app, body, { contentType: 'application/json; charset=utf-8' })
  assert.equal(statusOf(user.id), 'active')
  assert.match(mailer.sent[0].text, /name: José Núñez/)
})

test('logs and responses never carry the secret, the customer email, the company or the signature header', async () => {
  let logs = ''
  const stream = new Writable({
    write(chunk, _enc, done) {
      logs += chunk.toString()
      done()
    },
  })
  const { app } = appWith(stubMailer(), { level: 'trace', stream })
  const user = seedUser({ company: 'Secretive Holdings' })
  const event = checkoutEvent(user)
  const body = JSON.stringify(event)
  const header = sign(body)
  const ok = await post(app, body, { header })
  assert.equal(ok.statusCode, 200)
  const badHeader = sign(body, { secret: 'not-the-webhook-secret' })
  const bad = await post(app, body, { header: badHeader })
  assert.equal(bad.statusCode, 400)
  assert.equal(statusOf(user.id), 'active')

  assert.match(logs, new RegExp(event.id), 'the event id is logged')
  const seen = logs + ok.body + bad.body
  for (const secret of [SECRET, user.email, 'Secretive Holdings', header, badHeader, header.split('v1=')[1]]) {
    assert.ok(!seen.includes(secret), `leaked: ${secret}`)
  }
})

// Guardrail 1: the status changes only from a signature-verified webhook. The
// writer scan in account-status-writers.test.mjs pins the SQL to
// setAccountStatus; this pins setAccountStatus's callers to the webhook, and
// the webhook route to verifying before it applies.
test('only the verified Stripe webhook changes account_status', () => {
  const callers = []
  const appliers = []
  for (const rel of repoFiles().map((file) => relative(file))) {
    if (!rel.startsWith('server/src/') || !/\.(m?js|cjs)$/.test(rel)) continue
    const text = stripComments(readFileSync(join(fileURLToPath(new URL('../..', import.meta.url)), rel), 'utf8'))
    if (/\bsetAccountStatus\s*\(/.test(text)) callers.push(rel)
    if (/\bapplyStripeEvent\s*\(/.test(text)) appliers.push(rel)
  }
  assert.deepEqual(callers, ['server/src/auth.js', 'server/src/stripeWebhook.js'])
  assert.deepEqual(appliers, ['server/src/app.js', 'server/src/stripeWebhook.js'])

  const app = stripComments(readFileSync(fileURLToPath(new URL('../src/app.js', import.meta.url)), 'utf8'))
  const route = app.slice(app.indexOf(`'${URL_PATH}'`))
  const verify = route.indexOf('verifyStripeSignature(')
  const apply = route.indexOf('applyStripeEvent(')
  assert.ok(verify > 0 && apply > verify, 'the route verifies the signature before applying the event')
  assert.equal(app.split('applyStripeEvent(').length - 1, 1, 'applyStripeEvent has one call site')
})

test('a cancelled user still signs in by the existing path', async () => {
  const { app } = appWith()
  const login = () =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'admin@example.com', password: 'super-secret' }),
    })
  const first = await login()
  assert.equal(first.statusCode, 200, first.body)
  const admin = auth.findUserByEmail('admin@example.com')
  assert.equal(auth.setAccountStatus(admin.id, 'cancelled', 'test').ok, true)

  const again = await login()
  assert.equal(again.statusCode, 200, again.body)
  assert.equal(again.json().user.account_status, 'cancelled')
})

const APP_MODULE = fileURLToPath(new URL('../src/app.js', import.meta.url))

// Each boot is its own process, the way the server opens the DB.
function boot(path) {
  const env = { ...process.env, HORIZON_DB: path }
  delete env.HORIZON_REPO
  const script = `const { buildApp } = await import(${JSON.stringify(APP_MODULE)}); await buildApp({ logger: false }).close()`
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, timeout: 60_000 })
}

test('buildApp boots twice on one DB, and on a DB that already has account_status but not this migration', () => {
  const twice = join(mkdtempSync(join(tmpdir(), 'horizon-stripe-webhook-boot-')), 'test.db')
  boot(twice)
  boot(twice)

  // A DB as HZ-632/633 left it: account_status and the Stripe ids, but no
  // stripe_event table and no owner_notified_at.
  const older = join(mkdtempSync(join(tmpdir(), 'horizon-stripe-webhook-boot-')), 'test.db')
  boot(older)
  const raw = new Database(older)
  raw.exec('DROP TABLE stripe_event; ALTER TABLE user DROP COLUMN owner_notified_at')
  const columns = () => raw.prepare('PRAGMA table_info(user)').all().map((c) => c.name)
  assert.ok(columns().includes('account_status'))
  raw.close()
  boot(older)

  const after = new Database(older, { readonly: true })
  const cols = after.prepare('PRAGMA table_info(user)').all().map((c) => c.name)
  assert.ok(cols.includes('account_status') && cols.includes('owner_notified_at'))
  assert.ok(after.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stripe_event'").get())
  after.close()
})
