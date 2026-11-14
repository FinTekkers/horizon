// HZ-710: the one move. Every way an item's step changes — approve, return
// to, retry, abandon, reopen, and the internal close a GitHub issue close
// makes — goes through moveItem, in one transaction: validate, apply the one
// reset rule, write the step and insert one item_move row. The only other
// writer of an item's step is step completion (writeStepCompletion below),
// which logs no move. server/test/move-item-single-writer.test.mjs pins that
// no other module writes `cursor`.
//
// planMove is pure — no database — so the table test can walk every
// (current step, target) pair of every kind. Steps are named by key here and
// in item_move; the record keeps its position (domain/js/lifecycle.js).
//
// This module moves and logs, and one more write: HZ-820 — a move that closes
// or abandons the item dismisses its open soft asks in the same transaction
// (asks.js dismissSoftAsksForParent), so a soft ask never outlives its item.
// Cancelling a run, queueing feedback, the activity event and the kick stay
// with the callers (store.js's wrappers), so each existing route keeps its
// own wording.
import { db } from './db.js'
import { PARENT_ABANDONED_REASON, PARENT_CLOSED_REASON, dismissSoftAsksForParent } from './asks.js'
import { isHumanProof } from './humanProof.js'
import { clearGoldenCases } from './goldenCases.js'
import {
  ACCEPT_GATE_INDEX,
  APPROVE_FILE_GATE_INDEX,
  APPROVE_RUN_GATE_INDEX,
  IMPACT_REVIEW_STEP_INDEX,
  IMPLEMENT_ITEM_KIND,
  IMPLEMENT_STEP_INDEX,
  PREFLIGHT_STEP_INDEX,
  REVIEW_STEP_INDEX,
  RUN_PLAN_STEP_INDEX,
  STEPS,
  defaultReworkTarget,
  endIndex,
  firstStepIndex,
  isAbandoned,
  isClosed,
  isHumanOnlyGate,
  itemKindOf,
  laneCheckIndexes,
  laneSkips,
  mergedFloor,
  nextCursor,
  stepIndexOf,
  stepKeyAt,
  stepsFor,
} from '../../domain/js/lifecycle.js'
import { currentSubstep, decodeMoveKey, encodeMoveKey, substepReworkTargets, substepsOf } from '../../domain/js/substeps.js'

// The five a human (or the route) can ask for, plus 'close', which only a
// GitHub issue close makes — the route never offers it.
export const MOVE_ACTIONS = Object.freeze(['approve', 'return', 'retry', 'abandon', 'reopen', 'close'])
export const ROUTE_MOVE_ACTIONS = Object.freeze(MOVE_ACTIONS.filter((action) => action !== 'close'))

// A closed item sits one past its kind's last row, where no step key is.
export const CLOSED_KEY = 'closed'

export const MERGED_HINT = 'This item is merged. File a follow-up item instead.'

// The gate that approves an item's golden cases, by key: each kind's first
// gate (server/src/goldenCases.js FIRST_GATE_INDEXES).
export const GOLDEN_GATE_KEYS = Object.freeze(['change.approve-prioritize', 'task.approve-prioritize'])
const GOLDEN_GATE_INDEXES = GOLDEN_GATE_KEYS.map(stepIndexOf)

// What a return to at or before implement clears: a fresh automated review
// loop, no HZ-182 fix pass, and no forward to Accept the code.
export const REVIEW_STATE_COLUMNS = Object.freeze([
  'review_cycle_count = 0',
  'fix_pass = 0',
  'fix_findings_json = NULL',
  'last_reviewed_sha = NULL',
  'forwarded_review_run_id = NULL',
  'forwarded_by = NULL',
  'forwarded_sha = NULL',
])

// The columns that say where an item is. Only this module writes them; an
// agent's patch (orchestrator.js writeWorkItemPatch) drops them.
export const STEP_COLUMNS = Object.freeze(['cursor', 'substep_cursor'])

// The only other columns a move or a completion may write alongside the step.
// Anything else is refused, so `fields` cannot become a back door.
export const MOVE_FIELDS = Object.freeze(
  new Set([
    'approved_plan_hash',
    'approved_runner',
    // HO-843: the per-command approval and the owner patch in flight.
    'approved_command_hashes_json',
    'approved_frame_hash',
    'command_patch_json',
    'fix_pass',
    'fix_findings_json',
    'forwarded_review_run_id',
    'forwarded_by',
    'forwarded_sha',
    'substep_cursor',
  ]),
)

