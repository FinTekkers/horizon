// Identity, sessions and per-account gate PINs (HZ-21).
//
// Two independent trust boundaries live here, deliberately kept apart:
//   - Login (password or Google) says WHO you are.
//   - The gate PIN is a pure cryptographic blocker so an AI agent — which can
//     read this database — still can't self-approve a gate. It is generated
//     per account, never chosen, and checked separately from login.
// Both use the same salted-scrypt hash-at-rest pattern this codebase already
// used for the (now removed) shared human_key_hash setting.

import crypto from 'node:crypto'
import { db } from './db.js'
import { ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_TTL_DAYS } from './config.js'
import { isAllowedEmail } from './loginAllowlist.js'

function hashSecret(plain) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(plain, salt, 32)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

function verifySecret(plain, stored) {
  if (!stored || typeof plain !== 'string' || plain.length === 0) return false
  const [saltHex, hashHex] = stored.split(':')
  const hash = crypto.scryptSync(plain, Buffer.from(saltHex, 'hex'), 32)
  const expected = Buffer.from(hashHex, 'hex')
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected)
}

// "Ada Lovelace" -> "AL"; single word -> first two letters; empty -> "??".
export function initialsFor(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words.at(-1)[0]).toUpperCase()
}

function generatePin() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

function toPublicUser(row) {
  if (!row) return null
  return { id: row.id, email: row.email, name: row.name, initials: row.initials, authMethod: row.auth_method }
}

