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
// HZ-36: every findOrCreateGoogleUser call below now needs its email
// allowlisted (deny-by-default) in addition to emailVerified — this file's
// own concern is the linking/session logic beneath that gate, not the
// allowlist itself (see loginAllowlist.test.mjs for that).
process.env.ALLOWED_LOGIN_EMAILS = [
  'admin@example.com',
  'newbie@example.com',
  'returning@example.com',
  'ci-match@example.com',
  'unverified@example.com',
  'retry-after-block@example.com',
  'already-linked@example.com',
].join(',')

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

// HZ-36 guardrail: deny-by-default. A verified email that simply isn't on
// ALLOWED_LOGIN_EMAILS must be rejected and must create no row at all — not
// even the "unverified email" GoogleLinkBlockedError path, a brand-new one.
test('findOrCreateGoogleUser BLOCKS a verified email that is not on the allowlist, creating no row', () => {
  assert.throws(
    () =>
      auth.findOrCreateGoogleUser({
        sub: 'google-sub-not-allowlisted',
        email: 'stranger@example.com',
        name: 'A Stranger',
        emailVerified: true,
      }),
    auth.GoogleLinkBlockedError,
  )
  assert.equal(auth.findUserByGoogleSub('google-sub-not-allowlisted'), null)
  assert.equal(auth.findUserByEmail('stranger@example.com'), null)
})

// HZ-36 guardrail: the allowlist comparison must use the VERIFIED claim
// only — an allowlisted address with an unverified claim must still reject.
test('findOrCreateGoogleUser BLOCKS an allowlisted email whose claim is not verified', () => {
  assert.throws(
    () =>
      auth.findOrCreateGoogleUser({
        sub: 'google-sub-allowlisted-unverified',
        email: 'newbie@example.com',
        name: 'New Bie',
        emailVerified: false,
      }),
    auth.GoogleLinkBlockedError,
  )
  assert.equal(auth.findUserByGoogleSub('google-sub-allowlisted-unverified'), null)
})

test('findOrCreateGoogleUser creates a new account on first sign-in, with the right auth_method', () => {
  const user = auth.findOrCreateGoogleUser({ sub: 'google-sub-1', email: 'newbie@example.com', name: 'New Bie', emailVerified: true })
  assert.equal(user.authMethod, 'google')
  assert.equal(user.initials, 'NB')
  assert.equal(auth.findUserByGoogleSub('google-sub-1').id, user.id)
})

