// Runtime settings persisted in SQLite (set from the UI), with env vars as
// fallback. The token never leaves this process — status endpoints only
// report whether one is configured.

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

// The project the board shows (HZ-207: no longer the only one the farm runs —
// every enabled project's items are dispatched). Board, tracker and item
// creation are scoped to it until HZ-208.
export function getActiveProjectId() {
  const value = getSetting('active_project_id')
  return value ? Number(value) : null
}

// The project farmd was started for (/farm/start), which the concierge serves
// until HZ-209. Separate from the board's project so switching the board never
// restarts farmd. Falls back to the board's project when never pinned.
export function getFarmProjectId() {
  const value = getSetting('farm_project_id')
  return value ? Number(value) : getActiveProjectId()
}

// HZ-235: auto-resolve conflicts on open items when main moves. On by
// default; '0' in the setting row (checked first) or AUTO_RESOLVE_ON_MAIN
// turns it off — rollback tier 1, no deploy. Read at every scan.
export function isAutoResolveOnMain() {
  return (getSetting('auto_resolve_on_main') ?? process.env.AUTO_RESOLVE_ON_MAIN) !== '0'
}