// Automated outcomes that move an item back, or on to a gate, rather than to
// its next row. They are step completions, not moves: the review loop counts
// its own cycles, so the reset rule must not clear them.
const AUTOMATED_OUTCOMES = new Map([
  [REVIEW_STEP_INDEX, new Set([IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX])],
  [IMPACT_REVIEW_STEP_INDEX, new Set([RUN_PLAN_STEP_INDEX])],
  // HO-839: a failed rehearsal sends the plan back from Preflight.
  [PREFLIGHT_STEP_INDEX, new Set([RUN_PLAN_STEP_INDEX])],
])

const NO_RESET = Object.freeze({
  clearReview: false,
  clearPlanHash: false,
  clearGolden: false,
  clearFiling: false,
  releaseHolds: false,
  clearMerged: false,
})

// The step key an item sits at, or CLOSED_KEY.
export function moveKeyOf(item) {
  return isClosed(item) ? CLOSED_KEY : stepKeyAt(item.cursor)
}

// The one reset rule. Returning to `toIndex` redoes it and every row after
// it, so an approval at a gate at or after it is no longer an approval: the
// run plan, the golden cases and the filing choice each clear only when the
// target is at or before their own gate. The review counters clear only at or
// before implement. Holds are released. Nothing before the target, and never
// the branch or the PR, is touched.
//
// The golden cases and the run plan hash are cleared here. The filing choice
// is the newest Approve & file approval's (store.js filedAutopilotOff), so
// clearFiling needs no write: the gate must be approved again, and that new
// decision row carries the new choice — approval history is never rewritten.
export function resetFor(item, toIndex) {
  const rows = new Set(stepsFor(itemKindOf(item)).map((step) => step.index))
  const clears = (gate) => rows.has(gate) && toIndex <= gate
  return {
    clearReview: itemKindOf(item) === IMPLEMENT_ITEM_KIND && clears(IMPLEMENT_STEP_INDEX),
    clearPlanHash: clears(APPROVE_RUN_GATE_INDEX),
    clearGolden: GOLDEN_GATE_INDEXES.some(clears),
    clearFiling: clears(APPROVE_FILE_GATE_INDEX),
    releaseHolds: true,
    clearMerged: false,
  }
}

// HZ-185: the latest automated review failed and sent the item back to
// implement with its findings (store.js reviewRejected reads the same row).
function reviewFailed(item) {
  return item.cursor === IMPLEMENT_STEP_INDEX && item.fix_findings_json != null
}

// Pure. Either { ok, action, fromKey, toKey, toIndex, substepId, reset,
// needsHumanProof } or { error, hint? }. Refusals:
//   bad_action      not one of MOVE_ACTIONS
//   abandoned       the item is abandoned
//   closed          the item is closed (every action but reopen)
//   not_closed      reopen on an open item
//   bad_target_key  no such step in the item's kind, or not the step the
//                   action goes to
//   not_earlier     a return to the current step or a later one
//   lane_skipped    a return to a row the item's lane skips
//   merged          a return before Accept the code after the PR merged
//   not_at_gate     approve away from a gate
//   at_gate         retry at a gate, which has nothing to redo
export function planMove(item, { action, toKey = null, substepId = null } = {}) {
  if (!MOVE_ACTIONS.includes(action)) return { error: 'bad_action' }
  if (isAbandoned(item)) return { error: 'abandoned' }
  const kind = itemKindOf(item)
  const fromKey = moveKeyOf(item)
  const done = (toIndex, reset, extra = {}) => ({
    ok: true,
    action,
    fromKey,
    toKey: toIndex >= endIndex(kind) ? CLOSED_KEY : stepKeyAt(toIndex),
    toIndex,
    substepId: null,
    reset,
    needsHumanProof: false,
    ...extra,
  })

  if (action === 'reopen') {
    if (!isClosed(item)) return { error: 'not_closed' }
    const first = firstStepIndex(kind)
    return done(first, { ...resetFor(item, first), clearMerged: true })
  }
  if (isClosed(item)) return { error: 'closed' }

  const atGate = STEPS[item.cursor].kind === 'gate'
  if (action === 'abandon') return done(item.cursor, NO_RESET)
  if (action === 'close') return done(endIndex(kind), NO_RESET)
  if (action === 'retry') {
    if (atGate) return { error: 'at_gate' }
    if (toKey != null && toKey !== fromKey) return { error: 'bad_target_key' }
    // A retry redoes the step it is on, sub-step included.
    return done(item.cursor, resetFor(item, item.cursor), { substepId: item.substep_cursor ?? null })
  }
  if (action === 'approve') {
    // "Accept despite review findings" (HZ-185): the one approve that is not
    // from a gate. The review step finished with a failing verdict, and the
    // item lands on Accept the code — still a gate, so nothing merges until
    // a human accepts there. Only from where a failing review leaves it.
    if (!atGate) {
      if (toKey === stepKeyAt(ACCEPT_GATE_INDEX) && reviewFailed(item)) return done(ACCEPT_GATE_INDEX, NO_RESET)
      return { error: 'not_at_gate' }
    }
    const next = nextCursor(item)
    const plan = done(next, NO_RESET, { needsHumanProof: isHumanOnlyGate(item.cursor) })
    if (toKey != null && toKey !== plan.toKey) return { error: 'bad_target_key' }
    return plan
  }

  // return
  const toIndex = stepIndexOf(toKey)
  if (toIndex === null || !stepsFor(kind).some((step) => step.index === toIndex)) return { error: 'bad_target_key' }
  if (toIndex >= item.cursor) return { error: 'not_earlier' }
  if (laneSkips(item).has(toIndex)) return { error: 'lane_skipped' }
  const floor = mergedFloor(item)
  if (floor !== null && toIndex < floor) return { error: 'merged', hint: MERGED_HINT }
  return done(toIndex, resetFor(item, toIndex), { substepId: substepId ?? null })
}

