// HZ-328: one repo's per-test history, summarised from its test_result and
// check_flake rows. Pure — no db import — so testResults.testHistory() (the
// Admin endpoint) and scripts/export-test-history.mjs (the blocking-set
// inventory's input, read from a read-only DB) give the same numbers.
//
// A test is (suite, file, test). `passes` is runs that were neither a failure
// nor a skip. `main_failures` counts only failures from a run on main
// (source 'postmerge', which HZ-328c adds); until then it is 0.

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

// resultRows: {suite, file, test, status, duration_ms, created_at_ms, source}.
// flakeRows: {suite, file, test, n} — the check_flake count per test.
// Each test's run count, passes, failures (all and on main), skips, flake
// count, last seen, and median and p95 duration (ms, over the rows that have
// one). Newest last_seen first.
export function summarizeTestHistory(repo, resultRows, flakeRows) {
  const tests = new Map()
  for (const row of resultRows) {
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
  out.sort((a, b) => (a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0))
  return { repo, tests: out }
}

// The two queries both callers run, so the export reads exactly what the
// endpoint does.
export const RESULT_ROWS_SQL = `SELECT suite, file, test, status, duration_ms, created_at_ms, source FROM test_result
  WHERE repo = ? ORDER BY suite, file, test`
export const FLAKE_ROWS_SQL =
  'SELECT suite, file, test, COUNT(*) AS n FROM check_flake WHERE repo = ? GROUP BY suite, file, test'
