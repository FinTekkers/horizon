// HZ-921: the rows behind the Effort & cost card's screens (`effort-cost-*` in
// .horizon/screenshots.json) and e2e/tests/78-effort-cost-card.spec.js:
// - EC-EARLY waits at "Accept the code", an earlier step: no card.
// - EC-FINAL waits at "Review the work & close": the card, with two implement
//   attempts of 40 and 25 recorded turns, a review run and one blocking ask
//   (dismissed since, so the page shows no ask to answer).
// - EC-CLOSED is closed, its runs from before turns were stored (num_turns
//   NULL) and with no clarification signal: "not recorded" and "No
//   clarification needed".
// The two open items are paused, so no mock agent moves them, and the closed
// one never moves: e2e/screenshots/seed.mjs seeds them before the server
// boots, and the spec into the suite's own DB. Every timestamp is fixed, so
// two captures draw the same text — except EC-FINAL's elapsed and queued time,
// which run to now (the screen masks them).

import { insertAsk, insertItem, insertStepRun } from './seed.js'
import { endIndex, stepIndexOf } from '../../domain/js/lifecycle.js'

export const EC_EARLY_ID = 'EC-EARLY'
export const EC_FINAL_ID = 'EC-FINAL'
export const EC_CLOSED_ID = 'EC-CLOSED'

// What the card shows for each, worked out from the rows below.
export const EC_FINAL_COST = '$2.50' // 1.25 + 0.75 implement, 0.50 review
export const EC_FINAL_IMPLEMENT_COST = '$2.00'
export const EC_FINAL_IMPLEMENT_TURNS = '65 turns' // 40 + 25
export const EC_CLOSED_COST = '$0.90' // 0.60 implement, 0.30 review

const IMPLEMENT = stepIndexOf('change.implement')
const REVIEW = stepIndexOf('change.auto-review')
const ACCEPT = stepIndexOf('change.accept-code')
const CLOSE_GATE = endIndex('change') - 1
const AT = (day, hour) => `2026-11-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:00:00`
const MODEL = 'claude-opus-5-5'

function run(db, itemId, stepIndex, attempt, { agent, start, end, input, output, cacheRead, cacheWrite, cost, turns }) {
  const id = insertStepRun(db, { itemId, stepIndex, attempt, agent, output: 'done', startedAt: start, endedAt: end })
  db.prepare(
    `UPDATE step_run SET model = ?, provider = 'claude', agent_run = 1, input_tokens = ?, output_tokens = ?,
       cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?, num_turns = ? WHERE id = ?`,
  ).run(MODEL, input, output, cacheRead, cacheWrite, cost, turns, id)
  return id
}

function item(db, { id, title, cursor, paused }) {
  insertItem(db, { id, title, cursor, paused, repo: 'FinTekkers/horizon' })
  db.prepare('UPDATE work_item SET created_at = ?, updated_at = ? WHERE id = ?').run(AT(10, 9), AT(12, 12), id)
}

export function seedEffortCost(db) {
  if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(EC_FINAL_ID)) return
  db.transaction(() => {
    item(db, { id: EC_EARLY_ID, title: 'Effort fixture — waiting at Accept the code', cursor: ACCEPT, paused: true })

    item(db, { id: EC_FINAL_ID, title: 'Effort fixture — waiting at Review the work & close', cursor: CLOSE_GATE, paused: true })
    const first = run(db, EC_FINAL_ID, IMPLEMENT, 1, {
      agent: 'Eng', start: AT(10, 10), end: AT(10, 11), input: 1200, output: 900, cacheRead: 50000, cacheWrite: 3000, cost: 1.25, turns: 40,
    })
    run(db, EC_FINAL_ID, IMPLEMENT, 2, {
      agent: 'Eng', start: AT(10, 12), end: AT(10, 13), input: 800, output: 600, cacheRead: 30000, cacheWrite: 2000, cost: 0.75, turns: 25,
    })
    run(db, EC_FINAL_ID, REVIEW, 1, {
      agent: 'QA', start: AT(10, 13), end: AT(10, 14), input: 400, output: 300, cacheRead: 10000, cacheWrite: 1000, cost: 0.5, turns: 12,
    })
    insertAsk(db, { itemId: EC_FINAL_ID, stepRunId: first, stepIndex: IMPLEMENT, kind: 'blocking', status: 'dismissed', title: 'Effort fixture ask', why: 'Fixture.' })

    item(db, { id: EC_CLOSED_ID, title: 'Effort fixture — closed before turns were stored', cursor: endIndex('change'), paused: false })
    run(db, EC_CLOSED_ID, IMPLEMENT, 1, {
      agent: 'Eng', start: AT(10, 10), end: AT(10, 12), input: 900, output: 700, cacheRead: 20000, cacheWrite: 1500, cost: 0.6, turns: null,
    })
    run(db, EC_CLOSED_ID, REVIEW, 1, {
      agent: 'QA', start: AT(10, 12), end: AT(10, 13), input: 300, output: 200, cacheRead: 5000, cacheWrite: 500, cost: 0.3, turns: null,
    })
    db.prepare("INSERT INTO gate_decision (item_id, step_index, decision, created_at) VALUES (?, ?, 'approved', ?)").run(
      EC_CLOSED_ID,
      CLOSE_GATE,
      AT(12, 12),
    )
  })()
}
