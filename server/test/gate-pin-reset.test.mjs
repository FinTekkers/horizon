// HZ-935: Admin's "Reset PIN" — POST /api/auth/gate-pin/regenerate with the
// user's own 6 digits ({ pin, confirm }, x-horizon-csrf) or, with no such
// body, a random PIN from crypto.randomInt. Both store only a salted scrypt
// hash and lock every session of the user. The server validates every chosen
// PIN whatever the client checked, and a rejection changes nothing. The
// plaintext is in no log line, event, error body or (for a chosen PIN) reply.
//
// Every real PIN here is made at runtime; the literals below are format
// probes the server must refuse, never credentials.

import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { loginFixtureUser, loginFixtureToken } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-gate-pin-reset-')), 'test.db')
for (const key of ['FARM_HOME', 'FARM_URL', 'GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { buildApp } = await import('../src/app.js')

store.purgeDemoItems()

const logLines = []
const app = buildApp({
  logger: {
    level: 'trace',
    stream: new Writable({
      write(chunk, _enc, done) {
        logLines.push(chunk.toString())
        done()
      },
    }),
  },
})
await app.ready()
after(() => app.close())

const owner = loginFixtureUser(auth, config)
const CSRF = { 'x-horizon-csrf': '1' }
const URL_ = '/api/auth/gate-pin/regenerate'

const reset = (payload, headers = { cookie: owner.cookie, ...CSRF }) => app.inject({ method: 'POST', url: URL_, headers, payload })
const hashOf = (userId) => db.prepare('SELECT gate_pin_hash FROM user WHERE id = ?').get(userId).gate_pin_hash
const verifiedUntils = (userId) =>
  db.prepare('SELECT pin_verified_until FROM session WHERE user_id = ?').all(userId).map((r) => r.pin_verified_until)
const contains = (text, pin) => new RegExp(`(^|\\D)${pin}(\\D|$)`).test(text)

// A PIN the server accepts, made fresh for each use.
function chosenPin() {
  for (;;) {
    const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    if (!auth.WEAK_PINS.has(pin)) return pin
  }
}

// Two more sessions of `user`, both PIN-verified; returns their cookies.
function verifiedSessions(userId) {
  return [0, 1].map(() => {
    const token = auth.createSession(userId)
    auth.markSessionPinVerified(token)
    return `${config.SESSION_COOKIE_NAME}=${token}`
  })
}

// The user's PIN is `pin`; every session of the user is unverified.
function assertResetTo(userId, pin, oldPin) {
  assert.equal(auth.verifyGatePin(userId, pin), true, 'the new PIN verifies')
  if (oldPin) assert.equal(auth.verifyGatePin(userId, oldPin), false, 'the old PIN fails')
  const until = verifiedUntils(userId)
  assert.ok(until.length >= 2)
  assert.deepEqual(until, until.map(() => null), 'every session is locked')
}

// ---- metric 2: format, confirmation and weak patterns ----

test('metric 2: a chosen PIN of exactly 6 ASCII digits with a matching confirm is accepted, leading zeros included', async () => {
  const pin = `000${String(crypto.randomInt(100, 1000))}`
  const res = await reset({ pin, confirm: pin })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(auth.verifyGatePin(owner.user.id, pin), true)
})

test('metric 2: non-digits, wrong length, other digit scripts, non-strings and a mismatch are 400 and change nothing', async () => {
  const good = chosenPin()
  const other = good === '135792' ? '246813' : '135792'
  const cases = [
    ['12a456', '12a456', 'pin_format'],
    ['12345', '12345', 'pin_format'],
    ['1234567', '1234567', 'pin_format'],
    ['１２３４５６', '１２３４５６', 'pin_format'], // full-width digits
    ['٠١٢٣٤٥', '٠١٢٣٤٥', 'pin_format'], // Arabic-Indic digits
    ['123456\n', '123456\n', 'pin_format'],
    [' 123456', ' 123456', 'pin_format'],
    [Number(good), Number(good), 'pin_format'],
    [good, other, 'pin_mismatch'],
    [good, Number(good), 'pin_mismatch'],
  ]
  for (const [pin, confirm, error] of cases) {
    const before = hashOf(owner.user.id)
    const res = await reset({ pin, confirm })
    assert.equal(res.statusCode, 400, JSON.stringify(pin))
    assert.deepEqual(res.json(), { error }, JSON.stringify(pin))
    assert.equal(hashOf(owner.user.id), before, `hash unchanged after ${JSON.stringify(pin)}`)
  }
})

test('metric 2: WEAK_PINS is the recorded 20 values, and each is 400 pin_weak with the hash unchanged', async () => {
  assert.equal(auth.WEAK_PINS.size, 20)
  for (const family of ['000000', '999999', '012345', '456789', '987654', '543210']) assert.ok(auth.WEAK_PINS.has(family), family)
  for (const pin of auth.WEAK_PINS) {
    const before = hashOf(owner.user.id)
    const res = await reset({ pin, confirm: pin })
    assert.equal(res.statusCode, 400, pin)
    assert.deepEqual(res.json(), { error: 'pin_weak' })
    assert.equal(hashOf(owner.user.id), before, `hash unchanged after ${pin}`)
  }
})

test('guardrail 4: a pin or confirm key always means a chosen PIN — null, empty or one-sided bodies are 400, never a random reset', async () => {
  const pin = chosenPin()
  for (const body of [{ pin: null, confirm: null }, { pin: '' }, { pin }, { confirm: pin }]) {
    const before = hashOf(owner.user.id)
    const res = await reset(body)
    assert.equal(res.statusCode, 400, JSON.stringify(body))
    assert.equal(Object.hasOwn(res.json(), 'pin'), false)
    assert.match(res.json().error, /^pin_(format|mismatch)$/)
    assert.equal(hashOf(owner.user.id), before)
  }
  // A body that is not an object is refused too, rather than read as random.
  for (const payload of [JSON.stringify(pin), JSON.stringify([pin, pin])]) {
    const before = hashOf(owner.user.id)
    const res = await app.inject({
      method: 'POST',
      url: URL_,
      headers: { cookie: owner.cookie, ...CSRF, 'content-type': 'application/json' },
      payload,
    })
    assert.equal(res.statusCode, 400, payload)
    assert.deepEqual(res.json(), { error: 'pin_format' })
    assert.equal(hashOf(owner.user.id), before)
  }
})

test('validateChosenPin and setGatePin share the rules; setGatePin writes nothing on a reason', () => {
  const { user } = auth.createUser({ email: 'unit-reset@example.com', name: 'Unit Reset', authMethod: 'password' })
  const before = hashOf(user.id)
  assert.equal(auth.validateChosenPin('12a456', '12a456'), 'pin_format')
  assert.equal(auth.setGatePin(user.id, '12a456', '12a456'), 'pin_format')
  assert.equal(auth.setGatePin(user.id, '000000', '000000'), 'pin_weak')
  const pin = chosenPin()
  assert.equal(auth.setGatePin(user.id, pin, `${pin.slice(0, 5)}${(Number(pin[5]) + 1) % 10}`), 'pin_mismatch')
  assert.equal(hashOf(user.id), before)
  assert.equal(auth.setGatePin(user.id, pin, pin), null)
  assert.equal(auth.verifyGatePin(user.id, pin), true)
})

// ---- metric 3: random generation ----

test('metric 3: with crypto.randomInt stubbed, the random reset returns 000000 through the hash and lock path — no weak check', async () => {
  const { user, pin: oldPin, cookie } = loginFixtureUser(auth, config, { email: 'random-reset@example.com', role: 'member' })
  verifiedSessions(user.id)
  const randomInt = mock.method(crypto, 'randomInt', () => 0)
  let res
  try {
    res = await reset({}, { cookie })
  } finally {
    randomInt.mock.restore()
  }
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true, pin: '000000' })
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.deepEqual(randomInt.mock.calls.map((c) => c.arguments), [[0, 1_000_000]])
  assertResetTo(user.id, '000000', oldPin)
})