// Returns { user, pin } — pin is the plaintext, shown to the caller exactly
// once; only its hash is ever persisted.
export function createUser({ email, name, authMethod, googleSub = null }) {
  const id = crypto.randomUUID()
  const pin = generatePin()
  db.prepare(
    `INSERT INTO user (id, email, name, initials, auth_method, google_sub, gate_pin_hash, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(id, email, name, initialsFor(name), authMethod, googleSub, hashSecret(pin))
  return { user: toPublicUser(db.prepare('SELECT * FROM user WHERE id = ?').get(id)), pin }
}

export function findUserByGoogleSub(sub) {
  return toPublicUser(db.prepare('SELECT * FROM user WHERE google_sub = ?').get(sub))
}

export function findUserByEmail(email) {
  return toPublicUser(db.prepare('SELECT * FROM user WHERE email = ?').get(email))
}

// Case-insensitive, for the Google linking check only (HZ-37): Google's own
// email claim can differ in case from whatever was typed at password
// signup, and they must still resolve to the same account. `findUserByEmail`
// above stays exact-match — its one caller (`verifyPassword`) compares
// against the literal ADMIN_EMAIL env var, where that's correct.
export function findUserByEmailCI(email) {
  return toPublicUser(db.prepare('SELECT * FROM user WHERE lower(email) = lower(?)').get(email))
}

export function findUserById(id) {
  return toPublicUser(db.prepare('SELECT * FROM user WHERE id = ?').get(id))
}

function touchLastLogin(id) {
  db.prepare("UPDATE user SET last_login_at = datetime('now') WHERE id = ?").run(id)
}

// Thrown (never returned) when a Google identity must NOT be attached to an
// existing account — the route maps this to a redirect with a readable
// error, distinct from the plain-500 case an unexpected DB failure would be.
export class GoogleLinkBlockedError extends Error {}

// Finds-or-creates the Google user for this profile and returns it, ready to
// start a session.
//
// Cases, in order. The email-match branch is why this isn't a plain find-or-
// create: `email` is UNIQUE, so an account that already signed in with the
// ADMIN_EMAIL/ADMIN_PASSWORD credential owns that address with google_sub
// NULL. Looking up by sub alone misses it and the INSERT then dies on the
// email constraint — meaning Google SSO could never work for the one address
// most likely to try it. So adopt that row instead: attach the sub and keep
// everything else, deliberately including auth_method and the existing gate
// PIN. The account is linked, not replaced, and the PIN a human already wrote
// down stays valid.
//
// Linking is gated on `emailVerified` (HZ-37): Google lets a user register an
// address without proving they control it, so an unverified claim must never
// attach to somebody else's existing account — that's a straight account
// takeover. A row whose `google_sub` is already set to something else is
// left alone too; this fix links one existing row per email, it never
// re-links or merges rows.
//
// Gated on the login allowlist first (HZ-36): the HTTP route already checks
// this before calling us, but this is a second, independent gate so any
// other caller (a script, an admin tool, a future route) can't reach a
// Google identity — new, linked, or returning — without going through it
// too. Re-checked even for a RETURNING sub, so removing an address from the
// allowlist blocks a previously-linked account's very next login, not just
// new ones.
export function findOrCreateGoogleUser({ sub, email, name, emailVerified }) {
  if (!emailVerified || !isAllowedEmail(email)) throw new GoogleLinkBlockedError('not_allowed')
  const existing = findUserByGoogleSub(sub)
  if (existing) {
    touchLastLogin(existing.id)
    return existing
  }
  const sameEmail = findUserByEmailCI(email)
  if (sameEmail) {
    if (!emailVerified) throw new GoogleLinkBlockedError('unverified_email')
    const { google_sub: existingSub } = db.prepare('SELECT google_sub FROM user WHERE id = ?').get(sameEmail.id)
    if (existingSub) throw new GoogleLinkBlockedError('already_linked')
    db.prepare("UPDATE user SET google_sub = ?, last_login_at = datetime('now') WHERE id = ?").run(sub, sameEmail.id)
    return findUserById(sameEmail.id)
  }
  return createUser({ email, name, authMethod: 'google', googleSub: sub }).user
}

// The hardcoded credential path: verifies against ADMIN_EMAIL/ADMIN_PASSWORD
// (env vars in production, a dev-mode fallback otherwise) and creates the
// account on first successful login. Returns the user or null.
export function verifyPassword(email, password) {
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) return null
  const existing = findUserByEmail(email)
  if (existing) {
    touchLastLogin(existing.id)
    return existing
  }
  return createUser({ email, name: 'Admin', authMethod: 'password' }).user
}

// ---- sessions ----

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
  db.prepare('INSERT INTO session (id, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expiresAt)
  return token
}

export function getSessionUser(token) {
  if (!token) return null
  const session = db.prepare('SELECT * FROM session WHERE id = ?').get(sha256(token))
  if (!session) return null
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM session WHERE id = ?').run(session.id)
    return null
  }
  return findUserById(session.user_id)
}

export function deleteSession(token) {
  if (!token) return
  db.prepare('DELETE FROM session WHERE id = ?').run(sha256(token))
}

// ---- API tokens (HZ-179) ----
// Personal bearer tokens for scripts. Stored exactly like sessions — only
// sha256(raw) at rest — and checked by the same onRequest gate in app.js,
// which marks the request as token-authenticated so humanAuthorized() and the
// token-management routes can refuse it. A token is never a gate credential.

export const API_TOKEN_DEFAULT_DAYS = 90
export const API_TOKEN_MAX_DAYS = 365
const API_TOKEN_PREFIX = 'hz_'
// 'hz_' + base64url of 32 random bytes (43 chars, no padding). The prefix is
// there so secret scanners can recognise a leaked token.
const API_TOKEN_SHAPE = /^hz_[A-Za-z0-9_-]{43}$/
const LAST_USED_THROTTLE_MS = 60_000

function toPublicToken(row) {
  return {
    id: row.id,
    name: row.name,
    last4: row.last4,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  }
}

// Returns the public fields plus `token`, the raw value — the only time it
// ever leaves this module.
export function createApiToken(userId, name, expiresInDays = API_TOKEN_DEFAULT_DAYS) {
  const token = API_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url')
  const id = `tok_${crypto.randomUUID()}`
  const now = Date.now()
  const createdAt = new Date(now).toISOString()
  const expiresAt = new Date(now + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
  db.prepare(
    `INSERT INTO api_token (id, user_id, name, token_hash, last4, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, name, sha256(token), token.slice(-4), createdAt, expiresAt)
  return { id, name, token, last4: token.slice(-4), createdAt, expiresAt }
}

// Active (unrevoked) tokens only. Never selects token_hash.
export function listApiTokens(userId) {
  return db
    .prepare(
      `SELECT id, name, last4, created_at, last_used_at, expires_at FROM api_token
       WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id`,
    )
    .all(userId)
    .map(toPublicToken)
}

// Scoped to the caller's own tokens: someone else's id is indistinguishable
// from an unknown one. Returns whether a token was revoked.
export function revokeApiToken(userId, id) {
  const result = db
    .prepare('UPDATE api_token SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), id, userId)
  return result.changes === 1
}

// Resolves a raw bearer value to { user, tokenId, tokenName }, or null when it
// is malformed, unknown, revoked, expired, or its user no longer exists.
export function getTokenAuth(raw) {
  if (typeof raw !== 'string' || !API_TOKEN_SHAPE.test(raw)) return null
  const hash = sha256(raw)
  const row = db.prepare('SELECT * FROM api_token WHERE token_hash = ?').get(hash)
  if (!row) return null
  // The indexed lookup already matched; this constant-time re-check is here
  // because the HZ-179 guardrail requires tokens be compared in constant time.
  // Do not remove it as redundant.
  if (!crypto.timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(hash, 'hex'))) return null
  if (row.revoked_at) return null
  const now = Date.now()
  if (new Date(row.expires_at).getTime() <= now) return null
  const user = findUserById(row.user_id)
  if (!user) return null
  // Throttled in SQL rather than in memory: at most one write per token a minute.
  db.prepare(
    'UPDATE api_token SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)',
  ).run(new Date(now).toISOString(), row.id, new Date(now - LAST_USED_THROTTLE_MS).toISOString())
  return { user, tokenId: row.id, tokenName: row.name }
}

// ---- gate PIN ----
// Deliberately separate from everything above: verifying a PIN never touches
// login state, and logging in never touches the PIN.

export function verifyGatePin(userId, pin) {
  const row = db.prepare('SELECT gate_pin_hash FROM user WHERE id = ?').get(userId)
  return !!row && verifySecret(pin, row.gate_pin_hash)
}

// Returns the new plaintext PIN — shown once, same as account creation.
export function regenerateGatePin(userId) {
  const pin = generatePin()
  db.prepare('UPDATE user SET gate_pin_hash = ? WHERE id = ?').run(hashSecret(pin), userId)
  return pin
}
