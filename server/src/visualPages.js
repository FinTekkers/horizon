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
// HZ-938: the same three statements per page slot — the web-page visual
// (item_page_round) and the design sub-step's Horizon page
// (item_design_page_round). Only the gate in front of each differs.
function slotStatements(table) {
  return {
    selectLatest: db.prepare(`SELECT round, sha256, bytes FROM ${table} WHERE item_id = ? ORDER BY round DESC LIMIT 1`),
    selectShot: db.prepare(`SELECT 1 FROM ${table} WHERE item_id = ? AND (desktop_png = ? OR phone_png = ?)`),
    selectShots: db.prepare(`SELECT desktop_png, phone_png FROM ${table} WHERE item_id = ? AND round = ?`),
    insertRound: db.prepare(
      `INSERT OR IGNORE INTO ${table} (item_id, round, step_run_id, sha256, bytes, desktop_png, phone_png)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
  }
}
const VISUAL = slotStatements('item_page_round')
const DESIGN = slotStatements('item_design_page_round')

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
  return recordSlotRound(VISUAL, runId, item, page)
}

function recordSlotRound(slot, runId, item, page) {
  const problem = pageProblem(page)
  if (problem) return { error: problem }
  slot.insertRound.run(item.id, page.round, runId, page.sha256, page.bytes, page.shots.desktop, page.shots.phone)
  return { ok: true }
}

const shotRecorded = (slot, itemId, name) => typeof name === 'string' && SHOT_NAME.test(name) && !!slot.selectShot.get(itemId, name, name)

// The latest recorded round { round, sha256, bytes }, or null.
export function latestPageRound(itemId) {
  return VISUAL.selectLatest.get(itemId) ?? null
}

// Whether `name` is a recorded round's PNG for the item.
export function pageShotRecorded(itemId, name) {
  return shotRecorded(VISUAL, itemId, name)
}

// ---- HZ-938: the design sub-step's Horizon page ----
//
// Gated on the project being internal (or the item having none) only — NOT on
// visual_pages_enabled, on purpose: the design page is the fallback a box
// draws when its design tool cannot run, and an item must never pause because
// a switch about something else is off. A tenant project never gets one: its
// design sub-step never runs (farm/step_agent.py _execute_design).
export function designPagesAllowed(item) {
  if (!item) return false
  if (item.project_id == null || hasNoProject(db, item.project_id)) return true
  return selectProject.get(item.project_id)?.isolation === 'internal'
}

// Records one design page round from a design run's `artifacts.design_page`.
// Idempotent, and { ok } or { error } like recordPageRound.
export function recordDesignPageRound(runId, item, page) {
  if (!designPagesAllowed(item)) return { error: 'design pages are off for this project' }
  return recordSlotRound(DESIGN, runId, item, page)
}

export function latestDesignPageRound(itemId) {
  return DESIGN.selectLatest.get(itemId) ?? null
}

export function designPageShotRecorded(itemId, name) {
  return shotRecorded(DESIGN, itemId, name)
}

// The recorded shots of one design page round, { desktop, phone }, or null.
export function designPageShots(itemId, round) {
  const row = Number.isInteger(round) ? DESIGN.selectShots.get(itemId, round) : null
  return row ? { desktop: row.desktop_png, phone: row.phone_png } : null
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
