// A fake of the three Stripe client methods billing.js uses (HZ-633), passed to
// buildApp({ stripe }). It records every call and never touches the network.
// Like Stripe, customers.create returns the same customer for a reused
// idempotency key, and it yields once first so two racing requests overlap.

export const FAKE_STRIPE_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_fake_hz633_secret',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_fake_hz633_publishable',
  STRIPE_PRICE_ID: 'price_fake_hz633',
  STRIPE_WEBHOOK_SECRET: 'fake-hz633-webhook-secret',
}

export function setFakeStripeEnv() {
  Object.assign(process.env, FAKE_STRIPE_ENV)
}

export function stripeError(code, message = 'boom') {
  return Object.assign(new Error(message), { type: 'StripeInvalidRequestError', code })
}

export function fakeStripe() {
  const calls = { customersCreate: [], sessionsCreate: [], sessionsRetrieve: [] }
  const customerByKey = new Map()
  const sessions = new Map()
  const fail = {}
  let seq = 0
  const fake = {
    calls,
    // Set fail.customersCreate / fail.sessionsCreate / fail.sessionsRetrieve to an Error to throw it.
    fail,
    totalCalls: () => calls.customersCreate.length + calls.sessionsCreate.length + calls.sessionsRetrieve.length,
    // What sessions.retrieve(id) returns for id.
    addSession(id, session) {
      sessions.set(id, session)
    },
    customers: {
      async create(params, options) {
        calls.customersCreate.push({ params, options })
        await new Promise((resolve) => setImmediate(resolve))
        if (fail.customersCreate) throw fail.customersCreate
        const key = options?.idempotencyKey
        if (key && customerByKey.has(key)) return { id: customerByKey.get(key) }
        seq += 1
        const id = `cus_fake${seq}`
        if (key) customerByKey.set(key, id)
        return { id }
      },
    },
    checkout: {
      sessions: {
        async create(params) {
          calls.sessionsCreate.push(params)
          if (fail.sessionsCreate) throw fail.sessionsCreate
          seq += 1
          return { id: `cs_test_fake${seq}`, client_secret: `cs_test_fake${seq}_secret_fake${seq}`, status: 'open' }
        },
        async retrieve(id) {
          calls.sessionsRetrieve.push(id)
          if (fail.sessionsRetrieve) throw fail.sessionsRetrieve
          if (!sessions.has(id)) throw stripeError('resource_missing', `No such checkout.session: '${id}'`)
          return sessions.get(id)
        },
      },
    },
  }
  return fake
}
