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

// Agent farm (farm/ Python daemon). Unset -> no farm: items sit blocked on
// setup instead of faking progress (see orchestrator.js's 'unconfigured'
// farm state). Same DB-override/env-fallback shape as getRepo()/getToken()
// above, so existing env-var installs (e.g. shoreward.ai) keep working
// unchanged and take precedence over anything saved from the setup screen.
export function getFarmUrl() {
  return getSetting('farm_url') || process.env.FARM_URL || null
}

export function getFarmSharedSecret() {
  return getSetting('farm_shared_secret') || process.env.FARM_SHARED_SECRET || 'dev-secret'
}

// The bot farm carries one project's context at a time; everything item-facing
// (board, tracker, agents, item APIs) is scoped to this project.
export function getActiveProjectId() {
  const value = getSetting('active_project_id')
  return value ? Number(value) : null
}