// The step keys a return may go to from where the item is now.
export function allowedTargets(item) {
  if (isAbandoned(item) || isClosed(item)) return []
  return stepsFor(itemKindOf(item))
    .filter((step) => !planMove(item, { action: 'return', toKey: step.key }).error)
    .map((step) => step.key)
}

// HZ-799: every step the item may be moved to now — item.moves.targets — so a
// client shows step actions without working out any move rule itself. Built
// only from planMove and the send-back rules (allowedTargets, the gate's
// default, the sub-steps a gate offers): no rule of its own. Pure.
//   running     the item has a live run, which a retry or return stops
//   enabled     its project takes human actions (store.js disabledProject)
//   approvable  the gate's approve has what approveGate checks besides the
//               step: a run plan, approved golden cases
// Each target also carries `action` and `toIndex`, which only the route
// dispatches on; toPublicTarget drops them.
export function moveTargets(item, { running = false, enabled = true, approvable = true } = {}) {
  if (!enabled || isAbandoned(item) || isClosed(item)) return []
  const atGate = STEPS[item.cursor].kind === 'gate'
  const targets = []
  const add = (action, toIndex, stepKey, { isDefault = false, label = null } = {}) =>
    targets.push({
      stepKey,
      isDefault,
      redo: redoLine(item, action, toIndex, label),
      reapprovals: action === 'return' ? reapprovalKeys(item, toIndex) : [],
      // Approving a gate stops nothing; a retry, a return and the forward to
      // Accept the code each stop the live run first.
      stopsRunning: running && !(action === 'approve' && atGate),
      action,
      toIndex,
    })

  if (atGate) {
    const approve = planMove(item, { action: 'approve' })
    if (approve.ok && approvable) add('approve', approve.toIndex, approve.toKey)
    const fallback = defaultReworkTarget(item.cursor, itemKindOf(item), item)
    for (const key of allowedTargets(item)) add('return', stepIndexOf(key), key, { isDefault: stepIndexOf(key) === fallback })
    for (const sub of substepReworkTargets(item)) {
      const anchorKey = stepKeyAt(sub.index)
      if (planMove(item, { action: 'return', toKey: anchorKey, substepId: sub.substepId }).error) continue
      add('return', sub.index, encodeMoveKey(anchorKey, sub.substepId), { label: sub.label })
    }
    return targets
  }

  const retry = planMove(item, { action: 'retry' })
  if (retry.ok) {
    const sub = currentSubstep(item)
    add('retry', item.cursor, encodeMoveKey(retry.fromKey, sub?.id ?? null), { isDefault: true, label: sub?.label ?? null })
  }
  // "Accept despite review findings" (HZ-185): offered only where planMove allows it.
  const forward = planMove(item, { action: 'approve', toKey: stepKeyAt(ACCEPT_GATE_INDEX) })
  if (forward.ok) add('approve', forward.toIndex, forward.toKey)
  for (const key of allowedTargets(item)) add('return', stepIndexOf(key), key)
  return targets
}

