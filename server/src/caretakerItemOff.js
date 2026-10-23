// HZ-544: is Autopilot off for this one item (its `autopilot-off` label, as
// last synced)? The one act-time check caretakerActor.js, caretakerAccept.js
// and caretakerRuling.js make right before they act, beside their re-read of
// the project's mode — so a label that lands after an 'on' evaluation still
// stops the action. Its own module because caretakerAccept.js may not import
// caretakerActor.js; it reads the DB and nothing else.
//
// caretaker.js records such an item's evaluations as 'shadow' (item_off = 1)
// in an 'on' project; this check is the belt-and-braces half for anything
// evaluated before the label landed.

import { db } from './db.js'

const selectItemOff = db.prepare('SELECT autopilot_off FROM work_item WHERE id = ?')

export function itemAutopilotOff(itemId) {
  return selectItemOff.get(itemId)?.autopilot_off === 1
}
