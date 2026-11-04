// HZ-704: one gate PIN per browser session. A correct PIN marks the login
// session PIN-verified for 12 hours; a later gate or Admin change on that
// session then passes without the PIN. Lock, sign-out, a regenerated PIN, a
// wrong PIN and the 12 hours each end it. A token never passes (HZ-179), the
// human proof is still minted only for a verified session (HZ-384), and a
// cross-site request carrying the verified cookie is refused.
//
// The clock is auth.setClockForTests, so the 12-hour edge is exact. Its own
// file because config.js reads the environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import Database from 'better-sqlite3'
import { loginFixtureUser } from './helpers/session.mjs'

const dbPath = join(mkdtempSync(join(tmpdir(), 'horizon-pin-session-')), 'test.db')
process.env.HORIZON_DB = dbPath
// A non-root path, like production's https://shoreward.ai/horizon.
process.env.HORIZON_UI_URL = 'https://horizon.example/horizon'
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_NOTIFY_ENABLED', 'WA_POLL_ENABLED']) delete process.env[key]

globalThis.fetch = async (url) => {
  if (String(url).includes('/runs/status')) return { ok: true, json: async () => ({ states: {} }) }
  return { ok: true, json: async () => ({}) }
}

// A session row from before HZ-704: the table without pin_verified_until.
// db.js's migration must add the column to it as NULL.
const LEGACY_SESSION_ID = 'legacy-session-row'
{
  const legacy = new Database(dbPath)
  legacy.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL
  )`)
  legacy.prepare('INSERT INTO session (id, user_id, expires_at) VALUES (?, ?, ?)').run(LEGACY_SESSION_ID, 'nobody', '2099-01-01T00:00:00.000Z')
  legacy.close()
}

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, kindStepIndex, APPROVE_RUN_GATE_INDEX, RUN_PLAN_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

let now = Date.parse('2026-11-04T08:00:00.000Z')
auth.setClockForTests(() => now)

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
// Every request.auth as JSON, to check the session token never serialises.
const authJson = []
app.addHook('preHandler', (request, _reply, done) => {
  if (request.auth) authJson.push(JSON.stringify(request.auth))
  done()
})
await app.ready()
orchestrator.init({ info() {}, warn() {}, error() {} })

after(async () => {
  for (const row of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(row.id)
  await app.close()
  auth.setClockForTests(null)
  const before = Date.now()
  assert.equal(auth.PIN_SESSION_TTL_MS, 12 * 60 * 60 * 1000)
  // setClockForTests(null) restored the real clock: a fresh verify expires
  // about 12 hours from the real now, not from the fake one.
  const until = Date.parse(auth.markSessionPinVerified(null))
  assert.ok(until >= before + auth.PIN_SESSION_TTL_MS && until <= Date.now() + auth.PIN_SESSION_TTL_MS)
})

// A PIN no timestamp, id or hash could contain by chance.
const PIN = 'zq7-PIN-hz704-xk'
function setPin(userId, pin) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(pin, salt, 32)
  db.prepare('UPDATE user SET gate_pin_hash = ? WHERE id = ?').run(`${salt.toString('hex')}:${hash.toString('hex')}`, userId)
}

const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
setPin(alice.user.id, PIN)
const bob = loginFixtureUser(auth, config, { email: 'bob@example.com', name: 'Bob Example' })
const bobPin = auth.regenerateGatePin(bob.user.id)
const { token: aliceToken } = auth.createApiToken(alice.user.id, 'scripts')

// Another browser session for a user, as a Cookie header and its raw token.
function newSession(user) {
  const token = auth.createSession(user.id)
  return { token, cookie: `${config.SESSION_COOKIE_NAME}=${token}` }
}

const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Pin session project', 1)").run().lastInsertRowid)

// The Admin change: a project's enabled flag (HZ-208), a PIN-protected route.
const adminChange = (headers) =>
  app.inject({ method: 'POST', url: `/api/projects/${projectId}/enabled`, headers, payload: { enabled: true } })

// The gate: a Task's Approve the run, which is humanOnly (HZ-384) — the store
// refuses it without a human proof, so a pass here means a proof was minted.
const ASSESS = kindStepIndex('Assess', 'task')
const IMPACT_REVIEW = kindStepIndex('Impact review', 'task')
const PLAN = '## Run plan block\n```json run-plan\n' + JSON.stringify({ cwd: '.', commands: ['scripts/a.sh'], budget_minutes: 5 }) + '\n```'
let taskSeq = 0
function seedTask() {
  const id = `T-PIN-${++taskSeq}`
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id) VALUES (?, ?, 'High', ?, 'task', ?)").run(
    id,
    `Task fixture ${id}`,
    APPROVE_RUN_GATE_INDEX,
    projectId,
  )
  for (const [step, artifact] of [
    [ASSESS, '## Scripts found\n- scripts/a.sh'],
    [RUN_PLAN_STEP_INDEX, PLAN],
    [IMPACT_REVIEW, '## Verdict\n**pass**'],
  ]) {
    db.prepare(
      "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
    ).run(id, step, STEPS[step].agent, artifact)
  }
  return id
}
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const approve = (id, headers) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/gates/${APPROVE_RUN_GATE_INDEX}/approve`, headers, payload: {} })

