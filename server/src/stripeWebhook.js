// Stripe webhook: keeps user.account_status in sync with billing (HZ-634).
//
// app.js's POST /api/billing/stripe-webhook is the only caller. It checks the
// Stripe-Signature header against the raw request bytes with
// verifyStripeSignature() first, and only then parses the body and calls
// applyStripeEvent(). So the status changes only from a signature-verified
// event: the welcome page and every other client call never reach this code.
//
// The status itself is written through auth.setAccountStatus, the one writer of
// the column (HZ-632), so every change also leaves a user_event audit row.
//
// Nothing here logs. The route logs the event id, type and outcome only: event
// payloads carry the customer's email, and the secret only ever goes to
// createHmac.

import crypto from 'node:crypto'
import { db } from './db.js'
import * as auth from './auth.js'

// Stripe's own default: a signed timestamp more than 5 minutes off is refused,
// so a captured request cannot be replayed later.
export const SIGNATURE_TOLERANCE_SEC = 300

// user_event.who for every status change made here.
export const WEBHOOK_WHO = 'stripe-webhook'

const CHECKOUT_COMPLETED = 'checkout.session.completed'
const INVOICE_PAID = 'invoice.paid'
const INVOICE_PAYMENT_FAILED = 'invoice.payment_failed'
const SUBSCRIPTION_UPDATED = 'customer.subscription.updated'
const SUBSCRIPTION_DELETED = 'customer.subscription.deleted'
const HANDLED_TYPES = new Set([CHECKOUT_COMPLETED, INVOICE_PAID, INVOICE_PAYMENT_FAILED, SUBSCRIPTION_UPDATED, SUBSCRIPTION_DELETED])

// Stripe signs `${t}.${body}` with HMAC-SHA256 and sends
// `t=<unix>,v1=<hex>[,v1=<hex>…]` (several v1 values while a secret rolls).
// True only if the timestamp is within the tolerance and some v1 matches.
// Never throws: a missing or malformed header is just false.
export function verifyStripeSignature(secret, rawBody, header, nowSec = Math.floor(Date.now() / 1000), toleranceSec = SIGNATURE_TOLERANCE_SEC) {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof header !== 'string') return false
  let timestamp = null
  const signatures = []
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') timestamp = value
    else if (key === 'v1') signatures.push(value)
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return false
  if (Math.abs(nowSec - Number(timestamp)) > toleranceSec) return false
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest()
  return signatures.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig) || sig.length !== expected.length * 2) return false
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), expected)
  })
}

