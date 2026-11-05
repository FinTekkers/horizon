// HZ-711: what the item snapshot offers as moves, so no client works out a
// move rule or a step order. Built on planMove and allowedTargets, the same
// checks POST /api/items/:id/move makes. Pure — no database.
import { allowedTargets, planMove } from './moveItem.js'
import {
  IMPLEMENT_STEP_INDEX,
  STEPS,
  defaultReworkTarget,
  isAbandoned,
  isClosed,
  itemKindOf,
  laneSkips,
  stepIndexOf,
  stepKeyAt,
  stepsFor,
} from '../../domain/js/lifecycle.js'

// HZ-711: one line on what a move to `rows` (the target through the current
// step, lane-skipped rows left out) runs again.
function redoLine(rows) {
  if (rows.length === 1) return `Runs “${rows[0].label}” again.`
  return `Redoes ${rows.length} steps, from “${rows[0].label}” to “${rows[rows.length - 1].label}”.`
}

// HZ-711: every move a person may make from where the item is now, for the
// item snapshot — the item page, board cards and the Approvals drawer list
// these and work out no move rule or step order of their own. Pure.
//   approve     { key, label } of the gate the item waits at, else null
//   targets     each return target (in step order), then the retry of the
//               current step: { key, label, action, isDefault, redo,
//               reapprovals, stopsRunning }. `isDefault` marks the one return
//               a gate's "Return to…" preselects: its declared send-back
//               target, else the nearest allowed one.
//   canAbandon  the item is open
//   amend       the move Amend the rule makes ({ action, key }), only while a
//               rule blocks the item: back to implement where that is
//               allowed, else a retry of the blocked step
// `running`: a run is in flight, which a return or retry stops.
export function moveOptions(item, { running = false } = {}) {
  if (isAbandoned(item) || isClosed(item)) return { approve: null, targets: [], canAbandon: false, amend: null }
  const kind = itemKindOf(item)
  const skips = laneSkips(item)
  const rows = stepsFor(kind).filter((step) => !skips.has(step.index))
  const current = STEPS[item.cursor]
  const atGate = current.kind === 'gate'
  const option = (step, action) => {
    const redone = rows.filter((row) => row.index >= step.index && row.index <= item.cursor)
    return {
      key: step.key,
      label: step.label,
      action,
      isDefault: false,
      redo: redoLine(redone.length ? redone : [step]),
      reapprovals: redone.filter((row) => row.kind === 'gate' && row.index < item.cursor).map((row) => row.label),
      stopsRunning: running,
    }
  }
  const returns = allowedTargets(item).map((key) => option({ ...STEPS[stepIndexOf(key)], index: stepIndexOf(key) }, 'return'))
  if (returns.length) {
    const declared = atGate ? stepKeyAt(defaultReworkTarget(item.cursor, kind, item)) : null
    const chosen = returns.find((target) => target.key === declared) ?? returns[returns.length - 1]
    chosen.isDefault = true
  }
  const retry = planMove(item, { action: 'retry' }).error ? [] : [option({ ...current, index: item.cursor }, 'retry')]
  let amend = null
  if (item.rule_block_json) {
    const implementKey = stepKeyAt(IMPLEMENT_STEP_INDEX)
    if (returns.some((target) => target.key === implementKey)) amend = { action: 'return', key: implementKey }
    else if (retry.length) amend = { action: 'retry', key: current.key }
  }
  return {
    approve: atGate ? { key: current.key, label: current.label } : null,
    targets: [...returns, ...retry],
    canAbandon: true,
    amend,
  }
}
