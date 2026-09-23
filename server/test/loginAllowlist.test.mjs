// Unit tests for server/src/loginAllowlist.js (HZ-36): the only thing
// standing between "completed Google's OAuth consent screen" and "actually
// allowed into Horizon" — deny-by-default, case-insensitive, and re-applied
// on every boot (not once-gated like the pipeline-shift migrations in db.js).

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

test('reconcileGoogleUsers deletes a google-auth row not on the allowlist, and its sessions', () => {
  const { user } = auth.createUser({ email: 'evicted@example.com', name: 'Evicted', authMethod: 'google', googleSub: 'sub-evicted' })
  const token = auth.createSession(user.id)
  assert.ok(auth.getSessionUser(token), 'sanity: the session works before reconciliation')

  reconcileGoogleUsers(db)

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user WHERE id = ?').get(user.id).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session WHERE user_id = ?').get(user.id).n, 0)
  assert.equal(auth.getSessionUser(token), null)
})

test('reconcileGoogleUsers leaves an allowlisted google-auth row untouched', () => {
  const { user } = auth.createUser({ email: 'alice@example.com', name: 'Alice', authMethod: 'google', googleSub: 'sub-alice' })
  reconcileGoogleUsers(db)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user WHERE id = ?').get(user.id).n, 1)
})

test('reconcileGoogleUsers never touches a password-auth row, even one off the allowlist', () => {
  const { user } = auth.createUser({ email: 'not-allowlisted-password@example.com', name: 'Password User', authMethod: 'password' })
  reconcileGoogleUsers(db)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user WHERE id = ?').get(user.id).n, 1)
})

// Unlike db.js's one-time-gated pipeline_v2_shift/pipeline_v3_review_shift
// migrations, this must re-apply every time it runs — ops can tighten or
// loosen ALLOWED_LOGIN_EMAILS at any point while the process is up.
test('reconcileGoogleUsers re-applies on every call, not just the first, as the allowlist changes', () => {
  const saved = new Set(config.ALLOWED_LOGIN_EMAILS)
  try {
    config.ALLOWED_LOGIN_EMAILS.add('dana@example.com')
    const { user } = auth.createUser({ email: 'dana@example.com', name: 'Dana', authMethod: 'google', googleSub: 'sub-dana' })

    reconcileGoogleUsers(db)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user WHERE id = ?').get(user.id).n, 1, 'still allowlisted, first run')

    config.ALLOWED_LOGIN_EMAILS.delete('dana@example.com')
    reconcileGoogleUsers(db)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user WHERE id = ?').get(user.id).n, 0, 'removed from the list, second run')
  } finally {
    config.ALLOWED_LOGIN_EMAILS.clear()
    for (const email of saved) config.ALLOWED_LOGIN_EMAILS.add(email)
  }
})

test('reconcileGoogleUsers is a no-op when every google-auth row is allowlisted', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM user').get().n
  reconcileGoogleUsers(db)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user').get().n, before)
})
