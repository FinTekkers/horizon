// Autopilot caretaker, gate 13 with mergeability unknown (HZ-296).
//
// GitHub computes a PR's mergeability asynchronously, so an item can reach
// Accept the code with pr_mergeable still NULL. caretakerAccept.js then
// re-reads the PR a fixed number of times (MERGEABLE_PROBE_DELAYS_MS, counted
// in caretaker_mergeable_probe), and caretaker.js holds its gate-13 judgement
// until those re-reads are done or MERGEABLE_DEFER_CAP_MS has passed — so it
// never records "would ping the human" for an item about to be accepted.
//
// Shared by both modules so the evaluator need not import the acting pass.
// Reads only; caretakerAccept.js owns every write to the probe table.

import { db } from './db.js'

// Each re-read is due this long after the previous one (the first, after the
// arrival was first seen): 4 attempts, fixed, with backoff — the last is
// started about 8 minutes in on the 60s tick, inside the defer cap.
export const MERGEABLE_PROBE_DELAYS_MS = [30e3, 60e3, 120e3, 240e3]
export const MERGEABLE_PROBE_ATTEMPTS = MERGEABLE_PROBE_DELAYS_MS.length
// Backstop: a shadow project (no re-reads), or a re-read that never returns
// (a restart mid-call), is judged on what is on record after this long.
export const MERGEABLE_DEFER_CAP_MS = 10 * 60e3

// A review reached gate 13 passed unless it was forwarded as failing (HZ-185),
// which records that review's run id. No review on record (0) is not a pass.
export const reviewPassed = (arrivalRunId, forwardedReviewRunId) =>
  arrivalRunId !== 0 && arrivalRunId !== forwardedReviewRunId

const selectProbe = db.prepare(
  'SELECT first_seen_ms, attempts, settled FROM caretaker_mergeable_probe WHERE item_id = ? AND arrival_run_id = ?',
)

// { firstSeenMs, attempts, settled, exhausted } for one arrival, or null when
// no re-read was ever scheduled for it.
export function mergeableProbeState(itemId, arrivalRunId) {
  const row = selectProbe.get(itemId, arrivalRunId)
  if (!row) return null
  return {
    firstSeenMs: row.first_seen_ms,
    attempts: row.attempts,
    settled: row.settled,
    exhausted: row.settled >= MERGEABLE_PROBE_ATTEMPTS,
  }
}
