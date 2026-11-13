// HO-844: Accept with exceptions at a Task's Review & close.
//
// A Task whose newest Verify & report outcome is `done_proof_incomplete` did
// its work, but some metric lines lack their named proof. Besides Approve and
// Return to…, its Review & close gate (steps.json `acceptWithExceptions`)
// then offers to close it with one named exception per open line, each with a
// reason. store.approveGate writes them, one gate_exception row per line under
// the approving gate_decision row, in the same transaction (db.js). The rows
// are append-only.
//
// Everything here reads the server's own state: the item, its metric and its
// stored Verify run. A client sends only { lineId, reason } pairs and the hash
// of the open lines it showed; never a verdict or a list of lines. The stored
// verdict is only read, never rewritten.
//
// Which lines are open: the line numbers the Verify reply named
// (step_run.verify_open_lines) that are lines of the item's metric now. When
// it named none, or none that still are, every metric line is open — the
// owner then gives a reason for each, rather than the record missing one.

import { createHash } from 'node:crypto'
import { db } from './db.js'
import { criteriaLines } from '../../domain/js/fields.js'
import { VERIFY_REPORT_STEP_INDEX, acceptsWithExceptions, isAbandoned, isClosed, itemKindOf } from '../../domain/js/lifecycle.js'
import { readOpenLines, readVerifyOutcome } from './verifyOutcome.js'

export const REASON_MAX_CHARS = 2000

// The status each refusal answers with. Nothing is written on any of them.
export const EXCEPTION_ERROR_STATUS = Object.freeze({
  not_task_item: 409,
  not_at_gate: 409,
  verdict_not_incomplete: 409,
  open_lines_changed: 409,
  exceptions_mismatch: 400,
  reason_blank: 400,
})

const refuse = (error) => ({ error, status: EXCEPTION_ERROR_STATUS[error] })

const selectLatestVerify = db.prepare(
  `SELECT verdict, verify_outcome, verify_open_lines FROM step_run
    WHERE item_id = ? AND step_index = ? AND substep_id IS NULL AND status = 'done' ORDER BY id DESC LIMIT 1`,
)

// The open lines' identity: their ids and texts, in order. A metric edit or a
// new Verify run changes it, so a dialog opened before either is refused.
export function hashOpenLines(openLines) {
  return createHash('sha256')
    .update(JSON.stringify(openLines.map((line) => [line.id, line.text])))
    .digest('hex')
}

// { openLines: [{ id, text }], linesHash } when `row` (a work_item row) may be
// accepted with exceptions now, else a refusal { error, status }.
export function acceptState(row) {
  if (itemKindOf(row) !== 'task') return refuse('not_task_item')
  if (isClosed(row) || isAbandoned(row) || !acceptsWithExceptions(row.cursor)) return refuse('not_at_gate')
  const run = selectLatestVerify.get(row.id, VERIFY_REPORT_STEP_INDEX)
  if (readVerifyOutcome(run) !== 'done_proof_incomplete') return refuse('verdict_not_incomplete')
  const lines = criteriaLines(row.metric)
  if (lines.length === 0) return refuse('verdict_not_incomplete')
  const named = (readOpenLines(run) ?? []).filter((n) => n <= lines.length)
  const numbers = named.length > 0 ? named : lines.map((_, i) => i + 1)
  const openLines = numbers.map((n) => ({ id: String(n), text: lines[n - 1] }))
  return { openLines, linesHash: hashOpenLines(openLines) }
}

// The item view's offer, or null. The cursor is checked first, so the many
// items not at a flagged gate cost no query.
export function offerFor(row) {
  if (!acceptsWithExceptions(row.cursor)) return null
  const state = acceptState(row)
  return state.error ? null : state
}

// Pairs the submitted { lineId, reason } list with the server's open lines:
// exactly one per open line, no other. A reason that is blank after trim()
// — spaces, tabs, newlines or any other whitespace — is refused. Returns
// { rows: [{ lineId, metricLine, reason }] } in line order, or a refusal.
export function matchExceptions(openLines, submitted) {
  if (!Array.isArray(submitted) || submitted.length !== openLines.length) return refuse('exceptions_mismatch')
  const byId = new Map()
  for (const entry of submitted) {
    const lineId = entry?.lineId
    if (typeof lineId !== 'string' || byId.has(lineId)) return refuse('exceptions_mismatch')
    byId.set(lineId, entry.reason)
  }
  const rows = []
  for (const line of openLines) {
    if (!byId.has(line.id)) return refuse('exceptions_mismatch')
    const reason = byId.get(line.id)
    if (typeof reason !== 'string' || !reason.trim()) return refuse('reason_blank')
    rows.push({ lineId: line.id, metricLine: line.text, reason: reason.trim().slice(0, REASON_MAX_CHARS) })
  }
  return { rows }
}

// The whole check behind an accept: the item may be accepted now, the client
// saw these open lines, and it gave one non-blank reason for each. Returns
// { rows } or a refusal.
export function checkAccept(row, { exceptions, linesHash } = {}) {
  const state = acceptState(row)
  if (state.error) return state
  if (linesHash !== state.linesHash) return refuse('open_lines_changed')
  return matchExceptions(state.openLines, exceptions)
}

const insertException = db.prepare(
  'INSERT INTO gate_exception (item_id, gate_decision_id, line_id, metric_line, reason, decided_by) VALUES (?, ?, ?, ?, ?, ?)',
)

// Writes checkAccept's rows under gate decision `decisionId`. Called inside
// store.approveGate's transaction only.
export function insertExceptions(itemId, decisionId, rows, decidedBy) {
  for (const row of rows) insertException.run(itemId, decisionId, row.lineId, row.metricLine, row.reason, decidedBy)
}

const selectExceptions = db.prepare(
  `SELECT id, gate_decision_id, line_id, metric_line, reason, decided_by, created_at FROM gate_exception
    WHERE item_id = ? ORDER BY gate_decision_id DESC, id`,
)

// Every exception the item was accepted with, newest decision first, each
// decision's in line order.
export function listExceptions(itemId) {
  return selectExceptions.all(itemId).map((row) => ({
    id: row.id,
    decisionId: row.gate_decision_id,
    lineId: row.line_id,
    metricLine: row.metric_line,
    reason: row.reason,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
  }))
}

const selectExceptionDecisions = db.prepare(
  `SELECT DISTINCT g.item_id, g.created_at FROM gate_exception x JOIN gate_decision g ON g.id = x.gate_decision_id
    WHERE x.item_id IN (SELECT value FROM json_each(?))`,
)

// productivity.js: of `closes` ([{ item_id, closed_at }]), the item ids whose
// counted close is a decision with exceptions — its gate_decision row is the
// close at closed_at. A later plain approve or GitHub close counts as a pass.
export function exceptionCloseIds(closes) {
  if (closes.length === 0) return new Set()
  const keyOf = (itemId, at) => `${itemId}\u0000${at}`
  const excepted = new Set(
    selectExceptionDecisions.all(JSON.stringify(closes.map((c) => c.item_id))).map((row) => keyOf(row.item_id, row.created_at)),
  )
  return new Set(closes.filter((c) => excepted.has(keyOf(c.item_id, c.closed_at))).map((c) => c.item_id))
}
