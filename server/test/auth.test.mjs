// Unit tests for server/src/auth.js (HZ-21): identity, sessions, and the
// per-account gate PIN — a cryptographic blocker deliberately kept separate
// from login (an AI agent that can read this DB still can't self-approve).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-auth-')), 'test.db')
process.env.ADMIN_EMAIL = 'admin@example.com'
process.env.ADMIN_PASSWORD = 'super-secret'

const { db } = await import('../src/db.js')
const auth = await import('../src/auth.js')

// ---- initialsFor ----

test('initialsFor: two words takes first letter of first and last', () => {
  assert.equal(auth.initialsFor('Ada Lovelace'), 'AL')
  assert.equal(auth.initialsFor('Grace Brewster Hopper'), 'GH')
})

test('initialsFor: a single word takes its first two letters, uppercased', () => {
  assert.equal(auth.initialsFor('Cher'), 'CH')
})

test('initialsFor: empty/blank name falls back to "??"', () => {
  assert.equal(auth.initialsFor(''), '??')
  assert.equal(auth.initialsFor('   '), '??')
  assert.equal(auth.initialsFor(undefined), '??')
})

// ---- createUser / gate PIN ----

test('createUser returns a 6-digit PIN, and only its hash is ever persisted', () => {
  const { user, pin } = auth.createUser({ email: 'ada@example.com', name: 'Ada Lovelace', authMethod: 'password' })
  assert.match(pin, /^\d{6}$/)
  assert.equal(user.initials, 'AL')
  assert.equal(user.authMethod, 'password')
  const row = db.prepare('SELECT gate_pin_hash FROM user WHERE id = ?').get(user.id)
  assert.notEqual(row.gate_pin_hash, pin)
  assert.ok(auth.verifyGatePin(user.id, pin))
  const wrong = pin === '000000' ? '999999' : '000000'
  assert.ok(!auth.verifyGatePin(user.id, wrong))
})

test('verifyGatePin rejects a wrong or empty PIN, and an unknown user id', () => {
  const { user, pin } = auth.createUser({ email: 'grace@example.com', name: 'Grace Hopper', authMethod: 'password' })
  const wrong = pin === '111111' ? '222222' : '111111'
  assert.ok(!auth.verifyGatePin(user.id, wrong))
  assert.ok(!auth.verifyGatePin(user.id, ''))
  assert.ok(!auth.verifyGatePin('no-such-user', pin))
})

test('regenerateGatePin invalidates the old PIN and returns a new, working one', () => {
  const { user, pin } = auth.createUser({ email: 'margaret@example.com', name: 'Margaret Hamilton', authMethod: 'password' })
  const newPin = auth.regenerateGatePin(user.id)
  assert.notEqual(newPin, pin)
  assert.ok(!auth.verifyGatePin(user.id, pin))
  assert.ok(auth.verifyGatePin(user.id, newPin))
})

// ---- lookups ----

test('findUserByEmail / findUserById find the same row; unknown lookups are null', () => {
  const { user } = auth.createUser({ email: 'katherine@example.com', name: 'Katherine Johnson', authMethod: 'password' })
  assert.equal(auth.findUserByEmail('katherine@example.com').id, user.id)
  assert.equal(auth.findUserById(user.id).id, user.id)
  assert.equal(auth.findUserByEmail('nope@example.com'), null)
  assert.equal(auth.findUserById('nope'), null)
})

// ---- Google SSO account creation ----

test('findOrCreateGoogleUser creates a new account on first sign-in, with the right auth_method', () => {
  const user = auth.findOrCreateGoogleUser({ sub: 'google-sub-1', email: 'newbie@example.com', name: 'New Bie' })
  assert.equal(user.authMethod, 'google')
  assert.equal(user.initials, 'NB')
  assert.equal(auth.findUserByGoogleSub('google-sub-1').id, user.id)
})

test('findOrCreateGoogleUser logs the SAME user back in on a returning sign-in — no duplicate row', () => {
  const first = auth.findOrCreateGoogleUser({ sub: 'google-sub-2', email: 'returning@example.com', name: 'Returning User' })
  const countAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM user WHERE google_sub = ?').get('google-sub-2').n
  const second = auth.findOrCreateGoogleUser({ sub: 'google-sub-2', email: 'returning@example.com', name: 'Returning User' })
  assert.equal(second.id, first.id)
  assert.equal(countAfterFirst, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user WHERE google_sub = ?').get('google-sub-2').n, 1)
})

// ---- hardcoded password login ----

test('verifyPassword rejects a wrong email or password', () => {
  assert.equal(auth.verifyPassword('wrong@example.com', 'super-secret'), null)
  assert.equal(auth.verifyPassword('admin@example.com', 'wrong-password'), null)
})

test('verifyPassword creates the account on first successful login, and reuses it on the next one', () => {
  const first = auth.verifyPassword('admin@example.com', 'super-secret')
  assert.equal(first.authMethod, 'password')
  const countAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM user WHERE email = ?').get('admin@example.com').n
  const second = auth.verifyPassword('admin@example.com', 'super-secret')
  assert.equal(second.id, first.id)
  assert.equal(countAfterFirst, 1)
})

// ---- sessions ----

test('createSession + getSessionUser round-trips to the right user', () => {
  const { user } = auth.createUser({ email: 'session1@example.com', name: 'Session One', authMethod: 'password' })
  const token = auth.createSession(user.id)
  const found = auth.getSessionUser(token)
  assert.equal(found.id, user.id)
})

test('getSessionUser returns null for a missing, garbage, or empty token', () => {
  assert.equal(auth.getSessionUser('not-a-real-token'), null)
  assert.equal(auth.getSessionUser(''), null)
  assert.equal(auth.getSessionUser(undefined), null)
})

test('an expired session is rejected and cleaned up', () => {
  const { user } = auth.createUser({ email: 'session2@example.com', name: 'Session Two', authMethod: 'password' })
  const token = auth.createSession(user.id)
  // Session ids are sha256(token) hex (see auth.js) — reproduced here to
  // reach into the row directly, since backdating expiry has no public API.
  const hash = crypto.createHash('sha256').update(token).digest('hex')
  db.prepare("UPDATE session SET expires_at = datetime('now', '-1 hour') WHERE id = ?").run(hash)
  assert.equal(auth.getSessionUser(token), null)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session WHERE id = ?').get(hash).n, 0)
})

test('deleteSession ends the session immediately', () => {
  const { user } = auth.createUser({ email: 'session3@example.com', name: 'Session Three', authMethod: 'password' })
  const token = auth.createSession(user.id)
  assert.ok(auth.getSessionUser(token))
  auth.deleteSession(token)
  assert.equal(auth.getSessionUser(token), null)
})