test('metric 3: regenerateGatePin yields 000000 and 999999 from crypto.randomInt(0, 1_000_000), verifies and locks sessions', () => {
  const { user, pin: oldPin } = auth.createUser({ email: 'random-unit@example.com', name: 'Random Unit', authMethod: 'password' })
  for (const [value, expected] of [[0, '000000'], [999_999, '999999']]) {
    verifiedSessions(user.id)
    const randomInt = mock.method(crypto, 'randomInt', () => value)
    let pin
    try {
      pin = auth.regenerateGatePin(user.id)
    } finally {
      randomInt.mock.restore()
    }
    assert.equal(pin, expected)
    assert.deepEqual(randomInt.mock.calls.map((c) => c.arguments), [[0, 1_000_000]])
    assertResetTo(user.id, pin, expected === '000000' ? oldPin : '000000')
  }
})

// ---- metric 4: hash only, shown once, never leaked ----

test('metric 4: a chosen PIN is stored only as salt:hash, the reply is exactly { ok: true }, and it is in no log, event or body', async () => {
  const { user, pin: oldPin, cookie } = loginFixtureUser(auth, config, { email: 'leak-check@example.com', role: 'member' })
  verifiedSessions(user.id)
  const pin = chosenPin()
  const logStart = logLines.length
  const res = await reset({ pin, confirm: pin }, { cookie, ...CSRF })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true })
  assert.equal(res.headers['cache-control'], 'no-store')

  const stored = hashOf(user.id)
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{64}$/)
  assert.equal(contains(stored, pin), false)
  assertResetTo(user.id, pin, oldPin)

  // A rejected attempt with the same digits leaves no trace either.
  const mismatch = await reset({ pin, confirm: `${pin}0` }, { cookie, ...CSRF })
  assert.equal(contains(mismatch.body, pin), false)

  const logged = logLines.slice(logStart).join('')
  assert.ok(logged.length > 0, 'the requests were logged')
  assert.equal(contains(logged, pin), false, 'the PIN is in no log line')
  const events = JSON.stringify(db.prepare('SELECT * FROM event').all())
  const userEvents = JSON.stringify(db.prepare('SELECT * FROM user_event').all())
  assert.equal(contains(events, pin), false, 'the PIN is in no event')
  assert.equal(contains(userEvents, pin), false, 'the PIN is in no user_event')
})

