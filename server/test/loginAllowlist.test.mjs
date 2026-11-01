// Unit tests for server/src/loginAllowlist.js (HZ-36): the only thing
// standing between "completed Google's OAuth consent screen" and "actually
// allowed into Horizon" — deny-by-default, case-insensitive, and re-applied
// on every boot (not once-gated like the pipeline-shift migrations in db.js).
// HZ-654: reconciling disables a user rather than deleting it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-login-allowlist-')), 'test.db')
process.env.ALLOWED_LOGIN_EMAILS = 'alice@example.com, Bob@Example.com'

const config = await import('../src/config.js')
const { isAllowedEmail, reconcileGoogleUsers } = await import('../src/loginAllowlist.js')
const { db } = await import('../src/db.js')
const auth = await import('../src/auth.js')

// ---- isAllowedEmail ----

test('isAllowedEmail matches an allowlisted address', () => {
  assert.ok(isAllowedEmail('alice@example.com'))
})

test('isAllowedEmail is case-insensitive on both sides', () => {
  assert.ok(isAllowedEmail('ALICE@EXAMPLE.COM'))
  assert.ok(isAllowedEmail('bob@example.com')) // env var had "Bob@Example.com"
})

test('isAllowedEmail rejects anything not on the list', () => {
  assert.equal(isAllowedEmail('carol@example.com'), false)
})

test('isAllowedEmail rejects null/undefined/non-string input rather than throwing', () => {
  assert.equal(isAllowedEmail(null), false)
  assert.equal(isAllowedEmail(undefined), false)
  assert.equal(isAllowedEmail(42), false)
  assert.equal(isAllowedEmail(''), false)
})

test('deny-by-default: an empty allowlist matches nothing, not everything', () => {
  const saved = new Set(config.ALLOWED_LOGIN_EMAILS)
  config.ALLOWED_LOGIN_EMAILS.clear()
  try {
    assert.equal(isAllowedEmail('alice@example.com'), false)
    assert.equal(isAllowedEmail('anyone@example.com'), false)
  } finally {
    config.ALLOWED_LOGIN_EMAILS.clear()
    for (const email of saved) config.ALLOWED_LOGIN_EMAILS.add(email)
  }
})

// ---- reconcileGoogleUsers ----
// HZ-654: it disables and re-enables; it never deletes a row in any table.

function tableCounts() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]))
}

// Runs reconcileGoogleUsers and asserts no table lost a row and only
// user_event gained any. Returns how many user_event rows it wrote.
function reconcileCounted() {
  const before = tableCounts()
  reconcileGoogleUsers(db)
  const after = tableCounts()
  assert.deepEqual(Object.keys(after), Object.keys(before))
  for (const [table, n] of Object.entries(before)) {
    if (table === 'user_event') assert.ok(after[table] >= n, 'user_event never shrinks')
    else assert.equal(after[table], n, `${table} row count unchanged`)
  }
  return after.user_event - before.user_event
}

const userRow = (id) => db.prepare('SELECT * FROM user WHERE id = ?').get(id)
const userEvents = (id) => db.prepare('SELECT kind, who FROM user_event WHERE user_id = ? ORDER BY id').all(id)

test('reconcileGoogleUsers disables a google-auth row not on the allowlist: the row and its session stay, the session is refused', () => {
  const { user } = auth.createUser({ email: 'evicted@example.com', name: 'Evicted', authMethod: 'google', googleSub: 'sub-evicted' })
  const token = auth.createSession(user.id)
  // Counted, not resolved: since HZ-635 getSessionUser itself refuses (and
  // deletes) this unpaid, non-allowlisted session, which would hide whether
  // reconcile did the work.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session WHERE user_id = ?').get(user.id).n, 1, 'sanity: the session exists before reconciliation')

  assert.equal(reconcileCounted(), 1)

  assert.equal(userRow(user.id).email, 'evicted@example.com', 'the row is kept')
  assert.ok(userRow(user.id).disabled_at, 'disabled_at is set')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session WHERE user_id = ?').get(user.id).n, 1, 'the session row is kept')
  assert.equal(auth.getSessionUser(token), null, 'the session is refused')
  assert.deepEqual(userEvents(user.id), [{ kind: 'disabled', who: 'login allowlist' }])
})

