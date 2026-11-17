// HO-851: an item's design sub-step — the snapshot entry whose output is
// 'design' (HO-850) — decided, recorded and returned from.
//
// - Entry. When its anchor step's own run finishes, the verdict that run's
//   artifact records (domain/js/designVerdict.js) decides: `no` with a reason
//   skips the sub-step, and anything else runs it. A missing or unreadable
//   verdict runs it, never skips. Decided at run time only: `applies` and the
//   intake snapshot are untouched.
// - Rounds. Each run, skip and forced run is one append-only substep_round row
//   (db.js) with its brief — the send-back note, the override reason or the
//   verdict line — and its what-changed note. substep_cursor clearing never
//   touches them.
// - Return. While the item is at its design sub-step, substep_pending_json
//   carries the round in flight. A round sent back from a gate names that gate
//   (returnKey), and the finished round goes straight back to it when the
//   only rows in between are "Set guardrails" and its inputs are unchanged
//   (designReturnIndex). Else the item walks on and "Set guardrails" re-runs.
//
// Reads and writes substep_round, and reads step_run. It never writes
// work_item: moveItem.js stays the only writer of an item's step.
// The design sub-step is found by its output, never by its id.

import { createHash } from 'node:crypto'
import { db } from './db.js'
import { STEPS, itemKindOf, laneSkips, requiredStepIndex, stepIndexOf, stepsFor } from '../../domain/js/lifecycle.js'
import { currentSubstep, substepsOf } from '../../domain/js/substeps.js'
import { parseDesignVerdict } from '../../domain/js/designVerdict.js'

export const DESIGN_OUTPUT = 'design'
export const GUARDRAILS_STEP_INDEX = requiredStepIndex('Set guardrails')
// The item fields "Set guardrails" is given that a design round could change:
// the outcome and the success metric. A field added here changes every stored
// hash, which only ever makes the next round re-run the step.
export const GUARDRAILS_INPUT_FIELDS = Object.freeze(['desc', 'metric'])
export const ROUND_KINDS = Object.freeze(['run', 'skip', 'forced'])
// What a round with no what_changed line, or none in flight, stores.
export const NOT_STATED = 'Not stated'
const BRIEF_MAX_CHARS = 2000

// The item's design sub-step, or null. With `anchorIndex`, only one that
// follows that step.
export function designSubstepOf(item, anchorIndex = null) {
  return substepsOf(item).find((s) => s.output === DESIGN_OUTPUT && (anchorIndex == null || s.anchor === anchorIndex)) ?? null
}

// The sub-step the item is at, when it is its design sub-step.
export function currentDesignSubstep(item) {
  const sub = currentSubstep(item)
  return sub?.output === DESIGN_OUTPUT ? sub : null
}

// What the entry does once the anchor's run finished with `artifactMd`:
//   { action: 'skip', reason }
//   { action: 'run', brief, unreadable? } — `unreadable` says why the verdict
//   could not be read; the sub-step runs and the caller logs it.
export function decideDesignEntry(artifactMd) {
  const verdict = parseDesignVerdict(artifactMd)
  if (verdict.unreadable) return { action: 'run', brief: `Verdict missing or unreadable: ${verdict.unreadable}`, unreadable: verdict.unreadable }
  if (!verdict.needed) return { action: 'skip', reason: verdict.reason }
  return { action: 'run', brief: verdict.line }
}

// ---- the round in flight (work_item.substep_pending_json) ----

const PENDING_KINDS = new Set(['run', 'forced'])

export function encodePending({ returnKey = null, brief, kind = 'run', overrideReason = null, who = 'Horizon' }) {
  return JSON.stringify({
    returnKey: typeof returnKey === 'string' ? returnKey : null,
    brief: String(brief ?? '').slice(0, BRIEF_MAX_CHARS),
    kind: PENDING_KINDS.has(kind) ? kind : 'run',
    overrideReason: overrideReason == null ? null : String(overrideReason).slice(0, BRIEF_MAX_CHARS),
    who: String(who ?? 'Horizon').slice(0, 200),
  })
}

