// HZ-105: proves the required-input gate (orchestrator.js's
// missingRequiredInputs, wired into dispatchToFarm) does not fire on any
// real dispatch on record, now that HZ-104's budget-allocation fix is live.
// Re-run any time after changing STEPS[*].requires or the artifact budget —
// this is the re-runnable check the item's success metric demands; a
// one-off manual claim is not acceptable (see the QA review this item's
// plan went through).
//
// For every historical step_run at a `requires`-gated step index, this
// reconstructs the exact artifact rows dispatchToFarm would have assembled
// at the moment that run was dispatched (every 'done' row with a smaller
// id, latest attempt per step_index — same query dispatchToFarm uses,
// bounded to "before this run existed" so later, unrelated history can't
// leak in), runs it through the real budgetArtifacts + missingRequiredInputs,
// and reports any dispatch the gate would have blocked.
//
// Usage:
//   node scripts/check-required-input-gate.mjs
//   HORIZON_DB=/path/to/horizon.db node scripts/check-required-input-gate.mjs
// Defaults to the same DB db.js opens with no HORIZON_DB set. Read-only:
// issues only SELECT statements. Against a live server's DB file, take a
// consistent snapshot first (WAL mode means a plain file copy can miss
// unflushed pages):
//   sqlite3 /path/to/horizon.db ".backup /tmp/horizon-check.db"
//   HORIZON_DB=/tmp/horizon-check.db node scripts/check-required-input-gate.mjs

import { db } from '../src/db.js'
import { STEPS, IMPLEMENT_STEP_INDEX } from '../../domain/js/lifecycle.js'
import { budgetArtifacts, missingRequiredInputs } from '../src/orchestrator.js'

const gatedSteps = STEPS.map((step, index) => ({ ...step, index })).filter((step) => step.requires?.length)

if (gatedSteps.length === 0) {
  console.log('no step in STEPS declares `requires` — nothing for this gate to check.')
  process.exit(0)
}

function rowsBefore(itemId, beforeRunId) {
  return db
    .prepare(
      `SELECT step_index, artifact, output FROM step_run
       WHERE item_id = ? AND id < ? AND status = 'done' AND (artifact IS NOT NULL OR step_index = ?)
         AND id IN (
           SELECT MAX(id) FROM step_run
           WHERE item_id = ? AND id < ? AND status = 'done' AND (artifact IS NOT NULL OR step_index = ?)
           GROUP BY step_index
         )
       ORDER BY id`,
    )
    .all(itemId, beforeRunId, IMPLEMENT_STEP_INDEX, itemId, beforeRunId, IMPLEMENT_STEP_INDEX)
    .map((row) => ({ step_index: row.step_index, artifact: row.artifact ?? row.output ?? '' }))
}

let checked = 0
const fired = []

for (const step of gatedSteps) {
  const runs = db.prepare('SELECT id, item_id FROM step_run WHERE step_index = ? ORDER BY id').all(step.index)
  for (const run of runs) {
    checked++
    const rows = rowsBefore(run.item_id, run.id)
    const budgeted = budgetArtifacts(rows)
    const missing = missingRequiredInputs(step, rows, budgeted, step.itemKind ?? 'change')
    if (missing.length > 0) fired.push({ item: run.item_id, step: step.label, runId: run.id, missing })
  }
}

console.log(`checked ${checked} historical dispatch(es) across: ${gatedSteps.map((s) => s.label).join(', ')}`)

if (fired.length === 0) {
  console.log('the required-input gate would not have fired on any real dispatch on record.')
  process.exit(0)
}

console.log(`the gate WOULD have fired on ${fired.length} real dispatch(es):`)
for (const f of fired) {
  console.log(`  item ${f.item} @ "${f.step}" (step_run ${f.runId})`)
  for (const m of f.missing) {
    console.log(
      `    "${m.label}" needed ${m.fullLen} chars, only ${m.gotLen} could be supplied (${m.fullLen - m.gotLen} short)`,
    )
  }
}
process.exitCode = 1