// The event as an object with a string id and type, or null. Only called
// after verifyStripeSignature has passed.
export function parseEvent(rawBody) {
  let event
  try {
    event = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  if (typeof event.id !== 'string' || !event.id || typeof event.type !== 'string' || !event.type) return null
  return event
}

// The account status an event sets, or null for "leave it as it is".
// A subscription update that is not a cancel sets 'active' only when Stripe
// says the subscription is active: a failed payment also sends one with status
// 'past_due', and that must not undo the invoice.payment_failed just applied.
export function statusForEvent(event) {
  const object = event?.data?.object ?? {}
  switch (event?.type) {
    case CHECKOUT_COMPLETED:
    case INVOICE_PAID:
      return 'active'
    case INVOICE_PAYMENT_FAILED:
      return 'past_due'
    case SUBSCRIPTION_UPDATED:
      if (object.cancel_at_period_end) return 'cancelling'
      return object.status === 'active' || object.status === 'trialing' ? 'active' : null
    case SUBSCRIPTION_DELETED:
      return 'cancelled'
    default:
      return null
  }
}

// Stripe sends an id as a string, or as the object when it was expanded.
function idOf(value) {
  if (typeof value === 'string') return value || null
  return typeof value?.id === 'string' ? value.id : null
}

// The subscription an invoice or subscription event is about. Since API
// version 2025-03-31 an invoice names it under parent.subscription_details.
function subscriptionOf(type, object) {
  if (type === SUBSCRIPTION_UPDATED || type === SUBSCRIPTION_DELETED) return idOf(object.id)
  return idOf(object.parent?.subscription_details?.subscription) ?? idOf(object.subscription)
}

// The company the buyer typed into a `company` custom field, else Stripe's
// business name, else null.
function companyOf(session) {
  const fields = Array.isArray(session.custom_fields) ? session.custom_fields : []
  const field = fields.find((f) => f?.key === 'company')
  const typed = typeof field?.text?.value === 'string' ? field.text.value.trim() : ''
  if (typed) return typed
  const business = session.customer_details?.business_name
  return typeof business === 'string' && business.trim() ? business.trim() : null
}

const USER_COLUMNS = 'id, email, name, company, stripe_customer_id, stripe_subscription_id'
const userById = (id) => db.prepare(`SELECT ${USER_COLUMNS} FROM user WHERE id = ?`).get(id)
const userByEmail = (email) => db.prepare(`SELECT ${USER_COLUMNS} FROM user WHERE lower(email) = lower(?)`).get(email)
const userByCustomer = (customerId) => db.prepare(`SELECT ${USER_COLUMNS} FROM user WHERE stripe_customer_id = ?`).get(customerId)

const nonEmptyString = (value) => (typeof value === 'string' && value ? value : null)

// Checkout names the Horizon user it was created for (HZ-633 sets
// client_reference_id); a Payment Link does not, so the buyer's email is the
// fallback. Every later event finds the user by the stored Stripe customer;
// invoices also fall back to their email, because Stripe may send invoice.paid
// before checkout.session.completed.
function findUser(type, object) {
  if (type === CHECKOUT_COMPLETED) {
    const ref = nonEmptyString(object.client_reference_id)
    const byRef = ref ? userById(ref) : null
    if (byRef) return byRef
    const email = nonEmptyString(object.customer_details?.email) ?? nonEmptyString(object.customer_email)
    return email ? userByEmail(email) : null
  }
  const customer = idOf(object.customer)
  const byCustomer = customer ? userByCustomer(customer) : null
  if (byCustomer) return byCustomer
  if (type === INVOICE_PAID || type === INVOICE_PAYMENT_FAILED) {
    const email = nonEmptyString(object.customer_email)
    return email ? userByEmail(email) : null
  }
  return null
}

// Applies one verified event in a single transaction:
//   1. records the event id; an id already recorded is a no-op (duplicate);
//   2. finds the user; none is recorded as processed with no change;
//   3. on checkout, stores the Stripe customer, subscription and company;
//   4. sets the status through auth.setAccountStatus;
//   5. claims the owner's email the first time a checked-out user is active.
// Returns { duplicate, outcome, userId, status, notifyOwner }. notifyOwner is
// { name, email, company } when the caller must send the owner's email, and
// the caller hands userId to releaseOwnerNotice if that send fails. A throw
// rolls everything back, so the event id stays unrecorded and Stripe retries.
export function applyStripeEvent(event) {
  return db
    .transaction(() => {
      const recorded = db.prepare('INSERT OR IGNORE INTO stripe_event (id, type) VALUES (?, ?)').run(event.id, event.type)
      const result = { duplicate: false, outcome: 'applied', userId: null, status: null, notifyOwner: null }
      if (recorded.changes === 0) return { ...result, duplicate: true, outcome: 'duplicate' }
      if (!HANDLED_TYPES.has(event.type)) return { ...result, outcome: 'ignored' }

      const object = event.data?.object && typeof event.data.object === 'object' ? event.data.object : {}
      const user = findUser(event.type, object)
      if (!user) return { ...result, outcome: 'no_user' }
      result.userId = user.id

      if (event.type === CHECKOUT_COMPLETED) {
        const customer = idOf(object.customer)
        const holder = customer ? userByCustomer(customer) : null
        // Another account already holds this Stripe customer: change neither,
        // and answer 2xx so Stripe does not retry for days.
        if (holder && holder.id !== user.id) return { ...result, outcome: 'customer_conflict' }
        db.prepare(
          `UPDATE user SET stripe_customer_id = COALESCE(?, stripe_customer_id),
             stripe_subscription_id = COALESCE(?, stripe_subscription_id), company = COALESCE(company, ?)
           WHERE id = ?`,
        ).run(customer, idOf(object.subscription), companyOf(object), user.id)
      } else {
        // An event for an older subscription must not overwrite the current one.
        const subscription = subscriptionOf(event.type, object)
        if (user.stripe_subscription_id && subscription && subscription !== user.stripe_subscription_id) {
          return { ...result, outcome: 'other_subscription' }
        }
      }

      const status = statusForEvent(event)
      if (status) {
        const written = auth.setAccountStatus(user.id, status, WEBHOOK_WHO)
        if (written.error) throw new Error(`setAccountStatus: ${written.error}`)
        result.status = status
      }

      // Only once checkout has stored the subscription: an invoice.paid that
      // arrives first must not send the email before the company is known.
      if (status === 'active') {
        const claimed = db
          .prepare(
            `UPDATE user SET owner_notified_at = datetime('now')
             WHERE id = ? AND owner_notified_at IS NULL AND stripe_subscription_id IS NOT NULL`,
          )
          .run(user.id)
        if (claimed.changes === 1) {
          const row = userById(user.id)
          result.notifyOwner = { name: row.name, email: row.email, company: row.company ?? null }
        }
      }
      return result
    })
    .immediate()
}

// The owner's email could not be sent: un-claim it, so the next event that
// keeps this user active tries again.
export function releaseOwnerNotice(userId) {
  db.prepare('UPDATE user SET owner_notified_at = NULL WHERE id = ?').run(userId)
}