// A target as item.moves serves it: without the route's own fields.
export function toPublicTarget({ action, toIndex, ...target }) {
  return target
}

// HZ-711: item.moves as served — the targets, and beside them what the item
// page, board cards and the Approvals drawer need to name each one without
// working out a rule or holding a step table:
//   actions     each target's stepKey → 'approve', 'return' or 'retry'
//   labels      each return or retry target's key, each reapproval and the
//               gate an approve passes → its label; a sub-step's is its own
//   approveKey  the gate the item waits at, when it can be approved — even
//               while the stepKey form cannot approve it (no run plan, golden
//               cases unseen): the Approve those surfaces send carries what
//               approveGate checks
//   canAbandon  the item is open
//   amendKey    the target Amend the rule moves to while a rule blocks the
//               item: back to implement where that is listed, else the retry
// Pure.
export function movesView(item, targets, { enabled = true } = {}) {
  const open = !isAbandoned(item) && !isClosed(item)
  const approve = enabled && open && STEPS[item.cursor].kind === 'gate' ? planMove(item, { action: 'approve' }) : null
  const approveKey = approve?.ok ? stepKeyAt(item.cursor) : null
  const implementKey = stepKeyAt(IMPLEMENT_STEP_INDEX)
  let amendKey = null
  if (item.rule_block_json) {
    const back = targets.find((t) => t.action === 'return' && t.stepKey === implementKey)
    amendKey = (back ?? targets.find((t) => t.action === 'retry'))?.stepKey ?? null
  }
  // An approve target's stepKey is where it lands (past the end, when it
  // closes the item), so the gate it passes is named instead.
  const named = [
    ...targets.flatMap((t) => (t.action === 'approve' ? [] : [t.stepKey, ...t.reapprovals])),
    ...(approveKey ? [approveKey] : []),
  ]
  return {
    targets: targets.map(toPublicTarget),
    actions: Object.fromEntries(targets.map((t) => [t.stepKey, t.action])),
    labels: Object.fromEntries(named.map((key) => [key, moveKeyLabel(item, key)])),
    approveKey,
    canAbandon: open,
    amendKey,
  }
}

function moveKeyLabel(item, key) {
  const { stepKey, substepId } = decodeMoveKey(key)
  const sub = substepId ? substepsOf(item).find((s) => s.id === substepId) : null
  return sub?.label ?? STEPS[stepIndexOf(stepKey)].label
}

const quoted = (index, label = null) => `“${label ?? STEPS[index].label}”`

// The rows the item's lane runs.
function laneRows(item) {
  const skips = laneSkips(item)
  return stepsFor(itemKindOf(item)).filter((step) => !skips.has(step.index))
}

// One line on what the move redoes, or approves.
function redoLine(item, action, toIndex, label) {
  if (action === 'approve') {
    const what =
      STEPS[item.cursor].kind === 'gate' ? `Approves ${quoted(item.cursor)}` : 'Accepts the code despite the review findings'
    return toIndex >= endIndex(itemKindOf(item)) ? `${what} and closes the item` : `${what} and moves on to ${quoted(toIndex)}`
  }
  const later = laneRows(item).filter((step) => step.index > toIndex && step.index <= item.cursor).length
  const tail = later ? ` and ${later} later step${later === 1 ? '' : 's'}` : ''
  return `Redoes ${quoted(toIndex, label)}${tail}`
}

// The gates a return to `toIndex` crosses again, each to be approved again —
// the rows resetFor treats as redone: at or after the target, before here.
function reapprovalKeys(item, toIndex) {
  return laneRows(item)
    .filter((step) => step.kind === 'gate' && step.index >= toIndex && step.index < item.cursor)
    .map((step) => step.key)
}

// HO-843: what a plan-hash reset clears beside approved_plan_hash.
export const COMMAND_APPROVAL_COLUMNS = Object.freeze(['approved_command_hashes_json', 'approved_frame_hash', 'command_patch_json'])

const selectRow = db.prepare('SELECT * FROM work_item WHERE id = ?')
const insertMove = db.prepare('INSERT INTO item_move (item_id, who, from_key, to_key, action, note) VALUES (?, ?, ?, ?, ?, ?)')

function badField(fields) {
  return Object.keys(fields).find((key) => !MOVE_FIELDS.has(key)) ?? null
}

