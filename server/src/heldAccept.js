// HZ-360: an Approve at Accept the code that waits out a Horizon deploy.
//
// While a self-deploy drains (deployDrain.js) nothing may start a pre-merge
// run, so performGateApproval used to answer a human's Approve with a 409 and
// the board kept offering a button that could not work. Now:
//
//   - a human Approve (browser, WhatsApp, poll vote — all performGateApproval)
//     is held: one held_accept row per item, in the DB because the restart
//     that ends a deploy is exactly when it has to merge;
//   - an Autopilot accept the caretaker decided on but skipped for the block
//     (caretakerAccept.js) is listed in memory: the caretaker decides again on
//     its first pass after the block, restart or not, so nothing is lost;
//   - snapshot() reads both into each item's `acceptWaiting`, and the board
//     shows "Queued to merge" instead of Approve.
//
// releaseHeldAccepts() runs once the block lifts — onDrainEnd (a failed
// deploy, DELETE, the TTL) and once at boot (the normal end, a restart). Each
// row is deleted in a transaction before its one gateActions.approve call, so
// two releases never both press it; the caretaker skips an item with a row
// (isHeld), and the premerge gate_action claim stays the last lock. A row whose
// item has moved on — another gate, another PR or another review result — is
// dropped with an event, never merged. Nothing here acts while blocked, and
// performGateApproval's own block check is the backstop.

import { db } from './db.js'
import * as store from './store.js'
import { deployBlock, isDeployBlocked, onDrainEnd } from './deployDrain.js'
import { STEPS } from '../../domain/js/lifecycle.js'

// The review result that fed the item's current gate, the same key
// caretakerAccept.js's selectCandidates judges an arrival by (kept as its own
// copy here so neither module imports the other).
const selectArrival = db.prepare(`
  SELECT COALESCE((SELECT MAX(s.id) FROM step_run s WHERE s.item_id = w.id
           AND s.step_index = w.cursor - 1 AND s.status = 'done'), 0) AS arrival_run_id
    FROM work_item w WHERE w.id = ?`)
const insertHold = db.prepare(
  'INSERT OR IGNORE INTO held_accept (item_id, step_index, arrival_run_id, pr, actor, notes) VALUES (?, ?, ?, ?, ?, ?)',
)
const selectHold = db.prepare('SELECT * FROM held_accept WHERE item_id = ?')
const selectHolds = db.prepare('SELECT * FROM held_accept ORDER BY held_at, item_id')
const deleteHold = db.prepare('DELETE FROM held_accept WHERE item_id = ?')

const EVENT = { who: 'Horizon', color: '#0E6E74', initials: 'HZ' }

// Item ids Autopilot would accept but for the block, replaced on every
// caretaker pass and cleared when the block lifts.
let autopilotWaiting = new Set()

// Called by performGateApproval (app.js) instead of the old 409, only while
// blocked and only at Accept the code with a PR. A second Approve keeps the
// first row; `actor` in the reply is that row's.
export function hold(item, stepIndex, notes, actor) {
  const arrival = selectArrival.get(item.id)?.arrival_run_id ?? 0
  if (insertHold.run(item.id, stepIndex, arrival, item.pr, actor, notes || '').changes === 1) {
    store.addEvent(item.id, {
      ...EVENT,
      text: `${actor} approved while Horizon deploys — PR #${item.pr} is queued to merge when the deploy ends`,
    })
    store.notifyChange()
  }
  return { ok: true, held: true, latestEnd: deployBlock()?.latestEnd ?? null, actor: selectHold.get(item.id)?.actor ?? actor }
}

export function isHeld(itemId) {
  return Boolean(selectHold.get(itemId))
}

// caretakerAccept.js, once per pass.
export function setAutopilotWaiting(ids) {
  const same = ids.size === autopilotWaiting.size && [...ids].every((id) => autopilotWaiting.has(id))
  autopilotWaiting = new Set(ids)
  if (!same) store.notifyChange()
}

// One read of held_accept per snapshot. Returns item => acceptWaiting:
// {source: 'human', actor, heldAt} (a human hold wins), {source: 'autopilot'}
// while blocked, or null.
export function acceptWaitingLookup() {
  const held = new Map(selectHolds.all().map((row) => [row.item_id, row]))
  const blocked = isDeployBlocked()
  return (item) => {
    const row = held.get(item.id)
    if (row && row.step_index === item.cursor) return { source: 'human', actor: row.actor, heldAt: row.held_at }
    if (blocked && autopilotWaiting.has(item.id)) return { source: 'autopilot' }
    return null
  }
}

// Why a held row no longer fits its item, or null when it still does.
function staleReason(row, item) {
  if (!item) return 'the item is gone'
  if (item.abandoned_at) return 'the item was abandoned'
  if (item.cursor !== row.step_index) return 'the item left the gate'
  if (item.pr !== row.pr) return `the PR is now #${item.pr ?? 'none'}`
  if ((selectArrival.get(item.id)?.arrival_run_id ?? 0) !== row.arrival_run_id) return 'a newer review reached the gate'
  return null
}

// Takes every row (one transaction each) and presses each current one's
// Approve once. Synchronous up to the approve calls, which claim their
// premerge row before their first await, so no caretaker pass interleaves.
// Never retries: a failed pre-merge or merge leaves the gate open, as a
// click does. Resolves {released, dropped}.
export async function releaseHeldAccepts({ gateActions, log } = {}) {
  const counts = { released: 0, dropped: 0 }
  if (isDeployBlocked()) return counts
  const pending = []
  for (const { item_id: itemId } of selectHolds.all()) {
    const taken = db.transaction(() => {
      const row = selectHold.get(itemId)
      if (!row || deleteHold.run(itemId).changes !== 1) return null
      return { row, stale: staleReason(row, store.getItem(itemId)) }
    })()
    if (!taken) continue
    const { row, stale } = taken
    if (stale) {
      counts.dropped++
      store.addEvent(itemId, { ...EVENT, text: `held Approve by ${row.actor} dropped: ${stale} — nothing merged` })
      log?.warn?.(`held Approve on ${itemId} dropped: ${stale}`)
      continue
    }
    counts.released++
    log?.info?.(`releasing the held Approve on ${itemId} (${STEPS[row.step_index]?.label})`)
    let call
    try {
      call = Promise.resolve(gateActions.approve(itemId, row.step_index, row.notes, row.actor))
    } catch (err) {
      call = Promise.reject(err)
    }
    pending.push(
      call.then(
        (result) => {
          if (result?.error) log?.warn?.(`held Approve on ${itemId} did not complete: ${result.error}`)
        },
        (err) => log?.error?.(`held Approve on ${itemId} failed: ${err?.message || err}`),
      ),
    )
  }
  if (counts.released || counts.dropped) store.notifyChange()
  await Promise.all(pending)
  return counts
}

// server.js, after orchestrator.init (whose drain-end callback runs first)
// and before caretakerActor.init. Returns the boot release, for the tests.
export function init(log, { gateActions } = {}) {
  if (!gateActions) throw new Error('heldAccept.init needs the gateActions app.js builds')
  const release = () =>
    releaseHeldAccepts({ gateActions, log }).catch((err) => {
      log?.error?.(`held Approve release failed: ${err?.message || err}`)
      return { released: 0, dropped: 0 }
    })
  onDrainEnd(() => {
    autopilotWaiting = new Set()
    release()
  })
  return release()
}
