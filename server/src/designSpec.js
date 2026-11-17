// HO-852: the design canvas an item's first gate approves, frozen as the spec
// for Plan options, Implement and Automated review — the golden-case pattern
// (server/src/goldenCases.js) applied to the design sub-step (HO-850/HO-851).
//
// At the first gate — Change "Approve & prioritize this work", Task "Approve &
// prioritize" — the approver approves the latest round's canvas (the link
// domain/js/designCanvas.js reads off the run's first line), or approves
// without a design and says why. Either is copied into design_spec. Later
// steps read the canvas from that row only, never from a re-read of the
// sub-step's runs. A send-back to or before the first gate deletes the row
// (moveItem.js), as does a send-back to the design sub-step (store.js).
//
// Off unless both hold: the project's definitions switch is on, and the
// item's snapshot has a design sub-step. Off, nothing here changes what an
// item serves, how its gates approve or what its steps are sent.
//
// Pure DB: no GitHub and no farm I/O. The implement run's screenshots, which
// Automated review also gets, are screenshots.js's reviewShotsInput.

import { db } from './db.js'
import { hasNoProject } from './membership.js'
import { FIRST_GATE_INDEXES } from './goldenCases.js'
import { DESIGN_OUTPUT, designSubstepOf, latestRound } from './designRounds.js'
import { parseCanvasLine } from '../../domain/js/designCanvas.js'
import { IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, requiredStepIndex } from '../../domain/js/lifecycle.js'

export { DESIGN_OUTPUT, parseCanvasLine }

// The steps sent the frozen canvas, found by label. Only a Change has them: a
// Task or a Plan has no step with these labels, so a frozen canvas is never
// sent to any of its steps (it is still frozen and cleared at a Task's first
// gate, like its golden cases).
export const CANVAS_STEP_INDEXES = Object.freeze([
  requiredStepIndex('Plan options & trade-offs (pros / cons)'),
  IMPLEMENT_STEP_INDEX,
  REVIEW_STEP_INDEX,
])
export const CANVAS_LABEL = 'Approved design canvas'
export const SKIP_REASON_MAX_CHARS = 2000
// What an approver with no canvas in front of it (WhatsApp, Autopilot) is told.
export const APPROVE_IN_HORIZON_TEXT =
  'the design canvas needs a human to approve in Horizon: open the item, check the latest canvas and approve it there, or approve without design and say why'
export const CHANGED_TEXT = 'the design canvas changed since this page loaded — reload and check it again'
export const MISSING_TEXT =
  'the design sub-step has made no canvas yet — send it back to the design sub-step, or approve without design and say why'
export const SKIP_REASON_EMPTY_TEXT = 'approving without design needs a reason'

const selectProjectSwitch = db.prepare('SELECT definitions_enabled FROM project WHERE id = ?')
// By sub-step id, like store.js's substepDoneRuns: the anchor is checked in JS.
const selectSubstepRuns = db.prepare(
  "SELECT id, step_index, artifact FROM step_run WHERE item_id = ? AND substep_id = ? AND status = 'done' ORDER BY id DESC",
)
const selectSpec = db.prepare('SELECT * FROM design_spec WHERE item_id = ?')
const insertCanvas = db.prepare('INSERT INTO design_spec (item_id, canvas_url, source_run_id, approved_by) VALUES (?, ?, ?, ?)')
const insertSkip = db.prepare('INSERT INTO design_spec (item_id, skip_reason, approved_by) VALUES (?, ?, ?)')
const deleteSpec = db.prepare('DELETE FROM design_spec WHERE item_id = ?')

// item is a work_item row or getItem() — either carries project_id and
// substeps_json.
export function designRequired(item) {
  if (!item || hasNoProject(db, item.project_id) || !designSubstepOf(item)) return false
  return selectProjectSwitch.get(item.project_id)?.definitions_enabled === 1
}

// The reason the step 1 verdict gave when the sub-step's latest round is a
// skip (designRounds.js), else null. Such an item has no canvas to approve.
export function verdictSkipReason(item) {
  const sub = designSubstepOf(item)
  const latest = sub ? latestRound(item.id, sub.id) : null
  return latest?.kind === 'skip' ? latest.brief : null
}