// The UI's headers: the session cookie and the same-origin marker.
const browser = (session, extra = {}) => ({ cookie: session.cookie, 'x-horizon-csrf': '1', ...extra })

async function verify(session, pin = PIN) {
  const res = await adminChange(browser(session, { 'x-human-key': pin }))
  assert.equal(res.statusCode, 200, res.body)
}

function assertRefused(res, status = 401, error = 'human_gate_key_required') {
  assert.equal(res.statusCode, status, res.body)
  assert.deepEqual(res.json(), { error })
}

// ---- metric 1: verify once, then the 12 hours, Lock, sign-out, regenerate ----

test('the migration adds pin_verified_until as NULL to an existing session row', () => {
  const row = db.prepare('SELECT pin_verified_until FROM session WHERE id = ?').get(LEGACY_SESSION_ID)
  assert.deepEqual(row, { pin_verified_until: null })
})

test('after one correct PIN, a gate and an Admin change pass without it until exactly 12 hours', async () => {
  const session = newSession(alice.user)
  assertRefused(await adminChange(browser(session)))

  // The first request carries the PIN: the humanOnly gate approves.
  const first = seedTask()
  const ok = await approve(first, browser(session, { 'x-human-key': PIN }))
  assert.equal(ok.statusCode, 200, ok.body)
  assert.notEqual(cursorOf(first), APPROVE_RUN_GATE_INDEX)
  const verifiedAt = now

  // Later, no PIN: an Admin change and a humanOnly gate both pass.
  now = verifiedAt + 60_000
  assert.equal((await adminChange(browser(session))).statusCode, 200)
  const second = seedTask()
  const gate = await approve(second, browser(session))
  assert.equal(gate.statusCode, 200, gate.body)
  assert.notEqual(cursorOf(second), APPROVE_RUN_GATE_INDEX, 'the humanOnly gate got a proof from the verified session')

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie } })
  assert.equal(me.json().user.pinVerifiedUntil, new Date(verifiedAt + auth.PIN_SESSION_TTL_MS).toISOString())

  now = verifiedAt + auth.PIN_SESSION_TTL_MS - 1
  assert.equal((await adminChange(browser(session))).statusCode, 200, '12 hours minus 1 ms still passes')

  now = verifiedAt + auth.PIN_SESSION_TTL_MS
  assertRefused(await adminChange(browser(session)))
  const late = seedTask()
  assertRefused(await approve(late, browser(session)))
  assert.equal(cursorOf(late), APPROVE_RUN_GATE_INDEX)
  const meAfter = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie } })
  assert.equal(meAfter.json().user.pinVerifiedUntil, null)
})

test('Lock ends the verification; the next change needs the PIN again', async () => {
  const session = newSession(alice.user)
  await verify(session)
  assert.equal((await adminChange(browser(session))).statusCode, 200)

  const lock = await app.inject({ method: 'POST', url: '/api/auth/pin/lock', headers: browser(session) })
  assert.equal(lock.statusCode, 200, lock.body)
  assert.deepEqual(lock.json(), { ok: true })
  assertRefused(await adminChange(browser(session)))

  await verify(session)
  assert.equal((await adminChange(browser(session))).statusCode, 200)
})

test('sign-out ends the verification', async () => {
  const session = newSession(alice.user)
  await verify(session)
  const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: session.cookie } })
  assert.equal(out.statusCode, 200)
  assertRefused(await adminChange(browser(session)), 401, 'login_required')
})

test('regenerating the PIN locks every session of that user and no one else', async () => {
  const a1 = newSession(alice.user)
  const a2 = newSession(alice.user)
  const b1 = newSession(bob.user)
  await verify(a1)
  await verify(a2)
  await verify(b1, bobPin)

  const regen = await app.inject({ method: 'POST', url: '/api/auth/gate-pin/regenerate', headers: { cookie: a1.cookie } })
  assert.equal(regen.statusCode, 200)
  const newPin = regen.json().pin

  assertRefused(await adminChange(browser(a1)))
  assertRefused(await adminChange(browser(a2)))
  assert.equal((await adminChange(browser(b1))).statusCode, 200, "another user's session stays verified")

  assertRefused(await adminChange(browser(a1, { 'x-human-key': PIN })), 401)
  setPin(alice.user.id, PIN)
  assert.notEqual(newPin, PIN)
})

// ---- the lock rules ----

test('a wrong PIN on a verified session is refused and locks it', async () => {
  const session = newSession(alice.user)
  await verify(session)
  assertRefused(await adminChange(browser(session, { 'x-human-key': '000000' })))
  assertRefused(await adminChange(browser(session)))
})

// ---- guardrail 1 (HZ-179): a token never passes ----

