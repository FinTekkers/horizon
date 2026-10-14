// HZ-448: a Plan's item drafts — the one store for them. The Draft items
// step's `plan_draft` reply is ingested here (orchestrator.completeFarmRun),
// and an owner's edit is saved here (PUT /api/items/:id/plan-draft). Each is
// a new version of the whole document in the `plan_draft` table; the highest
// version is the current draft.
//
// Every write goes through domain/js/planDraft.js's validatePlanDraft with the
// server's own context — the repos the Plan's project connects and the items
// that exist — so neither the farm's check nor the browser's is trusted.
//
// Nothing here files anything: no GitHub call, and no write to work_item,
// work_item_dependency or item_spawn. Filing is Approve & file's (HZ-449),
// which reads its input through currentDraft() below and adds no store.

import { db } from './db.js'
import { validatePlanDraft } from '../../domain/js/planDraft.js'
import { REASON } from '../../domain/js/reasons.js'
import { APPROVE_FILE_GATE_INDEX, PLAN_DRAFT_STEP_INDEX, isAbandoned, isClosed } from '../../domain/js/lifecycle.js'

const loadItem = (itemId) =>
  db.prepare('SELECT id, kind, repo, project_id, cursor, abandoned_at FROM work_item WHERE id = ?').get(itemId)
const latestRow = (itemId) =>
  db.prepare('SELECT * FROM plan_draft WHERE item_id = ? ORDER BY version DESC LIMIT 1').get(itemId)

// The server's context for the real-key and repo rules. A Plan may file in
// any repo its project connects, plus its own; a real key counts in free text
// only if its prefix is a connected repo's.
function contextFor(item) {
  const projectRepos = item.project_id
    ? db.prepare('SELECT repo FROM project_repo WHERE project_id = ?').all(item.project_id).map((r) => r.repo)
    : []
  const exists = db.prepare('SELECT 1 FROM work_item WHERE id = ?')
  return {
    knownRepos: [...projectRepos, ...(item.repo ? [item.repo] : [])],
    keyPrefixes: db.prepare('SELECT prefix FROM project_repo').all().map((r) => r.prefix),
    keyExists: (key) => !!exists.get(key),
  }
}

function insertVersion(itemId, doc, source, stepRunId, createdBy) {
  const { n } = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS n FROM plan_draft WHERE item_id = ?').get(itemId)
  db.prepare(
    'INSERT INTO plan_draft (item_id, version, doc_json, source, step_run_id, created_by) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(itemId, n, JSON.stringify(doc), source, stepRunId, createdBy)
  return n
}

// Why an owner may not edit the item's draft now, or null. The window runs
// from just after Draft items up to and including the Approve & file gate.
function editBlock(item) {
  if (isClosed(item) || isAbandoned(item)) return 'not_editable'
  if (item.cursor <= PLAN_DRAFT_STEP_INDEX || item.cursor > APPROVE_FILE_GATE_INDEX) return 'not_editable'
  if (db.prepare("SELECT 1 FROM step_run WHERE item_id = ? AND status = 'active'").get(item.id)) return 'run_active'
  return null
}

// The current draft: { version, source, createdBy, createdAt, doc }, or null
// when Draft items has not produced one. HZ-449's filing input — stable.
export function currentDraft(itemId) {
  const row = latestRow(itemId)
  if (!row) return null
  return { version: row.version, source: row.source, createdBy: row.created_by, createdAt: row.created_at, doc: JSON.parse(row.doc_json) }
}

// Whether an owner may edit the item's draft now: a draft exists, the item is
// inside the edit window, and no step run is active on it.
export function isEditable(item) {
  return !!latestRow(item.id) && editBlock(item) === null
}

// Records the Draft items step's reply as the next 'agent' version — the
// current draft, even over an owner's earlier edits. A missing or invalid
// draft writes nothing: { error: REASON.INVALID_PLAN_DRAFT, errors } — the
// same id the failed run is tagged with.
export function ingestDraft(item, runId, doc, actor) {
  if (doc === undefined || doc === null) {
    const message = 'invalid_shape: the reply carries no plan_draft'
    return { error: REASON.INVALID_PLAN_DRAFT, errors: [{ path: 'plan_draft', code: 'invalid_shape', message }] }
  }
  const checked = validatePlanDraft(doc, contextFor(item))
  if (!checked.ok) return { error: REASON.INVALID_PLAN_DRAFT, errors: checked.errors }
  return { ok: true, version: db.transaction(() => insertVersion(item.id, doc, 'agent', runId, actor))() }
}

// Saves an owner's edit of the whole document as the next 'owner' version,
// after re-validating all of it. `baseVersion` is the version the edit was
// made on; any other current version is a stale edit.
export function saveOwnerEdit(itemId, { baseVersion, doc, actor }) {
  return db.transaction(() => {
    const item = loadItem(itemId)
    if (!item) return { error: 'not_found' }
    const current = latestRow(itemId)
    if (!current) return { error: 'no_plan_draft' }
    const blocked = editBlock(item)
    if (blocked) return { error: blocked }
    if (baseVersion !== current.version) return { error: 'stale_version', currentVersion: current.version }
    const checked = validatePlanDraft(doc, contextFor(item))
    if (!checked.ok) return { error: REASON.INVALID_PLAN_DRAFT, errors: checked.errors }
    return { ok: true, version: insertVersion(itemId, doc, 'owner', null, actor), doc }
  })()
}
