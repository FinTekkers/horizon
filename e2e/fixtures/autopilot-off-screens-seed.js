// HZ-544: the rows behind the `autopilot-off-*` screens in
// .horizon/screenshots.json — an item at Accept the code with Autopilot off
// (its `autopilot-off` label, as synced) in a project whose Autopilot is on.
// e2e/screenshots/seed.mjs seeds them before the server boots: the item sits
// at a gate, so nothing moves it.
//
// The caretaker's "would have accepted" evaluation is seeded too, with its
// event stamped LATER like the layout rows, so the boot sweep finds this
// arrival already judged and adds no row of its own — every capture shows
// the same text.

import { insertItem, insertProject, insertStepRun } from './seed.js'
import { ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'
import { LATER } from './layout-screens-seed.js'

export const AUTOPILOT_PROJECT = 'Autopilot project'
export const AUTOPILOT_OFF_ID = 'AP-364'
const REASON = 'automated review passed and the PR merges cleanly'

export function seedAutopilotOffScreens(db) {
  if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(AUTOPILOT_OFF_ID)) return
  db.transaction(() => {
    const project_id = insertProject(db, { name: AUTOPILOT_PROJECT })
    db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(project_id)
    insertItem(db, {
      id: AUTOPILOT_OFF_ID,
      title: 'Adjusted cost basis: measure spec, AmortisationElectionsProto, CostBasisInput',
      cursor: ACCEPT_GATE_INDEX,
      repo: 'FinTekkers/ledger-models',
      pr: 12,
      pr_url: 'https://github.com/FinTekkers/ledger-models/pull/12',
      pr_mergeable: 1,
      project_id,
    })
    db.prepare('UPDATE work_item SET issue = 364, autopilot_off = 1, created_at = ?, updated_at = ? WHERE id = ?').run(
      LATER,
      LATER,
      AUTOPILOT_OFF_ID,
    )
    const review = insertStepRun(db, {
      itemId: AUTOPILOT_OFF_ID,
      stepIndex: ACCEPT_GATE_INDEX - 1,
      attempt: 1,
      agent: 'Review',
      output: 'automated review passed',
      startedAt: LATER,
      endedAt: LATER,
    })
    const eventId = db
      .prepare("INSERT INTO event (item_id, who, text, color, initials, created_at) VALUES (?, 'Caretaker', ?, '#4A6B5D', 'CT', ?)")
      .run(AUTOPILOT_OFF_ID, `caretaker would approve — ${REASON} (Autopilot is off for this item)`, LATER).lastInsertRowid
    db.prepare(
      `INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, item_off, decision, rule_id, reason, event_id, created_at)
       VALUES (?, ?, ?, 'shadow', 1, 'approve', 'g13.approve', ?, ?, ?)`,
    ).run(AUTOPILOT_OFF_ID, ACCEPT_GATE_INDEX, review, REASON, eventId, LATER)
  })()
}