test('metric 4: a manual reset counts the PIN as shown, so /gate-pin/first stays 409 and never replaces it', async () => {
  const { user, cookie } = loginFixtureUser(auth, config, { email: 'never-revealed@example.com', role: 'member' })
  db.prepare('UPDATE user SET gate_pin_revealed_at = NULL WHERE id = ?').run(user.id)
  assert.equal(auth.gatePinRevealPending(user.id), true)
  const pin = chosenPin()
  assert.equal((await reset({ pin, confirm: pin }, { cookie, ...CSRF })).statusCode, 200)
  const first = await app.inject({ method: 'POST', url: '/api/auth/gate-pin/first', headers: { cookie, ...CSRF }, payload: {} })
  assert.equal(first.statusCode, 409)
  assert.deepEqual(first.json(), { error: 'pin_already_shown' })
  assert.equal(auth.verifyGatePin(user.id, pin), true)

  // And for the owner, already shown at creation.
  const ownerFirst = await app.inject({ method: 'POST', url: '/api/auth/gate-pin/first', headers: { cookie: owner.cookie, ...CSRF }, payload: {} })
  assert.equal(ownerFirst.statusCode, 409)
})

test('guardrail 2: a body that fails to parse is 400 pin_format, changes nothing, and echoes or logs no PIN', async () => {
  const pin = chosenPin()
  for (const payload of [`x${pin}`, `pin=${pin}&confirm=${pin}`, `{"pin":"${pin}","confirm":${pin}x}`, `{"pin":${pin}x`]) {
    const before = hashOf(owner.user.id)
    const logStart = logLines.length
    const res = await app.inject({
      method: 'POST',
      url: URL_,
      headers: { cookie: owner.cookie, ...CSRF, 'content-type': 'application/json' },
      payload,
    })
    assert.equal(res.statusCode, 400, payload)
    assert.deepEqual(res.json(), { error: 'pin_format' })
    assert.equal(contains(res.body, pin), false)
    assert.equal(contains(logLines.slice(logStart).join(''), pin), false, `no PIN logged for ${payload.length}-char body`)
    assert.equal(hashOf(owner.user.id), before)
  }
})

// ---- guardrail 3: login session only, CSRF for a chosen PIN ----

test('guardrail 3: a chosen PIN needs x-horizon-csrf, a token is 401, no session is 401 — none changes the PIN', async () => {
  const pin = chosenPin()
  const before = hashOf(owner.user.id)
  const noCsrf = await reset({ pin, confirm: pin }, { cookie: owner.cookie })
  assert.equal(noCsrf.statusCode, 403)
  assert.deepEqual(noCsrf.json(), { error: 'csrf_required' })
  const crossSite = await reset({ pin, confirm: pin }, { cookie: owner.cookie, ...CSRF, origin: 'https://evil.example' })
  assert.equal(crossSite.statusCode, 403)
  const token = loginFixtureToken(auth, owner.user)
  const byToken = await reset({ pin, confirm: pin }, { ...token.headers, ...CSRF })
  assert.equal(byToken.statusCode, 401)
  assert.deepEqual(byToken.json(), { error: 'login_required' })
  const anon = await reset({ pin, confirm: pin }, CSRF)
  assert.equal(anon.statusCode, 401)
  assert.equal(hashOf(owner.user.id), before)
})

test('guardrail 3: a cross-site random reset is 403 with no PIN; a same-origin one without the header still works', async () => {
  const before = hashOf(owner.user.id)
  const crossSite = await reset({}, { cookie: owner.cookie, 'sec-fetch-site': 'cross-site' })
  assert.equal(crossSite.statusCode, 403)
  assert.deepEqual(crossSite.json(), { error: 'cross_site_refused' })
  assert.equal(hashOf(owner.user.id), before)
  const plain = await app.inject({ method: 'POST', url: URL_, headers: { cookie: owner.cookie } })
  assert.equal(plain.statusCode, 200)
  assert.match(plain.json().pin, /^\d{6}$/)
  assert.equal(plain.headers['cache-control'], 'no-store')
})
