// Runtime settings persisted in SQLite (set from the UI), with env vars as
// fallback. The token never leaves this process — status endpoints only
// report whether one is configured.

import crypto from 'node:crypto'
import { db } from './db.js'

const getStmt = db.prepare('SELECT value FROM setting WHERE key = ?')
const setStmt = db.prepare(
  'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
)

export function getSetting(key) {
  return getStmt.get(key)?.value ?? null
}

export function setSetting(key, value) {
  setStmt.run(key, value)
}

export function getRepo() {
  return getSetting('github_repo') || process.env.HORIZON_REPO || null
}

export function getToken() {
  return getSetting('github_token') || process.env.GITHUB_TOKEN || null
}

export function getRepoUrl() {
  const repo = getRepo()
  return repo ? `https://github.com/${repo}` : 'https://github.com/FinTekkers/horizon'
}

// ---- human gate key ----
// Gates are human-only by construction: the plaintext key lives ONLY in the
// human's browser. Here we keep a salted scrypt hash — agents on this machine
// can read the DB, but a hash buys them nothing.

export function humanKeyConfigured() {
  return !!getSetting('human_key_hash')
}

export function setHumanKey(key) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(key, salt, 32)
  setSetting('human_key_hash', `${salt.toString('hex')}:${hash.toString('hex')}`)
}

export function verifyHumanKey(key) {
  const stored = getSetting('human_key_hash')
  if (!stored) return true // not configured yet -> gates stay open (demo mode)
  if (typeof key !== 'string' || key.length === 0) return false
  const [saltHex, hashHex] = stored.split(':')
  const hash = crypto.scryptSync(key, Buffer.from(saltHex, 'hex'), 32)
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'))
}

// The bot farm carries one project's context at a time; everything item-facing
// (board, tracker, agents, item APIs) is scoped to this project.
export function getActiveProjectId() {
  const value = getSetting('active_project_id')
  return value ? Number(value) : null
}
