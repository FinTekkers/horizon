// HO-870: the backend registry. forRepo(repo) is the one call server code
// uses to get a repo's { tracker, review, vcs, artifacts } adapters.
//
// Dispatch mirrors tenantTokens.tokenForRepo: the repo is looked up in
// project_repo case-insensitively, a tenant project's row first, and a repo
// that is not a string, not connected or has no row falls back to the default
// (GitHub) — exactly as tokenForRepo falls back to settings.getToken().
//
// HO-871 moved the tracker call sites here; HO-872 and HO-873 moved the rest.
// Outside backends/, only the call-site files test/backend-registry.test.mjs
// lists may import this file. store.js and db.js must never import it (it loads
// github.js, which imports store.js) — they read the value set from ./names.js.

import { db } from '../db.js'
import { BACKENDS, DEFAULT_BACKEND, isBackend } from './names.js'
import { githubAdapters } from './github.js'
import { slAdapters, slScreenshotPublisher } from './sl.js'
import { createSlVcs } from './sl/vcs.js'
import { refreshDiffStatus, submitDiff as submitSlDiff } from './sl/review.js'
import { FARM_URL } from '../config.js'
import { isTaskBackedItem } from '../trackerRefs.js'

export { BACKENDS, DEFAULT_BACKEND, isBackend }
// HO-872: GitHub's e2e-only answers, for app.js's /api/test/* routes, so app.js
// need not import github.js for them.
export { githubTestHooks } from './github.js'
// HO-873: GitHub's request headers, for tokenCheck.js, which only ever checks
// a GitHub token against GitHub's API, so need not import github.js for them.
export { ghHeaders } from './github.js'

// HO-877: an sl repo's vcs.land is the exactly-once land of its pinned diff
// through farmd (backends/sl/vcs.js) — on a server with a farm. With none, it
// stays sl.js's backend_not_implemented placeholder, as the sl tracker does.
const slWithLand = FARM_URL ? Object.freeze({ ...slAdapters, vcs: Object.freeze({ ...slAdapters.vcs, land: createSlVcs().land }) }) : slAdapters

const ADAPTERS = Object.freeze({ github: githubAdapters, sl: slWithLand })

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

// HO-871: test-only replacements, by backend name. Empty in production.
const testOverrides = {}

function adaptersFor(backend) {
  return Object.hasOwn(testOverrides, backend) ? testOverrides[backend] : ADAPTERS[backend]
}

// The adapters for `repo`: { tracker, review, vcs, artifacts }.
export function forRepo(repo) {
  return adaptersFor(backendOf(repo))
}

// HO-901: the adapters for an item. An sl Task-backed item (its immutable
// work_item.backend is 'sl') always gets sl's — even once its repo is
// disconnected and forRepo would fall back to GitHub's, which would call the
// GitHub API with its null issue. Any other item gets exactly forRepo's.
export function forItem(item) {
  return isTaskBackedItem(item) ? adaptersFor('sl') : forRepo(item?.repo)
}

// HO-878: where an implement result's screenshot bundle goes, for a repo whose
// backend keeps publishes on this server: sl's file store. null for GitHub,
// whose farm pushes e2e-artifacts/<id> itself, so the caller drops the bundle.
const SCREENSHOT_PUBLISHERS = Object.freeze({ sl: slScreenshotPublisher })

export function screenshotPublisherFor(repo) {
  const backend = backendOf(repo)
  return Object.hasOwn(SCREENSHOT_PUBLISHERS, backend) ? SCREENSHOT_PUBLISHERS[backend] : null
}

// HO-877: re-reads and records the review status of `itemId`'s pinned diff,
// for the Accept caretaker (server.js injects it). An sl repo's item asks farmd
// (backends/sl/review.js); any other repo has no diff, so it resolves null.
export function refreshReviewStatus(itemId, repo) {
  return backendOf(repo) === 'sl' ? refreshDiffStatus(itemId) : Promise.resolve(null)
}

// HO-877: submits an sl item's implemented change as its one diff and pins it
// on the item (work_item.diff_id) — the only diff Accept will ever land. For
// orchestrator.js's implement result; resolves { diff, commit, updated }. Any
// other repo opens a PR instead, so this rejects for it.
export function submitDiff(item, opts) {
  if (backendOf(item?.repo) !== 'sl') return Promise.reject(new Error(`${item?.repo} is not an sl repo: it opens a PR, not a diff`))
  return submitSlDiff(item, opts)
}

// The adapters for a backend by name, for calls that serve no one repo — the
// GitHub poll loop and its sync status. Throws on a name that is not a backend.
export function forKind(backend) {
  if (!isBackend(backend)) throw new Error(`unknown backend: ${backend}`)
  return adaptersFor(backend)
}

// Test seam: forRepo() and forKind() hand out `adapters` for `backend` until
// it is called again with null, which restores the real ones.
export function setBackendForTest(backend, adapters) {
  if (!isBackend(backend)) throw new Error(`unknown backend: ${backend}`)
  if (adapters == null) delete testOverrides[backend]
  else testOverrides[backend] = adapters
}
