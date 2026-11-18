// HO-880: whether an item was imported into another project, and so is read-
// only. The item_import ledger row (server/src/importProject.js) is the whole
// of the freeze: the source item's own row is never written, so nothing here
// changes it. Every Horizon write path a human, GitHub, the caretaker or the
// orchestrator can reach checks this — app.js's item-route hook, store.js's
// mutations and sync, moveItem.js, orchestrator dispatch, the caretaker, the
// gate notifier and WhatsApp poll votes. The source repo's tracker records
// (GitHub issues) are never touched: read-only is enforced in Horizon only.
//
// A leaf module: it imports only db, so any of those files can import it
// without a cycle.

import { db } from './db.js'

// The error every refused write answers with.
export const IMPORTED_ITEM_ERROR = 'item_imported'

const selectImported = db.prepare('SELECT 1 FROM item_import WHERE source_item_id = ?')

// True when `itemId` is a source item of an import, from the moment the
// import froze it (before any copy exists).
export function isImportedItem(itemId) {
  return typeof itemId === 'string' && selectImported.get(itemId) !== undefined
}

// SQL for "this work_item row is not a frozen source item", for queries that
// pick items to act on. `alias` is the work_item alias in the caller's query.
export function notImportedSql(alias) {
  return `NOT EXISTS (SELECT 1 FROM item_import ii WHERE ii.source_item_id = ${alias}.id)`
}
