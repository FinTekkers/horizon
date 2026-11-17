// HO-870: the backend registry. forRepo(repo) is the one call server code
// uses to get a repo's { tracker, review, vcs, artifacts } adapters.
//
// Dispatch mirrors tenantTokens.tokenForRepo: the repo is looked up in
// project_repo case-insensitively, a tenant project's row first, and a repo
// that is not a string, not connected or has no row falls back to the default
// (GitHub) — exactly as tokenForRepo falls back to settings.getToken().
//
// No call site uses this yet; HO-871 and HO-872 move them over. store.js and
// db.js must never import this file (it loads github.js, which imports
// store.js) — they read the value set from ./names.js.

import { db } from '../db.js'
import { BACKENDS, DEFAULT_BACKEND, isBackend } from './names.js'
import { githubAdapters } from './github.js'
import { slAdapters } from './sl.js'

export { BACKENDS, DEFAULT_BACKEND, isBackend }

const ADAPTERS = Object.freeze({ github: githubAdapters, sl: slAdapters })

// The same lookup as selectRepoProject in tenantTokens.js — keep the two in step.
const selectRepoBackend = db.prepare(`
  SELECT r.backend FROM project_repo r JOIN project p ON p.id = r.project_id
  WHERE r.repo = ? COLLATE NOCASE ORDER BY p.isolation = 'tenant' DESC LIMIT 1
`)

// The backend `repo` (owner/name) runs on: 'github' or 'sl'.
export function backendOf(repo) {
  const backend = typeof repo === 'string' ? selectRepoBackend.get(repo)?.backend : null
  return isBackend(backend) ? backend : DEFAULT_BACKEND
}

// The adapters for `repo`: { tracker, review, vcs, artifacts }.
export function forRepo(repo) {
  return ADAPTERS[backendOf(repo)]
}
