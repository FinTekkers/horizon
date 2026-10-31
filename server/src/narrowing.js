// HZ-685: an item may be narrowed to "Deferred to a follow-up item" only when
// that follow-up is filed and linked. narrowingStatus() is the one check:
// app.js's performGateApproval refuses a gate on it, and caretaker.js reads it
// as a fact so Autopilot pings the owner instead of approving.
//
// Read-only and GitHub-free on purpose: caretaker.js imports it, and that
// module imports nothing that can act (see its header). Filing lives in
// split.js, which imports the gates from here.

import { db } from './db.js'
import * as store from './store.js'
import { requiredStepIndex } from '../../domain/js/lifecycle.js'
import { hasDeferredLine } from '../../domain/js/fields.js'

export const DESIGN_GATE_INDEX = requiredStepIndex('Approve the high-level design')
export const EXECUTION_GATE_INDEX = requiredStepIndex('Review before execution')
// The gates whose approval files a proposed split, and the only gates the
// narrowing guard refuses at.
export const FILING_GATES = [DESIGN_GATE_INDEX, EXECUTION_GATE_INDEX]

export const UNFILED_NARROWING_REASON =
  'the outcome or metric defers work to a follow-up item, but no follow-up is filed and linked'

const selectSameRepoRows = db.prepare('SELECT * FROM item_split WHERE source_item_id = ? AND target_repo = ? COLLATE NOCASE ORDER BY id')

export function isNarrowed(item) {
  return hasDeferredLine(item?.desc) || hasDeferredLine(item?.metric)
}

// { ok: true } when the item is not narrowed, or its same-repo follow-up is
// filed and waits on it, or the follow-up is proposed and this gate's
// approval files it first. Otherwise { ok: false, reason }.
export function narrowingStatus(item) {
  if (!item || !isNarrowed(item)) return { ok: true }
  const rows = item.repo ? selectSameRepoRows.all(item.id, item.repo) : []
  const linked = rows.some(
    (r) => r.status === 'filed' && r.target_item_id && store.hasDependency(r.target_item_id, item.id),
  )
  if (linked) return { ok: true }
  if (FILING_GATES.includes(item.cursor) && rows.some((r) => r.status === 'proposed')) return { ok: true }
  return { ok: false, reason: UNFILED_NARROWING_REASON }
}
