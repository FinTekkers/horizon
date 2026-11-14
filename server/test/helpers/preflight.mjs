// HO-837: a finished Preflight run for an item's current run plan, as the
// farm (or the demo mock) leaves one — so a test that approves Approve the
// run gets past the preflight bind. `passed: false` with `unmet` seeds a
// blocked one; `planHash` / `runner` seed a stale one. HO-839: a passing one
// carries a clean rehearsal unless `rehearsal` says otherwise (null: none).
import { PREFLIGHT_STEP_INDEX } from '../../../domain/js/lifecycle.js'

export const CLEAN_REHEARSAL = { clean: true, reason: null, scope: 'full', seconds: 4, failures: [] }

export function seedPreflight(db, store, id, { passed = true, unmet = [], planHash, runner, runUser = 'ubuntu', rehearsal } = {}) {
  const plan = store.currentRunPlan(id)
  const rehearsed = rehearsal === undefined ? (passed ? CLEAN_REHEARSAL : null) : rehearsal
  return db
    .prepare(
      "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, plan_hash, preflight_json, rehearsal_json, ended_at) VALUES (?, ?, 1, 'DevOps', 'done', 'preflight', ?, ?, ?, datetime('now'))",
    )
    .run(
      id,
      PREFLIGHT_STEP_INDEX,
      planHash === undefined ? (plan?.hash ?? null) : planHash,
      JSON.stringify({ passed, runner: runner === undefined ? (plan?.runner ?? null) : runner, run_user: runUser, unmet }),
      rehearsed ? JSON.stringify(rehearsed) : null,
    ).lastInsertRowid
}

// HO-838: Execute's dispatch re-check calls farmd POST /preflight before
// /steps/run. A test whose fake farm is not about the re-check answers it
// with this clean pass, so its Execute dispatch goes ahead as before.
// Returns null for any other URL.
export function preflightPass(url) {
  return new URL(String(url)).pathname === '/preflight'
    ? { ok: true, status: 200, json: async () => ({ ok: true, failed: [], unmet: [], deferred: [], elapsed_ms: 0 }) }
    : null
}