test('findOrCreateGoogleUser logs the SAME user back in on a returning sign-in — no duplicate row', () => {
  const first = auth.findOrCreateGoogleUser({ sub: 'google-sub-2', email: 'returning@example.com', name: 'Returning User', emailVerified: true })
  const countAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM user WHERE google_sub = ?').get('google-sub-2').n
  const second = auth.findOrCreateGoogleUser({ sub: 'google-sub-2', email: 'returning@example.com', name: 'Returning User', emailVerified: true })
  assert.equal(second.id, first.id)
  assert.equal(countAfterFirst, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user WHERE google_sub = ?').get('google-sub-2').n, 1)
})

// The regression this file exists to pin: `email` is UNIQUE, so signing in
// with Google using an address that already logged in by password used to hit
// `UNIQUE constraint failed: user.email` — permanently locking SSO out of the
// one account most likely to try it (the admin's).
test('findOrCreateGoogleUser adopts an existing password account with the same VERIFIED email', () => {
  const byPassword = auth.verifyPassword('admin@example.com', 'super-secret')
  assert.ok(byPassword, 'password login should seed the account first')

  const viaGoogle = auth.findOrCreateGoogleUser({
    sub: 'google-sub-admin',
    email: 'admin@example.com',
    name: 'Admin',
    emailVerified: true,
  })

  assert.equal(viaGoogle.id, byPassword.id, 'should reuse the row, not create a second one')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user WHERE email = ?').get('admin@example.com').n, 1)
  assert.equal(db.prepare('SELECT google_sub FROM user WHERE id = ?').get(byPassword.id).google_sub, 'google-sub-admin')
})

test('findOrCreateGoogleUser matches the existing email case-insensitively', () => {
  const { user: existing } = auth.createUser({ email: 'ci-match@example.com', name: 'CI Match', authMethod: 'password' })

  const viaGoogle = auth.findOrCreateGoogleUser({
    sub: 'google-sub-ci-match',
    email: 'CI-Match@Example.com',
    name: 'CI Match',
    emailVerified: true,
  })

  assert.equal(viaGoogle.id, existing.id, 'should link the same row regardless of email casing')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user WHERE lower(email) = lower(?)').get('ci-match@example.com').n, 1)
})

// HZ-37 guardrail: an unverified Google email must never attach to an
// existing account — this is an account-takeover vector, not a UX nicety.
test('findOrCreateGoogleUser BLOCKS linking when Google has not verified the email', () => {
  const { user: existing } = auth.createUser({ email: 'unverified@example.com', name: 'Unverified Target', authMethod: 'password' })

  assert.throws(
    () =>
      auth.findOrCreateGoogleUser({
        sub: 'google-sub-unverified',
        email: 'unverified@example.com',
        name: 'Attacker Claim',
        emailVerified: false,
      }),
    auth.GoogleLinkBlockedError,
  )

  const row = db.prepare('SELECT google_sub FROM user WHERE id = ?').get(existing.id)
  assert.equal(row.google_sub, null, 'the existing row must be untouched')
  assert.equal(auth.findUserByGoogleSub('google-sub-unverified'), null, 'no row should be created or linked for the unverified sub')
})

// After a blocked attempt, a genuine verified sign-in from the real owner
// must still succeed — the burned state isn't permanent.
test('a fresh VERIFIED sign-in succeeds after an earlier unverified attempt was blocked', () => {
  const { user: existing } = auth.createUser({ email: 'retry-after-block@example.com', name: 'Retry Target', authMethod: 'password' })

  assert.throws(() =>
    auth.findOrCreateGoogleUser({
      sub: 'google-sub-retry',
      email: 'retry-after-block@example.com',
      name: 'Retry Target',
      emailVerified: false,
    }),
  )

  const linked = auth.findOrCreateGoogleUser({
    sub: 'google-sub-retry',
    email: 'retry-after-block@example.com',
    name: 'Retry Target',
    emailVerified: true,
  })
  assert.equal(linked.id, existing.id)
  assert.equal(db.prepare('SELECT google_sub FROM user WHERE id = ?').get(existing.id).google_sub, 'google-sub-retry')
})

// HZ-37 guardrail: never re-link or merge — a row already linked to a
// DIFFERENT Google identity must reject a second one, even if verified.
test('findOrCreateGoogleUser BLOCKS relinking a row that already has a different google_sub', () => {
  const { user: existing } = auth.createUser({
    email: 'already-linked@example.com',
    name: 'Already Linked',
    authMethod: 'google',
    googleSub: 'google-sub-original',
  })

  assert.throws(
    () =>
      auth.findOrCreateGoogleUser({
        sub: 'google-sub-different',
        email: 'already-linked@example.com',
        name: 'Already Linked',
        emailVerified: true,
      }),
    auth.GoogleLinkBlockedError,
  )

  const row = db.prepare('SELECT google_sub FROM user WHERE id = ?').get(existing.id)
  assert.equal(row.google_sub, 'google-sub-original', 'the original link must not be overwritten')
})

test('adopting an account preserves its gate PIN — linking must not re-issue it', () => {
  const user = auth.verifyPassword('admin@example.com', 'super-secret')
  const pinHashBefore = db.prepare('SELECT gate_pin_hash FROM user WHERE id = ?').get(user.id).gate_pin_hash

  auth.findOrCreateGoogleUser({ sub: 'google-sub-admin', email: 'admin@example.com', name: 'Admin', emailVerified: true })

  const pinHashAfter = db.prepare('SELECT gate_pin_hash FROM user WHERE id = ?').get(user.id).gate_pin_hash
  assert.equal(pinHashAfter, pinHashBefore, 'a PIN the human already wrote down must stay valid')
})

test('a subsequent Google sign-in finds the adopted account by sub', () => {
  const user = auth.verifyPassword('admin@example.com', 'super-secret')
  auth.findOrCreateGoogleUser({ sub: 'google-sub-admin', email: 'admin@example.com', name: 'Admin', emailVerified: true })

  const returning = auth.findOrCreateGoogleUser({ sub: 'google-sub-admin', email: 'admin@example.com', name: 'Admin', emailVerified: true })
  assert.equal(returning.id, user.id)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user WHERE email = ?').get('admin@example.com').n, 1)
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

// ---- personal API tokens (HZ-179) ----

const TOKEN_SHAPE = /^hz_[A-Za-z0-9_-]{43}$/
const tokenHash = (raw) => crypto.createHash('sha256').update(raw).digest('hex')

test('createApiToken: hz_ prefix, 32 random bytes, distinct every time, stored only as sha256', () => {
  const { user } = auth.createUser({ email: 'tokens1@example.com', name: 'Token One', authMethod: 'password' })
  const seen = new Set()
  for (let i = 0; i < 100; i++) {
    const created = auth.createApiToken(user.id, `t${i}`)
    assert.match(created.token, TOKEN_SHAPE)
    assert.equal(Buffer.from(created.token.slice(3), 'base64url').length, 32)
    seen.add(created.token)
  }
  assert.equal(seen.size, 100)

  const created = auth.createApiToken(user.id, 'hash-check')
  const row = db.prepare('SELECT * FROM api_token WHERE id = ?').get(created.id)
  assert.equal(row.token_hash, tokenHash(created.token))
  assert.equal(row.last4, created.token.slice(-4))
  for (const [column, value] of Object.entries(row)) {
    assert.notEqual(value, created.token, `api_token.${column} holds the raw token`)
  }
})

test('createApiToken: defaults to a 90-day expiry', () => {
  const { user } = auth.createUser({ email: 'tokens2@example.com', name: 'Token Two', authMethod: 'password' })
  const created = auth.createApiToken(user.id, 'default-expiry')
  const days = (Date.parse(created.expiresAt) - Date.parse(created.createdAt)) / 86_400_000
  assert.equal(days, 90)
})

test('getTokenAuth resolves a live token to its user and records last use', () => {
  const { user } = auth.createUser({ email: 'tokens3@example.com', name: 'Token Three', authMethod: 'password' })
  const created = auth.createApiToken(user.id, 'ci-bot')
  const found = auth.getTokenAuth(created.token)
  assert.deepEqual(found, { user: auth.findUserById(user.id), tokenId: created.id, tokenName: 'ci-bot' })
  assert.ok(db.prepare('SELECT last_used_at FROM api_token WHERE id = ?').get(created.id).last_used_at)
})

test('getTokenAuth writes last_used_at at most once a minute', () => {
  const { user } = auth.createUser({ email: 'tokens4@example.com', name: 'Token Four', authMethod: 'password' })
  const created = auth.createApiToken(user.id, 'throttle')
  auth.getTokenAuth(created.token)
  const first = db.prepare('SELECT last_used_at FROM api_token WHERE id = ?').get(created.id).last_used_at
  db.prepare('UPDATE api_token SET last_used_at = ? WHERE id = ?').run(new Date(Date.now() - 30_000).toISOString(), created.id)
  const pinned = db.prepare('SELECT last_used_at FROM api_token WHERE id = ?').get(created.id).last_used_at
  auth.getTokenAuth(created.token)
  assert.equal(db.prepare('SELECT last_used_at FROM api_token WHERE id = ?').get(created.id).last_used_at, pinned)
  db.prepare('UPDATE api_token SET last_used_at = ? WHERE id = ?').run(new Date(Date.now() - 61_000).toISOString(), created.id)
  auth.getTokenAuth(created.token)
  assert.ok(db.prepare('SELECT last_used_at FROM api_token WHERE id = ?').get(created.id).last_used_at >= first)
})

test('getTokenAuth returns null for malformed, unknown, revoked, expired-now and orphaned tokens', () => {
  const { user } = auth.createUser({ email: 'tokens5@example.com', name: 'Token Five', authMethod: 'password' })
  for (const bad of [undefined, '', 'abc', 'hz_', `hz_${'A'.repeat(42)}`, `xx_${'A'.repeat(43)}`]) {
    assert.equal(auth.getTokenAuth(bad), null, `accepted ${bad}`)
  }
  assert.equal(auth.getTokenAuth(`hz_${'A'.repeat(43)}`), null, 'accepted a well-formed unknown token')

  const revoked = auth.createApiToken(user.id, 'revoked')
  assert.ok(auth.getTokenAuth(revoked.token))
  assert.equal(auth.revokeApiToken(user.id, revoked.id), true)
  assert.equal(auth.getTokenAuth(revoked.token), null)
  assert.equal(auth.revokeApiToken(user.id, revoked.id), false, 'revoking twice reports nothing revoked')

  const expiring = auth.createApiToken(user.id, 'expiring')
  assert.ok(auth.getTokenAuth(expiring.token))
  db.prepare('UPDATE api_token SET expires_at = ? WHERE id = ?').run(new Date().toISOString(), expiring.id)
  assert.equal(auth.getTokenAuth(expiring.token), null)

  // A token whose user row is gone. user deletion has no app path, so the FK is
  // switched off just long enough to simulate one.
  const { user: doomed } = auth.createUser({ email: 'tokens6@example.com', name: 'Doomed', authMethod: 'password' })
  const orphan = auth.createApiToken(doomed.id, 'orphan')
  assert.ok(auth.getTokenAuth(orphan.token))
  db.pragma('foreign_keys = OFF')
  try {
    db.prepare('DELETE FROM user WHERE id = ?').run(doomed.id)
  } finally {
    db.pragma('foreign_keys = ON')
  }
  assert.equal(auth.getTokenAuth(orphan.token), null)
})

test('revokeApiToken and listApiTokens only ever touch the caller’s own tokens', () => {
  const { user: a } = auth.createUser({ email: 'tokens7@example.com', name: 'Owner A', authMethod: 'password' })
  const { user: b } = auth.createUser({ email: 'tokens8@example.com', name: 'Owner B', authMethod: 'password' })
  const tokenA = auth.createApiToken(a.id, 'a-token')
  assert.equal(auth.revokeApiToken(b.id, tokenA.id), false)
  assert.ok(auth.getTokenAuth(tokenA.token))
  assert.deepEqual(auth.listApiTokens(b.id), [])
  assert.deepEqual(auth.listApiTokens(a.id).map((t) => t.id), [tokenA.id])
})

test('getTokenAuth confirms the hash with crypto.timingSafeEqual (constant-time guardrail)', async () => {
  // Timing cannot be asserted behaviourally in a unit test; this pins the call so
  // it is not removed as redundant next to the indexed lookup.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('export function getTokenAuth('))
  const fnBody = body.slice(0, body.indexOf('\n}\n'))
  assert.match(fnBody, /crypto\.timingSafeEqual\(/)
})

test('the api_token schema is additive: re-running init leaves every other table untouched', async () => {
  const { spawnSync } = await import('node:child_process')
  const { user } = auth.createUser({ email: 'tokens9@example.com', name: 'Schema', authMethod: 'password' })
  const session = auth.createSession(user.id)
  const others = () =>
    db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT IN ('api_token', 'idx_api_token_user') AND name NOT LIKE 'sqlite_autoindex_api_token%' ORDER BY name")
      .all()
  const before = others()
  assert.ok(before.some((r) => r.name === 'session'))

  db.exec('DROP TABLE api_token')
  const dbModule = new URL('../src/db.js', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(dbModule)})`], {
    env: { ...process.env },
    encoding: 'utf8',
  })
  assert.equal(child.status, 0, child.stderr)

  assert.deepEqual(others(), before)
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_token'").get(), 'init did not recreate api_token')
  assert.equal(auth.getSessionUser(session)?.id, user.id, 'a session from before re-init no longer authenticates')
})
