// HO-837: a finished Preflight run for an item's current run plan, as the
// farm (or the demo mock) leaves one — so a test that approves Approve the
// run gets past the preflight bind. `passed: false` with `unmet` seeds a
// blocked one; `planHash` / `runner` seed a stale one.
import { PREFLIGHT_STEP_INDEX } from '../../../domain/js/lifecycle.js'

export function seedPreflight(db, store, id, { passed = true, unmet = [], planHash, runner, runUser = 'ubuntu' } = {}) {
  const plan = store.currentRunPlan(id)
  return db
    .prepare(
      "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, plan_hash, preflight_json, ended_at) VALUES (?, ?, 1, 'DevOps', 'done', 'preflight', ?, ?, datetime('now'))",
    )
    .run(
      id,
      PREFLIGHT_STEP_INDEX,
      planHash === undefined ? (plan?.hash ?? null) : planHash,
      JSON.stringify({ passed, runner: runner === undefined ? (plan?.runner ?? null) : runner, run_user: runUser, unmet }),
    ).lastInsertRowid
}