// The latest round's canvas — the newest done run of the sub-step at its
// anchor — as { runId, url, slug, version }, or null when there is none, the
// run's first line is no canvas line, or the latest round is a skip.
export function pendingCanvas(item) {
  const sub = designSubstepOf(item)
  if (!sub || verdictSkipReason(item) != null) return null
  const run = selectSubstepRuns.all(item.id, sub.id).find((r) => r.step_index === sub.anchor)
  const canvas = run ? parseCanvasLine(run.artifact) : null
  return canvas ? { runId: run.id, ...canvas } : null
}

export function approvedDesign(itemId) {
  const row = selectSpec.get(itemId)
  if (!row) return null
  return {
    canvasUrl: row.canvas_url ?? null,
    skipReason: row.skip_reason ?? null,
    sourceRunId: row.source_run_id ?? null,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  }
}

// The approval check at a first gate, before anything is written. With a row
// already (nothing has sent the item back past this gate since), there is
// nothing to approve. A skip reason — "Approve without design" — wins over a
// canvas and must not be blank. A latest round the verdict skipped approves
// as a skip with the verdict's reason. Otherwise the latest round's canvas,
// and `runId` must be the run the approver was shown.
// { canvas } or { skip: { reason } } to store, {} for nothing to store, or
// { error, message }.
export function checkDesignApproval(item, { skipReason = null, runId = null } = {}) {
  if (approvedDesign(item.id)) return {}
  if (skipReason != null) {
    const reason = String(skipReason).trim().slice(0, SKIP_REASON_MAX_CHARS)
    if (!reason) return { error: 'design_skip_reason_empty', message: SKIP_REASON_EMPTY_TEXT }
    return { skip: { reason } }
  }
  const verdict = verdictSkipReason(item)
  if (verdict != null) return { skip: { reason: verdict, verdict: true } }
  const pending = pendingCanvas(item)
  if (!pending) return { error: 'design_missing', message: MISSING_TEXT }
  if (runId == null) return { error: 'design_changed', message: APPROVE_IN_HORIZON_TEXT }
  if (runId !== pending.runId) return { error: 'design_changed', message: CHANGED_TEXT }
  return { canvas: pending }
}

// Whether an approve that names no canvas run and gives no reason — the
// stepKey move form, WhatsApp, Autopilot — can pass the first gate: no design
// is required, the row is already there, or the verdict skipped the design.
export function designApprovable(item) {
  return !designRequired(item) || approvedDesign(item.id) != null || verdictSkipReason(item) != null
}

export function approveCanvas(itemId, canvas, actor) {
  insertCanvas.run(itemId, canvas.url, canvas.runId, actor)
}

export function skipDesign(itemId, reason, actor) {
  const why = String(reason ?? '').trim()
  if (!why) throw new Error('design_spec: a skip needs a reason')
  insertSkip.run(itemId, why, actor)
}

export function clearDesignSpec(itemId) {
  deleteSpec.run(itemId)
}

// The prior-artifact entry Plan options, Implement and Automated review are
// dispatched with, from the frozen row only. null for any other step, an item
// with no row, or one approved without design.
export function canvasInput(itemId, stepIndex) {
  if (!CANVAS_STEP_INDEXES.includes(stepIndex)) return null
  const approved = approvedDesign(itemId)
  if (!approved?.canvasUrl) return null
  return {
    label: CANVAS_LABEL,
    content: `The design canvas approved at the first gate by ${approved.approvedBy}: ${approved.canvasUrl}\n\nIt is the spec for every screen it shows. Build the screens to match it, and review them against it. A screen that has to differ says why. The canvas only ever comes from this approval, never from a later design round.`,
  }
}

// { designSpec } for the item view, or {} so an item without the feature
// serves exactly the keys it did before. pendingRunId is what the first gate
// posts back as designRunId to approve the canvas it shows.
export function designSpecFields(row) {
  if (!designRequired(row)) return {}
  const sub = designSubstepOf(row)
  const approved = approvedDesign(row.id)
  const pending = approved ? null : pendingCanvas(row)
  return {
    designSpec: {
      substepId: sub.id,
      gateIndex: FIRST_GATE_INDEXES.find((i) => i > sub.anchor) ?? null,
      approved: !!approved,
      canvasUrl: approved ? approved.canvasUrl : (pending?.url ?? null),
      skipReason: approved ? approved.skipReason : null,
      verdictSkipReason: approved ? null : verdictSkipReason(row),
      approvedBy: approved?.approvedBy ?? null,
      approvedAt: approved?.approvedAt ?? null,
      pendingRunId: pending?.runId ?? null,
    },
  }
}
