// HZ-946: the item page's check line — one entry per command of the final
// main check round of the item's latest done implement run, with its pass or
// fail and whether it wrote no per-test report.
//
// It imports only db.js and the lifecycle, so store.js can read it without the
// cycle storedTestResults.js (which imports store.js) would make. The pass or
// fail rule and "the latest done implement run" live here once, shared with
// storedTestResults.js, so the line and review judge a command the same way.
// No pass or fail ever reads no_report: a missing report only loses detail.

import { db } from './db.js'
import { IMPLEMENT_STEP_INDEX } from '../../domain/js/lifecycle.js'

const latestImplementRunRow = db.prepare(
  `SELECT id, started_at, ended_at, test_runs_expected AS expected FROM step_run
    WHERE item_id = ? AND step_index = ? AND substep_id IS NULL AND status = 'done' ORDER BY id DESC LIMIT 1`,
)

// The item's latest done implement run { id, started_at, ended_at, expected },
// or undefined.
export function latestImplementRun(itemId) {
  return latestImplementRunRow.get(itemId, IMPLEMENT_STEP_INDEX)
}

export function latestImplementRunId(itemId) {
  return latestImplementRun(itemId)?.id ?? null
}

// command -> { attempt, exit, failed } for one check run. Each command's last
// attempt decides: it failed on a fail row or an exit that is not 0 or was not
// recorded — latestBranchRunFailed's rule (store.js).
export function commandOutcomes(rows) {
  const last = new Map()
  for (const r of rows) {
    const seen = last.get(r.command)
    if (!seen || r.attempt > seen.attempt) last.set(r.command, { attempt: r.attempt, exit: r.exit_code, failed: false })
  }
  for (const r of rows) {
    const o = last.get(r.command)
    if (r.attempt === o.attempt && (r.status === 'fail' || r.exit_code == null || r.exit_code !== 0)) o.failed = true
  }
  return last
}

// Served by idx_test_result_item_label (item_id, run_label, id).
const selectMainRows = db.prepare(
  `SELECT check_run, command, attempt, exit_code, status, no_report FROM test_result
    WHERE item_id = ? AND run_label = 'main' AND run_id = ? AND source = 'implement' ORDER BY id`,
)

// [{ command, outcome: 'pass'|'fail', exit, noReport }] for the newest main
// check run of the item's latest done implement run, in the order its
// commands ran; [] when none was stored. noReport is true only when the
// command's last attempt stored the farm's no-report row (no_report = 1); an
// older row (NULL) is false. May throw.
export function itemCheckLine(itemId) {
  const runId = latestImplementRunId(itemId)
  if (runId == null) return []
  const rows = selectMainRows.all(itemId, runId)
  if (rows.length === 0) return []
  const checkRun = rows.at(-1).check_run
  const round = rows.filter((r) => r.check_run === checkRun)
  const line = []
  for (const [command, o] of commandOutcomes(round)) {
    const noReport = round.some((r) => r.command === command && r.attempt === o.attempt && r.no_report === 1)
    line.push({ command, outcome: o.failed ? 'fail' : 'pass', exit: o.exit ?? null, noReport })
  }
  return line
}
