// HZ-328: one repo's per-test history, summarised from its test_result and
// check_flake rows. Pure — no db import — so testResults.testHistory() (the
// Admin endpoint) and scripts/export-test-history.mjs (the blocking-set
// inventory's input, read from a read-only DB) give the same numbers.
//
// A test is (suite, file, test). `passes` is runs that were neither a failure
// nor a skip. `main_failures` counts only failures from a run on main
// (source 'postmerge', which HZ-328c adds); until then it is 0.
//
// HZ-946: `commands` is the same rows grouped by the command that ran them —
// how many check runs ran it, and in how many it wrote no per-test report
// (a no_report = 1 row; NULL, an older row, counts as unknown, not no
// report). `tests` is unchanged by it.

export const MAIN_SOURCE = 'postmerge'

// Nearest-rank percentile of an ascending array (p in (0, 1]).
function percentile(sorted, p) {
  return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

function median(sorted) {
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

// resultRows: {suite, file, test, status, duration_ms, created_at_ms, source,
// command, check_run, no_report}.
// flakeRows: {suite, file, test, n} — the check_flake count per test.
// Each test's run count, passes, failures (all and on main), skips, flake
// count, last seen, and median and p95 duration (ms, over the rows that have
// one). Newest last_seen first.
export function summarizeTestHistory(repo, resultRows, flakeRows) {
  const tests = new Map()
  const commands = new Map()
  for (const row of resultRows) {
    countCommand(commands, row)
    const key = JSON.stringify([row.suite, row.file, row.test])
    let t = tests.get(key)
    if (!t) {
      t = {
        suite: row.suite,
        file: row.file,
        test: row.test,
        runs: 0,
        failures: 0,
        mainFailures: 0,
        skips: 0,
        lastMs: 0,
        durations: [],
      }
      tests.set(key, t)
    }
    t.runs += 1
    if (row.status === 'fail') t.failures += 1
    if (row.status === 'fail' && row.source === MAIN_SOURCE) t.mainFailures += 1
    if (row.status === 'skip') t.skips += 1
    if (row.created_at_ms > t.lastMs) t.lastMs = row.created_at_ms
    if (row.duration_ms !== null && row.status !== 'skip') t.durations.push(row.duration_ms)
  }
  const flakeCounts = new Map(flakeRows.map((f) => [JSON.stringify([f.suite, f.file, f.test]), f.n]))
  const out = [...tests.entries()].map(([key, t]) => {
    const sorted = t.durations.sort((a, b) => a - b)
    return {
      suite: t.suite,
      file: t.file,
      test: t.test,
      runs: t.runs,
      passes: t.runs - t.failures - t.skips,
      failures: t.failures,
      main_failures: t.mainFailures,
      skips: t.skips,
      flakes: flakeCounts.get(key) ?? 0,
      last_seen: new Date(t.lastMs).toISOString(),
      median_ms: median(sorted),
      p95_ms: percentile(sorted, 0.95),
    }
  })
  out.sort(newestFirst)
  return { repo, tests: out, commands: commandsOf(commands) }
}

function newestFirst(a, b) {
  return a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0
}

function countCommand(commands, row) {
  if (!row.command) return
  let c = commands.get(row.command)
  if (!c) {
    c = { runs: new Set(), noReportRuns: new Set(), lastMs: 0 }
    commands.set(row.command, c)
  }
  c.runs.add(row.check_run)
  if (row.no_report === 1) c.noReportRuns.add(row.check_run)
  if (row.created_at_ms > c.lastMs) c.lastMs = row.created_at_ms
}

// One entry per command, newest last_seen first.
function commandsOf(commands) {
  const out = [...commands.entries()].map(([command, c]) => ({
    command,
    runs: c.runs.size,
    no_report_runs: c.noReportRuns.size,
    last_seen: new Date(c.lastMs).toISOString(),
  }))
  return out.sort((a, b) => newestFirst(a, b) || (a.command < b.command ? -1 : a.command > b.command ? 1 : 0))
}

// The two queries both callers run, so the export reads exactly what the
// endpoint does.
// HZ-349: main's runs only; a branch run's rows (run_label 'branch') are
// evidence for one item's review, never the repo's history. A DB from before
// HZ-349 has no run_label (the export never migrates): every row in it is
// main's, so it is read whole.
export const RESULT_ROWS_SQL = `SELECT suite, file, test, status, duration_ms, created_at_ms, source FROM test_result
  WHERE repo = ? AND run_label = 'main' ORDER BY suite, file, test`
export const UNLABELLED_RESULT_ROWS_SQL = `SELECT suite, file, test, status, duration_ms, created_at_ms, source FROM test_result
  WHERE repo = ? ORDER BY suite, file, test`
// HZ-946: the endpoint's rows — RESULT_ROWS_SQL's, plus what `commands` is
// counted from. Only the migrated DB has no_report; the export keeps the two
// queries above, so it never needs the column, and drops `commands` so no
// command line reaches its file.
export const COMMAND_RESULT_ROWS_SQL = `SELECT suite, file, test, status, duration_ms, created_at_ms, source, command, check_run, no_report
  FROM test_result WHERE repo = ? AND run_label = 'main' ORDER BY suite, file, test`
export const FLAKE_ROWS_SQL =
  'SELECT suite, file, test, COUNT(*) AS n FROM check_flake WHERE repo = ? GROUP BY suite, file, test'