test('reconcileGoogleUsers leaves an allowlisted google-auth row untouched', () => {
  const { user } = auth.createUser({ email: 'alice@example.com', name: 'Alice', authMethod: 'google', googleSub: 'sub-alice' })
  const before = userRow(user.id)
  assert.equal(reconcileCounted(), 0)
  assert.deepEqual(userRow(user.id), before)
  assert.equal(before.disabled_at, null)
})

test('reconcileGoogleUsers never touches a password-auth row, even one off the allowlist', () => {
  const { user } = auth.createUser({ email: 'not-allowlisted-password@example.com', name: 'Password User', authMethod: 'password' })
  const before = userRow(user.id)
  assert.equal(reconcileCounted(), 0)
  assert.deepEqual(userRow(user.id), before)
})

// Unlike db.js's one-time-gated pipeline_v2_shift/pipeline_v3_review_shift
// migrations, this must re-apply every time it runs — ops can tighten or
// loosen ALLOWED_LOGIN_EMAILS at any point while the process is up.
test('reconcileGoogleUsers re-applies on every call as the allowlist changes: disable, then re-enable with the old session still refused', () => {
  const saved = new Set(config.ALLOWED_LOGIN_EMAILS)
  try {
    config.ALLOWED_LOGIN_EMAILS.add('dana@example.com')
    const { user } = auth.createUser({ email: 'dana@example.com', name: 'Dana', authMethod: 'google', googleSub: 'sub-dana' })
    const token = auth.createSession(user.id)

    assert.equal(reconcileCounted(), 0, 'still allowlisted, first run')
    assert.equal(userRow(user.id).disabled_at, null)

    config.ALLOWED_LOGIN_EMAILS.delete('dana@example.com')
    assert.equal(reconcileCounted(), 1, 'removed from the list, second run')
    assert.ok(userRow(user.id).disabled_at)

    config.ALLOWED_LOGIN_EMAILS.add('dana@example.com')
    assert.equal(reconcileCounted(), 1, 'back on the list, third run')
    assert.equal(userRow(user.id).disabled_at, null, 're-enabled')
    assert.deepEqual(userEvents(user.id).map((e) => e.kind), ['disabled', 'enabled'])
    assert.equal(auth.getSessionUser(token), null, 'a session from before the disable stays refused')
  } finally {
    config.ALLOWED_LOGIN_EMAILS.clear()
    for (const email of saved) config.ALLOWED_LOGIN_EMAILS.add(email)
  }
})

test('reconcileGoogleUsers writes nothing at all when no google-auth row changes state', () => {
  reconcileGoogleUsers(db)
  const before = tableCounts()
  const changes = db.prepare('SELECT total_changes() AS n').get().n
  reconcileGoogleUsers(db)
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes, 'zero rows written, user_event included')
  assert.deepEqual(tableCounts(), before)
})

// HZ-635: a paid account is the second way in. A non-allowlisted sign-up row
// (HZ-633) that linked Google keeps its sessions while it is paid.
for (const status of ['active', 'cancelling']) {
  test(`reconcileGoogleUsers keeps the sessions of a non-allowlisted ${status} user`, () => {
    const user = auth.createSignupUser({ email: `paid-${status}@example.com`, name: 'Paid', company: 'Acme' })
    auth.setAccountStatus(user.id, status, 'test')
    db.prepare('UPDATE user SET google_sub = ? WHERE id = ?').run(`sub-paid-${status}`, user.id)
    const token = auth.createSession(user.id)

    reconcileGoogleUsers(db)

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session WHERE user_id = ?').get(user.id).n, 1)
    assert.equal(auth.getSessionUser(token).id, user.id)
  })
}
