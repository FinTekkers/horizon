// HO-862: web-page visual artifacts — an agent's self-contained HTML page,
// served to members behind one stable link per item.
//
// Off unless the item's project has its web-page visuals switch on
// (project.visual_pages_enabled, PIN-gated in Admin) AND the project is
// internal: a tenant step runs as another user whose files farmd cannot read,
// so a tenant project never gets pages. Off, no dispatch body carries
// `visual_pages`, no item view carries `visualPage`, and a result's
// `artifacts.page` is dropped.
//
// The farm (farm/visual_page.py) checks, captures and stores each round under
// FARM_HOME/state/pages/<item> and owns the round numbers. item_page_round
// lists the rounds whose result reached this server; the latest one is what
// GET /api/items/:id/page serves. The rules — CSP, viewports, names — are
// domain/visualPage.json, the declaration the farm reads too.

import rules from '../../domain/visualPage.json' with { type: 'json' }
import { db } from './db.js'
import { hasNoProject } from './membership.js'
import { kindStepIndex, requiredStepIndex } from '../../domain/js/lifecycle.js'

// No allow-same-origin: agent JS runs in an opaque origin with no Horizon
// session, cookies or API access.
export const PAGE_CSP = rules.csp
export const SHOT_NAME = new RegExp(rules.shotName)
export const PAGE_MAX_BYTES = rules.maxBytes
export const VIEWPORT_NAMES = Object.freeze(rules.viewports.map((v) => v.name))
// The steps whose prompt may ask for a page — farm/step_agent.py's
// VISUAL_PAGE_LABELS. Reviewer steps are left out: one page per item, and a
// review must never replace the page the owner asked for.
export const VISUAL_PAGE_STEP_INDEXES = Object.freeze([
  requiredStepIndex('Plan options & trade-offs (pros / cons)'),
  requiredStepIndex('Draft implementation plan'),
  kindStepIndex('Design options & recommendation', 'plan'),
])

const SHA256 = /^[0-9a-f]{64}$/
const MAX_ROUND = 9999

const selectProject = db.prepare('SELECT visual_pages_enabled, isolation FROM project WHERE id = ?')
const selectRounds = db.prepare(
  `SELECT r.round, r.created_at, r.desktop_png, r.phone_png, s.step_index
     FROM item_page_round r JOIN step_run s ON s.id = r.step_run_id
    WHERE r.item_id = ? ORDER BY r.round`,
)
const selectLatest = db.prepare('SELECT round, sha256, bytes FROM item_page_round WHERE item_id = ? ORDER BY round DESC LIMIT 1')
const selectShot = db.prepare('SELECT 1 FROM item_page_round WHERE item_id = ? AND (desktop_png = ? OR phone_png = ?)')
const insertRound = db.prepare(
  `INSERT OR IGNORE INTO item_page_round (item_id, round, step_run_id, sha256, bytes, desktop_png, phone_png)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
)

// Whether the item's project has web-page visuals on. Fails closed: no
// project, a missing row, or any isolation but 'internal' is off.
export function visualPagesEnabled(item) {
  if (!item || item.project_id == null || hasNoProject(db, item.project_id)) return false
  const row = selectProject.get(item.project_id)
  return !!row && row.visual_pages_enabled === 1 && row.isolation === 'internal'
}

// Whether a step's /steps/run body carries `visual_pages: true`.
export function visualPagesFor(item, stepIndex) {
  return VISUAL_PAGE_STEP_INDEXES.includes(stepIndex) && visualPagesEnabled(item)
}

// Why a result's `artifacts.page` is not one to record, or null.
function pageProblem(page) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) return 'not an object'
  if (!Number.isInteger(page.round) || page.round < 1 || page.round > MAX_ROUND) return 'bad round'
  if (typeof page.sha256 !== 'string' || !SHA256.test(page.sha256)) return 'bad sha256'
  if (!Number.isInteger(page.bytes) || page.bytes < 1 || page.bytes > PAGE_MAX_BYTES) return 'bad bytes'
  const shots = page.shots
  if (!shots || typeof shots !== 'object') return 'bad shots'
  for (const name of VIEWPORT_NAMES) {
    const shot = Object.hasOwn(shots, name) ? shots[name] : null
    if (shot !== `page-r${page.round}-${name}.png` || !SHOT_NAME.test(shot)) return `bad ${name} shot`
  }
  return null
}

// Records one round from a farm result. Idempotent: a retried result for the
// same round is ignored. Returns { ok } or { error } naming why nothing was
// recorded — the caller logs it and never fails the run for it.
export function recordPageRound(runId, item, stepIndex, page) {
  if (!visualPagesFor(item, stepIndex)) return { error: 'web-page visuals are off for this step' }
  const problem = pageProblem(page)
  if (problem) return { error: problem }
  insertRound.run(item.id, page.round, runId, page.sha256, page.bytes, page.shots.desktop, page.shots.phone)
  return { ok: true }
}

// The latest recorded round { round, sha256, bytes }, or null.
export function latestPageRound(itemId) {
  return selectLatest.get(itemId) ?? null
}

// Whether `name` is a recorded round's PNG for the item.
export function pageShotRecorded(itemId, name) {
  return typeof name === 'string' && SHOT_NAME.test(name) && !!selectShot.get(itemId, name, name)
}

// The item view's `visualPage`, only once a round is recorded. `url` is the
// stable artifact link (API-relative); each round's `shots` are the names
// GET /api/items/:id/page/shots/:name serves.
export function visualPageFields(row) {
  const rounds = selectRounds.all(row.id)
  if (!rounds.length) return {}
  return {
    visualPage: {
      url: `/api/items/${encodeURIComponent(row.id)}/page`,
      rounds: rounds.map((r) => ({
        round: r.round,
        stepIndex: r.step_index,
        createdAt: r.created_at,
        shots: { desktop: r.desktop_png, phone: r.phone_png },
      })),
    },
  }
}
