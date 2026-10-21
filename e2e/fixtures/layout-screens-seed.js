// HZ-512: the rows behind the `layout-*` screens in .horizon/screenshots.json.
// They replace what the layout-only tests in 24-mobile-layout, 22-project-filter,
// 26-board-elapsed, 33-board-blocked and 19-api-tokens seeded for themselves:
// a long project badge, a board taller than a phone, an item with 25 activity
// rows, a long elapsed label and a Blocked card with its blocker link.
//
// e2e/screenshots/serve.sh seeds a throwaway DB with these, in two phases:
//   seedBeforeBoot — only rows the orchestrator never moves (gate and paused
//     items). Seeding before the server boots means its demo seed (which runs
//     only on an empty work_item table) never adds the moving BF-* items.
//   seedAfterBoot — rows at an agent step. The boot resume would kick them,
//     so like every e2e fixture they go in once the server is up, and are
//     never kicked after (see seed.js).
// 53-layout-screens.spec.js seeds both phases into the e2e DB.
//
// Every timestamp is LATER, a fixed time in the future, so two captures on
// the same commit are byte-identical: the board's elapsed line clamps to
// "<1m" and the activity rows read "just now", whenever the shot is taken.

import { insertItem, insertProject, insertDependency, insertStepRun } from './seed.js'
import { IMPLEMENT_STEP_INDEX, STEPS, endIndex } from '../../domain/js/lifecycle.js'

export const LATER = '2099-01-01 00:00:00'
export const PROJECT = 'Layout screens project with a deliberately long name'
export const GATE_ID = 'LS-GATE'
export const LOG_ID = 'LS-LOG'
export const LONG_ID = 'LS-LONG'
export const BLOCKER_ID = 'LS-BLOCKER'
export const BLOCKED_ID = 'LS-BLOCKED'
export const LAST_EVENT = 'layout screen event 25'
// The PM's summary step, as 26-board-elapsed uses: its elapsed name is one of
// the longest, so the line is the hardest to keep on one row.
const SUMMARY_INDEX = IMPLEMENT_STEP_INDEX - 2
const INTAKE_GATE = 3

function projectId(db) {
  return db.prepare('SELECT id FROM project WHERE name = ?').get(PROJECT)?.id
}

function stampLater(db, id) {
  db.prepare('UPDATE work_item SET created_at = ?, updated_at = ? WHERE id = ?').run(LATER, LATER, id)
}

function event(db, itemId, text) {
  db.prepare(
    "INSERT INTO event (item_id, who, text, color, initials, created_at) VALUES (?, 'Horizon', ?, '#2E6CB2', 'HZ', ?)",
  ).run(itemId, text, LATER)
}

export function seedBeforeBoot(db) {
  if (STEPS[INTAKE_GATE].kind !== 'gate' || STEPS[SUMMARY_INDEX].kind !== 'agent') {
    throw new Error('layout-screens-seed: fixture step indexes no longer point at a gate and an agent step')
  }
  // Re-runs (a retried spec worker) seed once.
  if (projectId(db)) return
  db.transaction(() => {
    const project_id = insertProject(db, { name: PROJECT })
    // At a gate, so the pending count is non-zero and nothing runs it.
    insertItem(db, { id: GATE_ID, title: 'Layout fixture — awaiting intake, with a project badge', cursor: INTAKE_GATE, project_id })
    // Enough cards that the board is taller than a phone screen.
    for (let n = 1; n <= 6; n++) {
      insertItem(db, { id: `LS-${n}`, title: `Layout fixture — filler ${n}`, cursor: 0, paused: 1, project_id })
    }
    // Enough activity that the item page scrolls past the bottom nav. Closed,
    // so no step icon pulses (auraPulse) and every capture is the same.
    insertItem(db, { id: LOG_ID, title: 'Layout fixture — long activity log', cursor: endIndex('change'), project_id })
    for (let n = 1; n <= 25; n++) event(db, LOG_ID, `layout screen event ${n}`)
    // Open, at a gate: it blocks LS-BLOCKED (seeded after boot) without moving.
    insertItem(db, { id: BLOCKER_ID, title: 'Layout fixture — open blocker', cursor: INTAKE_GATE, project_id })
    for (const id of [GATE_ID, LOG_ID, BLOCKER_ID, ...[1, 2, 3, 4, 5, 6].map((n) => `LS-${n}`)]) stampLater(db, id)
  })()
}

export function seedAfterBoot(db) {
  if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(LONG_ID)) return
  const project_id = projectId(db)
  if (!project_id) throw new Error('layout-screens-seed: seedBeforeBoot must run first')
  db.transaction(() => {
    insertItem(db, { id: LONG_ID, title: 'Layout fixture — long elapsed label', cursor: SUMMARY_INDEX, project_id })
    insertStepRun(db, { itemId: LONG_ID, stepIndex: SUMMARY_INDEX, attempt: 1, agent: 'PM', status: 'active', startedAt: LATER })
    // HZ-467: a change item is held only from implement on, so it reads Blocked.
    insertItem(db, { id: BLOCKED_ID, title: 'Layout fixture — blocked, with its blocker link', cursor: IMPLEMENT_STEP_INDEX, project_id })
    insertDependency(db, { itemId: BLOCKED_ID, dependsOnId: BLOCKER_ID })
    for (const id of [LONG_ID, BLOCKED_ID]) stampLater(db, id)
  })()
}

export function seedLayoutScreens(db) {
  seedBeforeBoot(db)
  seedAfterBoot(db)
}
