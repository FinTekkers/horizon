// Stripe Embedded Checkout for shoreward.ai's sign-up page (HZ-633), and the
// signed-in customer's billing page (HZ-636, at the end of this file).
//
// Two public routes in app.js use the first half: POST /api/billing/checkout-session
// and GET /api/billing/session-status. Neither grants access, starts a session
// or sets a cookie — payment unlocks an account later, through the webhook
// (HZ-634). The only place in server/src that imports `stripe`.
//
// The Stripe client is an argument everywhere, so tests pass a fake with the
// methods used here and nothing ever calls Stripe for real. Production
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
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email) || auth.isAdminEmail(email)) {
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

// ---- the signed-in customer's own subscription (HZ-636) ----
//
// Four session routes in app.js use the functions below: GET /api/billing,
// POST /api/billing/cancel, /resume and /card-session. The Stripe customer and
// subscription are always the ones stored on the signed-in user's row
// (billingAccount); no request field ever names them. Cancelling only ever
// sets cancel_at_period_end, and nothing here writes account_status: the
// webhook (stripeWebhook.js) moves it to 'cancelling' or back to 'active' once
// Stripe reports the change.

// The cancellation screen's reasons, each sent to Stripe as the
// cancellation_details.feedback value of the same name.
export const CANCEL_REASONS = ['too_expensive', 'missing_features', 'unused', 'switched_service', 'other']
const REASON_TO_FEEDBACK = Object.freeze(Object.fromEntries(CANCEL_REASONS.map((reason) => [reason, reason])))
export const CANCEL_COMMENT_MAX = 500

// The only portal Horizon opens: card update, with every other action off.
// Found again by its metadata after a restart rather than created each time.
export const PORTAL_CONFIG_METADATA = Object.freeze({ horizon_portal: 'card_update_only' })
export const CARD_ONLY_FEATURES = Object.freeze({
  payment_method_update: { enabled: true },
  customer_update: { enabled: false },
  invoice_history: { enabled: false },
  subscription_cancel: { enabled: false },
  subscription_update: { enabled: false },
})

const SUBSCRIPTION_EXPAND = ['default_payment_method', 'items.data.price.product']
const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired'])
export const INVOICE_LIMIT = 12

// A refusal the routes answer with as-is: { error: code } and this status.
export class BillingError extends Error {
  constructor(code, status) {
    super(code)
    this.code = code
    this.status = status
  }
}

// The four subscription routes need only the secret key, not the price.
export function subscriptionBillingReady() {
  return Boolean(stripeConfig().secretKey)
}

// The signed-in user's Stripe ids, or null when they have no subscription.
export function billingAccount(userId) {
  const row = db.prepare('SELECT stripe_customer_id, stripe_subscription_id FROM user WHERE id = ?').get(userId)
  if (!row?.stripe_customer_id || !row?.stripe_subscription_id) return null
  return { customerId: row.stripe_customer_id, subscriptionId: row.stripe_subscription_id }
}

const isoFromUnix = (sec) => (Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null)
const idOf = (value) => (typeof value === 'string' ? value : typeof value?.id === 'string' ? value.id : null)

// Newer API versions keep current_period_end on the item; older ones on the
// subscription itself.
export function planView(subscription) {
  const item = subscription.items?.data?.[0]
  const price = item?.price
  const product = price?.product
  return {
    product: typeof product?.name === 'string' ? product.name : null,
    amount: Number.isFinite(price?.unit_amount) ? price.unit_amount : null,
    currency: typeof price?.currency === 'string' ? price.currency : null,
    interval: typeof price?.recurring?.interval === 'string' ? price.recurring.interval : null,
    status: subscription.status,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    current_period_end: isoFromUnix(item?.current_period_end ?? subscription.current_period_end),
  }
}

// Brand, last 4 and expiry only; null for no card.
export function cardView(paymentMethod) {
  const card = paymentMethod && typeof paymentMethod === 'object' ? paymentMethod.card : null
  if (!card) return null
  return { brand: card.brand, last4: card.last4, exp_month: card.exp_month, exp_year: card.exp_year }
}

function invoiceView(invoice) {
  return {
    date: isoFromUnix(invoice.created),
    amount: invoice.total,
    currency: invoice.currency,
    status: invoice.status,
    invoice_pdf: invoice.invoice_pdf ?? null,
  }
}

// The user's subscription, refused as theirs only if Stripe agrees it belongs
// to their customer.
async function ownSubscription(stripe, account) {
  const subscription = await stripe.subscriptions.retrieve(account.subscriptionId, { expand: SUBSCRIPTION_EXPAND })
  if (idOf(subscription.customer) !== account.customerId) throw new BillingError('no_subscription', 404)
  return subscription
}

export async function getBilling(stripe, account) {
  const subscription = await ownSubscription(stripe, account)
  let paymentMethod = subscription.default_payment_method
  if (!paymentMethod || typeof paymentMethod !== 'object') {
    const customer = await stripe.customers.retrieve(account.customerId, { expand: ['invoice_settings.default_payment_method'] })
    paymentMethod = customer?.invoice_settings?.default_payment_method
  }
  const invoices = await stripe.invoices.list({ customer: account.customerId, limit: INVOICE_LIMIT })
  return {
    plan: planView(subscription),
    card: cardView(paymentMethod),
    invoices: (invoices?.data ?? []).map(invoiceView),
  }
}

async function setCancelAtPeriodEnd(stripe, account, cancel, details) {
  const subscription = await ownSubscription(stripe, account)
  if (ENDED_STATUSES.has(subscription.status)) throw new BillingError('subscription_ended', 409)
  const params = { cancel_at_period_end: cancel, expand: SUBSCRIPTION_EXPAND }
  if (details) params.cancellation_details = details
  return { plan: planView(await stripe.subscriptions.update(account.subscriptionId, params)) }
}

// input is the route's validated body: reason is one of CANCEL_REASONS or
// absent, and a blank comment is dropped.
export function cancelAtPeriodEnd(stripe, account, { reason, comment } = {}) {
  const details = {}
  if (typeof reason === 'string' && Object.hasOwn(REASON_TO_FEEDBACK, reason)) details.feedback = REASON_TO_FEEDBACK[reason]
  const trimmed = typeof comment === 'string' ? comment.trim() : ''
  if (trimmed) details.comment = trimmed
  return setCancelAtPeriodEnd(stripe, account, true, Object.keys(details).length ? details : null)
}

export function resumeSubscription(stripe, account) {
  return setCancelAtPeriodEnd(stripe, account, false, null)
}

const isCardOnly = (features) =>
  Object.entries(CARD_ONLY_FEATURES).every(([name, { enabled }]) => Boolean(features?.[name]?.enabled) === enabled)

// One configuration id per client: looked up by metadata, created if absent.
const portalConfigurations = new WeakMap()
async function portalConfiguration(stripe) {
  if (portalConfigurations.has(stripe)) return portalConfigurations.get(stripe)
  const listed = await stripe.billingPortal.configurations.list({ active: true, limit: 100 })
  let config = (listed?.data ?? []).find(
    (c) => c?.metadata?.horizon_portal === PORTAL_CONFIG_METADATA.horizon_portal && isCardOnly(c.features),
  )
  if (!config) {
    config = await stripe.billingPortal.configurations.create({ features: CARD_ONLY_FEATURES, metadata: PORTAL_CONFIG_METADATA })
  }
  if (typeof config?.id !== 'string' || !config.id) throw new BillingError('billing_unavailable', 502)
  portalConfigurations.set(stripe, config.id)
  return config.id
}

// A portal session that opens straight on card update and comes back to returnUrl.
export async function createCardSession(stripe, account, returnUrl) {
  const configuration = await portalConfiguration(stripe)
  const session = await stripe.billingPortal.sessions.create({
    customer: account.customerId,
    configuration,
    return_url: returnUrl,
    flow_data: {
      type: 'payment_method_update',
      after_completion: { type: 'redirect', redirect: { return_url: returnUrl } },
    },
  })
  if (typeof session?.url !== 'string' || !session.url) throw new BillingError('billing_unavailable', 502)
  return { url: session.url }
}