// One move, in one transaction (a savepoint when the caller is already in
// one, so the caller's failure rolls this back too). `proof` is app.js's
// human proof: a humanOnly gate is not approved without it, and only a move
// with it releases a rule block (HZ-346) — any other move releases the pause
// alone. `fields` are extra columns from MOVE_FIELDS, written with the step.
// Returns { ok, move } or a planMove refusal, plus not_found, bad_field and
// human_pin_required.
//
// HO-843: a reset that clears the approved plan hash clears the per-command
// approval and any owner patch in flight with it. `keepCommandHashes` is the
// one exception, passed only by store.js patchRunPlan: its return to Run plan
// writes those three columns itself (in `fields`), so a one-command patch
// keeps every other command's approval. Any other caller clears them all.
export function moveItem(
  id,
  { action, toKey = null, substepId = null, who, note = '', proof = null, fields = {}, keepCommandHashes = false } = {},
) {
  return db.transaction(() => {
    const item = selectRow.get(id)
    if (!item) return { error: 'not_found' }
    const field = badField(fields)
    if (field) return { error: 'bad_field', field }
    const plan = planMove(item, { action, toKey, substepId })
    if (plan.error) return plan
    if (plan.needsHumanProof && !isHumanProof(proof)) return { error: 'human_pin_required' }

    const sets = ['cursor = ?']
    const values = [plan.toIndex]
    if (plan.reset.releaseHolds) {
      sets.push('substep_cursor = ?', 'paused = 0')
      values.push(plan.substepId)
      if (isHumanProof(proof)) sets.push('rule_block_json = NULL')
    }
    if (plan.reset.clearReview) sets.push(...REVIEW_STATE_COLUMNS)
    if (plan.reset.clearPlanHash) {
      sets.push('approved_plan_hash = NULL', 'approved_runner = NULL')
      if (!keepCommandHashes) sets.push(...COMMAND_APPROVAL_COLUMNS.map((column) => `${column} = NULL`))
    }
    if (plan.reset.clearMerged) sets.push('merged_at = NULL')
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = ?`)
      values.push(value)
    }
    db.prepare(`UPDATE work_item SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values, id)
    if (plan.reset.clearGolden) clearGoldenCases(id)

    const text = String(note ?? '')
    const moveId = insertMove.run(id, who, plan.fromKey, plan.toKey, action, text).lastInsertRowid
    // HZ-820: abandon first — an abandon is never a close. A reopen never
    // reaches CLOSED_KEY, so it leaves these asks dismissed.
    if (action === 'abandon') dismissSoftAsksForParent(id, PARENT_ABANDONED_REASON)
    else if (plan.toKey === CLOSED_KEY) dismissSoftAsksForParent(id, PARENT_CLOSED_REASON)
    return {
      ok: true,
      move: { id: Number(moveId), itemId: id, who, fromKey: plan.fromKey, toKey: plan.toKey, action, note: text },
      toIndex: plan.toIndex,
    }
  })()
}

// Step completion: the item leaves the step it just finished. Not a move, so
// no item_move row and no reset. Limited to where a finished step can go —
// its next row; past a lane's checked rows from the first of them (HZ-435);
// or one of the automated outcomes above — so it is never a second,
// unchecked mover. Returns { ok } or { error: 'bad_completion' | 'bad_field'
// | 'not_found' } and writes nothing on a refusal.
export function writeStepCompletion(id, toIndex, fields = {}) {
  const item = selectRow.get(id)
  if (!item) return { error: 'not_found' }
  const field = badField(fields)
  if (field) return { error: 'bad_field', field }
  if (!completionAllowed(item, toIndex)) {
    console.warn(`step completion refused: ${id} from ${moveKeyOf(item)} to position ${toIndex}`)
    return { error: 'bad_completion' }
  }
  const sets = ['cursor = ?']
  const values = [toIndex]
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`)
    values.push(value)
  }
  db.prepare(`UPDATE work_item SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values, id)
  return { ok: true }
}

function completionAllowed(item, toIndex) {
  if (isAbandoned(item) || isClosed(item)) return false
  if (toIndex === nextCursor(item)) return true
  const checked = laneCheckIndexes(item)
  if (checked.has(item.cursor) && toIndex === nextCursor({ ...item, cursor: Math.max(...checked) })) return true
  return AUTOMATED_OUTCOMES.get(item.cursor)?.has(toIndex) === true
}
