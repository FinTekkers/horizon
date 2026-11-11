// HO-841: a Task's Verify & report outcome and, when Execute failed, why.
//
// Verify has its own value set. Review and Deploy keep the shared pass/fail
// VERDICT_VALUES in orchestrator.js, which this never widens. The coarse
// step_run.verdict column stays pass/fail; step_run.verify_outcome holds the
// three-way outcome and step_run.execute_cause the cause (db.js). A row from
// before HO-841 has no outcome: readVerifyOutcome reads its `fail` as
// `work_failed` without rewriting it.
//
// Pure functions, no DB: store.js and productivity.js use them without
// importing orchestrator.js.

export const VERIFY_VERDICT_VALUES = new Set(['pass', 'work_failed', 'done_proof_incomplete'])
export const EXECUTE_CAUSES = new Set(['prereq', 'unforeseeable'])

// Whether Execute's recorded job failed, from its stored view only — Verify
// never re-runs a command to find out. null when no view was recorded (a run
// refused before dispatch, or the mock path). A job that did not end
// `finished`, or any command not `done` with exit 0, failed. A command
// resumed from an earlier attempt stays `done`/0, so it counts as passed. A
// `finished` job with no commands ran nothing that failed: false.
export function executeFailed(jobView) {
  if (!jobView || typeof jobView !== 'object' || !Array.isArray(jobView.commands)) return null
  if (jobView.status !== 'finished') return true
  return jobView.commands.some((c) => c?.status !== 'done' || c?.exit_code !== 0)
}

// The outcome a step_run row reads as: its verify_outcome when set, else its
// pass/fail verdict, with `fail` read as `work_failed`. null when the row has
// neither (any other step, or a Verify run from before HZ-429).
export function readVerifyOutcome(row) {
  if (!row) return null
  if (VERIFY_VERDICT_VALUES.has(row.verify_outcome)) return row.verify_outcome
  if (row.verdict === 'fail') return 'work_failed'
  return row.verdict === 'pass' ? 'pass' : null
}