// The item's round in flight, or null for none or anything unreadable.
export function readPending(item) {
  if (typeof item?.substep_pending_json !== 'string') return null
  try {
    const parsed = JSON.parse(item.substep_pending_json)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// ---- "Set guardrails" inputs ----

export function guardrailsInputsHash(item) {
  const values = GUARDRAILS_INPUT_FIELDS.map((field) => (Object.hasOwn(item ?? {}, field) ? (item[field] ?? null) : null))
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

const selectLastGuardrailsRun = db.prepare(
  "SELECT inputs_hash FROM step_run WHERE item_id = ? AND step_index = ? AND substep_id IS NULL AND status = 'done' ORDER BY id DESC LIMIT 1",
)

// The inputs hash of the item's last finished "Set guardrails" run, or null
// (no run, or one from before the hash was stored).
export function lastGuardrailsHash(itemId) {
  return selectLastGuardrailsRun.get(itemId, GUARDRAILS_STEP_INDEX)?.inputs_hash ?? null
}

// Pure: the gate a finished design round goes straight back to, or null to
// walk on. The item is at its design sub-step with a round sent back from a
// gate; every row its lane runs between here and that gate is "Set
// guardrails"; and `guardrailsHash` — that step's last stored inputs — equals
// the item's inputs now. Both the completion (returnTarget) and the single
// writer's guard (moveItem.js completionAllowed) ask this, so neither can
// skip a stale "Set guardrails".
export function designReturnIndex(item, guardrailsHash) {
  if (!currentDesignSubstep(item)) return null
  const gate = stepIndexOf(readPending(item)?.returnKey)
  if (gate === null || STEPS[gate]?.kind !== 'gate' || gate <= item.cursor) return null
  const skips = laneSkips(item)
  const rows = stepsFor(itemKindOf(item)).filter((step) => !skips.has(step.index) && step.index > item.cursor && step.index <= gate)
  if (!rows.some((step) => step.index === gate)) return null
  const between = rows.filter((step) => step.index !== gate)
  if (between.some((step) => step.index !== GUARDRAILS_STEP_INDEX)) return null
  if (between.length > 0 && (guardrailsHash == null || guardrailsHash !== guardrailsInputsHash(item))) return null
  return gate
}

export function returnTarget(item) {
  return designReturnIndex(item, lastGuardrailsHash(item.id))
}

// ---- rounds ----

const selectRounds = db.prepare(
  'SELECT round, kind, run_id, brief, what_changed, override_reason, created_by, created_at FROM substep_round WHERE item_id = ? AND substep_id = ? ORDER BY round',
)
const selectMaxRound = db.prepare('SELECT COALESCE(MAX(round), 0) AS n FROM substep_round WHERE item_id = ? AND substep_id = ?')
const insertRound = db.prepare(
  'INSERT INTO substep_round (item_id, substep_id, round, kind, run_id, brief, what_changed, override_reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
)

// The number the sub-step's next round gets.
export function nextRound(itemId, substepId) {
  return selectMaxRound.get(itemId, substepId).n + 1
}

// One round, numbered after the last, in one transaction. Returns its number.
export function recordRound(itemId, substepId, { kind, runId = null, brief, whatChanged = null, overrideReason = null, who = 'Horizon' }) {
  if (!ROUND_KINDS.includes(kind)) throw new Error(`substep_round: unknown kind ${kind}`)
  return db.transaction(() => {
    const round = nextRound(itemId, substepId)
    insertRound.run(
      itemId,
      substepId,
      round,
      kind,
      runId,
      String(brief ?? '').slice(0, BRIEF_MAX_CHARS) || NOT_STATED,
      whatChanged == null ? null : String(whatChanged),
      overrideReason == null ? null : String(overrideReason),
      String(who ?? 'Horizon'),
    )
    return round
  })()
}

// SQLite's datetime('now') is UTC with no zone; served as ISO.
const isoUtc = (ts) => (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts)

// Every round of the sub-step, oldest first, as the item payload serves them.
export function listRounds(itemId, substepId) {
  return selectRounds.all(itemId, substepId).map((row) => ({
    round: row.round,
    kind: row.kind,
    brief: row.brief,
    whatChanged: row.what_changed ?? null,
    overrideReason: row.override_reason ?? null,
    runId: row.run_id ?? null,
    createdBy: row.created_by,
    createdAt: isoUtc(row.created_at),
  }))
}

export function latestRound(itemId, substepId) {
  return listRounds(itemId, substepId).at(-1) ?? null
}
