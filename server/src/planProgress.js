// HZ-547: each Plan's (and Task's) filed items, summed for the board — the
// "From Plan VS-110 · 6 of 13 done" pill, the board's Plan filter and the
// Plans view all read these numbers, so the UI does no aggregation. Pure — no
// I/O; app.js's snapshot() is the only caller.
//
// The parent → child link is item_spawn's `filed` rows, already on every item
// view as `spawnedBy` (store.js spawnFields). The children are the snapshot's
// own items, so one in a project outside the board's scope is not counted.
//
// The array is sorted (Stalled, In progress, Complete, then id), so unchanged
// data gives identical JSON and streamDelta.js re-sends it only on a change.

import { STEPS, awaitingGate, gateStepIndexes, isAbandoned, isClosed, itemKindOf } from '../../domain/js/lifecycle.js'

export const PLAN_STATUSES = ['stalled', 'inProgress', 'complete']

// One bucket per child, first match wins. Abandoned comes before done:
// isClosed reads only the cursor, and an abandoned item is never "done".
// A failed step pauses the item (failFarmRun), so `paused` covers "failed".
// Changes requested (`rejected`) is not stalled — an agent is on it again.
export function childBucket(item) {
  if (isAbandoned(item)) return 'abandoned'
  if (isClosed(item)) return 'done'
  if (item.paused || item.ruleBlock) return 'stalled'
  if (awaitingGate(item)) return 'waiting'
  return 'inProgress'
}

// The 1-based position of the item's current gate among its kind's gates —
// the "gate 3" of "5 waiting for you at gate 3".
function gateNumber(item) {
  return gateStepIndexes(STEPS, itemKindOf(item)).indexOf(item.cursor) + 1
}

function statusOf(counts) {
  if (counts.done + counts.abandoned === counts.total) return 'complete'
  if (counts.stalled > 0) return 'stalled'
  return 'inProgress'
}

// `items`: the snapshot's item views. `parents`: store.spawnParents(), every
// Plan or Task with a filed child, keyed by id. A parent with no child in
// `items` is left out. A parent that was itself abandoned still gets an entry
// on purpose: what it filed is still being delivered.
export function planProgress(items, parents) {
  const byParent = new Map()
  for (const item of items) {
    const parentId = item.spawnedBy?.id
    if (!parentId || !parents.has(parentId)) continue
    if (!byParent.has(parentId)) byParent.set(parentId, [])
    byParent.get(parentId).push(item)
  }
  const rows = []
  for (const [id, children] of byParent) {
    const parent = parents.get(id)
    const counts = { total: children.length, done: 0, abandoned: 0, inProgress: 0, stalled: 0, waiting: 0 }
    const gates = new Map()
    for (const child of children) {
      const bucket = childBucket(child)
      counts[bucket] += 1
      if (bucket === 'waiting') {
        const gate = gateNumber(child)
        gates.set(gate, (gates.get(gate) ?? 0) + 1)
      }
    }
    rows.push({
      id,
      kind: parent.kind,
      title: parent.title,
      closed: parent.closed,
      status: statusOf(counts),
      ...counts,
      waitingAtGate: [...gates].sort((a, b) => a[0] - b[0]).map(([gate, count]) => ({ gate, count })),
    })
  }
  const rank = (row) => PLAN_STATUSES.indexOf(row.status)
  return rows.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
