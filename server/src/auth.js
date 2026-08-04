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

export function findUserById(id) {
  return toPublicUser(db.prepare('SELECT * FROM user WHERE id = ?').get(id))
}

function touchLastLogin(id) {
  db.prepare("UPDATE user SET last_login_at = datetime('now') WHERE id = ?").run(id)
}

// Finds-or-creates the Google user for this profile and returns it, ready to
// start a session.
export function findOrCreateGoogleUser({ sub, email, name }) {
  const existing = findUserByGoogleSub(sub)
  if (existing) {
    touchLastLogin(existing.id)
    return existing
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
