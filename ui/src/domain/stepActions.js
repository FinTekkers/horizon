// HZ-711: the one place the UI reads an item's `moves` — the server's list of
// what a person may do from where the item is (server/src/moveOptions.js).
// The item page, board cards and the Approvals drawer all ask here, so they
// offer the same actions. Nothing here works out a move rule or a step order:
// a step the snapshot does not list is not offered.

export const ACTION_LABELS = Object.freeze({
  approve: 'Approve',
  return: 'Return to…',
  retry: 'Retry',
  abandon: 'Abandon',
})

// What a click on a step in the item's step list offers.
export const STEP_HINTS = Object.freeze({
  approve: 'Approve',
  return: 'Return here',
  retry: 'Retry',
})

const NO_MOVES = Object.freeze({ approve: null, targets: [], canAbandon: false, amend: null })

function movesOf(item) {
  const moves = item?.moves
  if (!moves || typeof moves !== 'object') return NO_MOVES
  return {
    approve: moves.approve ?? null,
    targets: Array.isArray(moves.targets) ? moves.targets : [],
    canAbandon: moves.canAbandon === true,
    amend: moves.amend ?? null,
  }
}

// The return targets, in the snapshot's order.
export function returnTargets(item) {
  return movesOf(item).targets.filter((t) => t.action === 'return')
}

// The current step's retry, or null.
export function retryTarget(item) {
  return movesOf(item).targets.find((t) => t.action === 'retry') ?? null
}

// The target a move of `action` to `key` goes to, or null when the snapshot
// does not offer it.
export function targetFor(item, action, key) {
  return movesOf(item).targets.find((t) => t.action === action && t.key === key) ?? null
}

// The gate the item waits at ({ key, label }), or null.
export function approveTarget(item) {
  return movesOf(item).approve
}

// The move Amend the rule makes ({ action, key }), or null.
export function amendMove(item) {
  return movesOf(item).amend
}

// The menu's actions, in its order: [{ id, label }]. Approve only at a gate,
// Return to… with at least one target, Retry when the step can run again,
// Abandon while the item is open.
export function menuActions(item) {
  const moves = movesOf(item)
  const actions = []
  if (moves.approve) actions.push({ id: 'approve', label: ACTION_LABELS.approve })
  if (returnTargets(item).length) actions.push({ id: 'return', label: ACTION_LABELS.return })
  const retry = retryTarget(item)
  if (retry) actions.push({ id: 'retry', label: ACTION_LABELS.retry, key: retry.key })
  if (moves.canAbandon) actions.push({ id: 'abandon', label: ACTION_LABELS.abandon })
  return actions
}

// What clicking the step `key` in the step list does: 'approve', 'return',
// 'retry' or null (it is only selected).
export function stepActionFor(item, key) {
  const moves = movesOf(item)
  if (moves.approve?.key === key) return 'approve'
  const target = moves.targets.find((t) => t.key === key)
  return target ? target.action : null
}