test('an API token is refused even with the correct PIN, and is never verified', async () => {
  const headers = { authorization: `Bearer ${aliceToken}`, 'x-horizon-csrf': '1' }
  assertRefused(await adminChange({ ...headers, 'x-human-key': PIN }))
  assertRefused(await adminChange(headers))
  const id = seedTask()
  assertRefused(await approve(id, { ...headers, 'x-human-key': PIN }))
  assert.equal(cursorOf(id), APPROVE_RUN_GATE_INDEX)

  // Lock is an /api/auth/ route, which reads no token: 401, like no login.
  const lock = await app.inject({ method: 'POST', url: '/api/auth/pin/lock', headers: { authorization: `Bearer ${aliceToken}` } })
  assertRefused(lock, 401, 'login_required')
  assertRefused(await app.inject({ method: 'POST', url: '/api/auth/pin/lock' }), 401, 'login_required')
})

// ---- guardrail 4: same-origin ----

test('a cross-site request carrying the verified cookie is refused with 403', async () => {
  const session = newSession(alice.user)
  await verify(session)
  for (const extra of [
    { origin: 'https://evil.example' },
    { origin: 'null' },
    { origin: 'https://horizon.example.evil.example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ]) {
    assertRefused(await adminChange(browser(session, extra)), 403, 'cross_site_refused')
  }
  const id = seedTask()
  assertRefused(await approve(id, browser(session, { origin: 'https://evil.example' })), 403, 'cross_site_refused')
  assert.equal(cursorOf(id), APPROVE_RUN_GATE_INDEX)

  // Still verified: the refusals neither used nor ended it.
  assert.equal((await adminChange(browser(session))).statusCode, 200)
})

test('a cross-site request with the correct PIN is refused and does not verify the session', async () => {
  const session = newSession(alice.user)
  assertRefused(await adminChange(browser(session, { origin: 'https://evil.example', 'x-human-key': PIN })), 403, 'cross_site_refused')
  assert.equal(auth.isSessionPinVerified(session.token), false)
  assertRefused(await adminChange(browser(session)))
})

test('Lock from another site is refused and leaves the session verified', async () => {
  const session = newSession(alice.user)
  await verify(session)
  const lock = await app.inject({
    method: 'POST',
    url: '/api/auth/pin/lock',
    headers: browser(session, { origin: 'https://evil.example' }),
  })
  assertRefused(lock, 403, 'cross_site_refused')
  assert.equal(auth.isSessionPinVerified(session.token), true)
})

test('a verified cookie with no x-horizon-csrf header gets 401, on a GET too', async () => {
  const session = newSession(alice.user)
  await verify(session)
  assertRefused(await adminChange({ cookie: session.cookie }))
  const url = `/api/items/${seedTask()}/screenshots/home/new`
  assertRefused(await app.inject({ method: 'GET', url, headers: { cookie: session.cookie } }))
  // With the header the PIN check passes, and the route answers for itself.
  const withHeader = await app.inject({ method: 'GET', url, headers: browser(session) })
  assert.notEqual(withHeader.statusCode, 401)
  assert.notEqual(withHeader.statusCode, 403)
})

test("the UI's own origin under /horizon passes, and so does the request's own host", async () => {
  const session = newSession(alice.user)
  await verify(session)
  const res = await adminChange(browser(session, { origin: 'https://horizon.example', 'sec-fetch-site': 'same-origin' }))
  assert.equal(res.statusCode, 200, res.body)
  // The same site under another name nginx serves (www.): Origin matches Host.
  const www = await adminChange(browser(session, { origin: 'https://www.horizon.example', host: 'www.horizon.example' }))
  assert.equal(www.statusCode, 200, www.body)
  // A page elsewhere cannot make the browser send a matching Host.
  const evil = await adminChange(browser(session, { origin: 'https://evil.example', host: 'www.horizon.example' }))
  assertRefused(evil, 403, 'cross_site_refused')
})

// ---- guardrail 2: the PIN and the session token are never stored or logged ----

test('neither the PIN nor the session token reaches a log line, an activity row or the session row', async () => {
  const session = newSession(alice.user)
  const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM event').get().n
  logLines.length = 0
  authJson.length = 0
  await verify(session)
  assertRefused(await adminChange(browser(session, { 'x-human-key': 'wrong-PIN-hz704-qq' })))
  await verify(session)
  assert.ok(logLines.length > 0, 'the logger is wired')
  for (const secret of [PIN, 'wrong-PIN-hz704-qq', session.token]) {
    assert.ok(!logLines.some((line) => line.includes(secret)), 'a log line carries a secret')
    const events = db.prepare('SELECT * FROM event WHERE id > ?').all(eventsBefore)
    assert.ok(!JSON.stringify(events).includes(secret), 'an activity row carries a secret')
  }
  assert.ok(authJson.length > 0)
  assert.ok(authJson.every((json) => !json.includes('token') && !json.includes(session.token)), 'request.auth serialises the token')

  const row = db.prepare('SELECT * FROM session WHERE pin_verified_until IS NOT NULL LIMIT 1').get()
  assert.ok(!Number.isNaN(Date.parse(row.pin_verified_until)), 'pin_verified_until holds a timestamp only')
  assert.ok(!JSON.stringify(row).includes(PIN))
})
