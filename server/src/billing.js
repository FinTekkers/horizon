// Stripe Embedded Checkout for shoreward.ai's sign-up page (HZ-633).
//
// Two public routes in app.js use this module: POST /api/billing/checkout-session
// and GET /api/billing/session-status. Neither grants access, starts a session
// or sets a cookie — payment unlocks an account later, through the webhook
// (HZ-634). The only place in server/src that imports `stripe`.
//
// The Stripe client is an argument everywhere, so tests pass a fake with the
// three methods used here and nothing ever calls Stripe for real. Production
// gets stripeClient(), built from STRIPE_SECRET_KEY. The SDK is pinned exactly
// in server/package.json: stripe 23.0.1 sends API version 2026-09-30.endive,
// which accepts ui_mode 'embedded_page' (older versions call it 'embedded').

import Stripe from 'stripe'
import { db } from './db.js'
import * as auth from './auth.js'
import { stripeConfig } from './config.js'

// Stripe fills in {CHECKOUT_SESSION_ID}; the welcome page reads it back.
export const SIGNUP_RETURN_URL = 'https://shoreward.ai/welcome.html?session_id={CHECKOUT_SESSION_ID}'

export const SIGNUP_FIELD_MAX = 200
export const EMAIL_MAX = 254
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const SESSION_ID_RE = /^cs_(live|test)_[A-Za-z0-9]+$/

// The secret key and price are needed by both routes. Only checkout-session
// hands out the publishable key, so only it also needs that one.
export function billingReady({ needPublishable = false } = {}) {
  const { secretKey, publishableKey, priceId } = stripeConfig()
  return Boolean(secretKey && priceId && (!needPublishable || publishableKey))
}

// { ok: true, value: { name, email, company } } with each field trimmed, or
// { error: 'invalid_signup', field } naming the first bad field. ADMIN_EMAIL
// (and ADMIN_EMAILS) are refused: a sign-up must never create or touch an
// admin's row.
export function validateSignup(body) {
  const fields = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const trimmed = (key) => (typeof fields[key] === 'string' ? fields[key].trim() : '')
  const name = trimmed('name')
  const email = trimmed('email')
  const company = trimmed('company')
  if (!name || name.length > SIGNUP_FIELD_MAX) return { error: 'invalid_signup', field: 'name' }
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email) || auth.isAdmin({ email })) {
    return { error: 'invalid_signup', field: 'email' }
  }
  if (!company || company.length > SIGNUP_FIELD_MAX) return { error: 'invalid_signup', field: 'company' }
  return { ok: true, value: { name, email, company } }
}

// The account for this email, created as a pending_payment sign-up only if
// there is none. An existing account's status, name and company are never
// changed, so an active user is never reset to pending_payment.
export function findOrCreateSignup({ name, email, company }) {
  return db
    .transaction(() => {
      const existing = auth.billingProfileByEmail(email)
      if (existing) return existing
      auth.createSignupUser({ email, name, company })
      return auth.billingProfileByEmail(email)
    })
    .immediate()
}

// The Stripe customer is built from the stored row, not the request, so a
// retry under the same idempotency key always sends the same params (Stripe
// rejects a reused key with different ones). Two racing first calls share the
// key, so Stripe returns one customer to both.
async function ensureCustomer(stripe, profile) {
  if (profile.stripe_customer_id) return profile.stripe_customer_id
  const params = { email: profile.email, name: profile.name, metadata: { horizon_user_id: profile.id } }
  if (profile.company) params.metadata.company = profile.company
  const customer = await stripe.customers.create(params, { idempotencyKey: `hz-signup-customer-${profile.id}` })
  auth.setStripeCustomerId(profile.id, customer.id)
  return auth.billingProfileByEmail(profile.email).stripe_customer_id
}

// input is validateSignup's value. Returns exactly what the sign-up page needs.
export async function createCheckoutSession(stripe, input) {
  const { publishableKey, priceId } = stripeConfig()
  const profile = findOrCreateSignup(input)
  const customer = await ensureCustomer(stripe, profile)
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    ui_mode: 'embedded_page',
    line_items: [{ price: priceId, quantity: 1 }],
    customer,
    client_reference_id: profile.id,
    return_url: SIGNUP_RETURN_URL,
  })
  return { clientSecret: session.client_secret, publishableKey }
}

// Only the status ('open', 'complete' or 'expired') and the email are copied
// out of the session.
export async function getSessionStatus(stripe, sessionId) {
  const session = await stripe.checkout.sessions.retrieve(sessionId)
  return { status: session.status, email: session.customer_details?.email ?? null }
}

// For a log line: the Stripe error's type and code only. The message can echo
// request details, so it is never logged or returned.
export function stripeErrorSummary(err) {
  const pick = (value) => (typeof value === 'string' && /^[A-Za-z_]{1,64}$/.test(value) ? value : null)
  return { stripeErrorType: pick(err?.type), stripeErrorCode: pick(err?.code) }
}

let client = null
let clientKey = null

// Production's client, built lazily and rebuilt if the key changes. Callers
// check billingReady() first.
export function stripeClient() {
  const { secretKey } = stripeConfig()
  if (!client || clientKey !== secretKey) {
    client = new Stripe(secretKey, { maxNetworkRetries: 2 })
    clientKey = secretKey
  }
  return client
}
