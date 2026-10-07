// HZ-327: every check run's per-test results, as data.
//
// The farm (farm/checks.py) sends one entry per run_checks() call —
// {check_run, commit_sha, tree_sha, tests: [{suite, file, test, status,
// duration_ms, command, attempt}]} — from the JUnit XML its commands wrote to
// HORIZON_TEST_REPORT_DIR, or one row per command that wrote none. This module
// stores them (test_result), finds flakes across runs, answers the history
// query HZ-328 picks its blocking test set from, and prunes rows after 90 days.
//
// Like checkFlakes.js it never throws to its caller: a lost row is a gap in
// history, never a changed check result. The repo is the item row's.

import { db } from './db.js'
import { redact } from './caretakerRules.js'
import { FLAKE_LIMITS, FLAKE_SOURCES, itemRepo, pingRepeatOffenders, runOwner, storeFlakes } from './checkFlakes.js'

export const TEST_RESULT_RETENTION_MS = 90 * 24 * 3600 * 1000
export const TEST_STATUSES = ['pass', 'fail', 'skip']
// One report is a whole suite; this bounds one request, not a normal run.
export const TEST_ROWS_MAX = 50_000
const NAME_MAX = 500
const SHA_RE = /^[0-9a-f]{40,64}$/

function text(value, max) {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : null
}

const insertRow = db.prepare(`
  INSERT INTO test_result (repo, commit_sha, tree_sha, item_id, run_id, source, check_run, command, suite, file,
                           test, status, duration_ms, attempt, created_at_ms)
  VALUES (@repo, @commitSha, @treeSha, @itemId, @runId, @source, @checkRun, @command, @suite, @file,
          @test, @status, @durationMs, @attempt, @createdAtMs)
`)

// The rows of one farm entry that can be stored, or [] for an unusable entry.
function rowsOf(run, base) {
  if (run === null || typeof run !== 'object' || !Array.isArray(run.tests)) return []
  const checkRun = text(run.check_run, FLAKE_LIMITS.id)
  if (!checkRun) return []
  const commitSha = typeof run.commit_sha === 'string' && SHA_RE.test(run.commit_sha) ? run.commit_sha : null
  const treeSha = typeof run.tree_sha === 'string' && SHA_RE.test(run.tree_sha) ? run.tree_sha : null
  const rows = []
  for (const t of run.tests) {
    if (t === null || typeof t !== 'object' || !TEST_STATUSES.includes(t.status)) continue
    const test = text(t.test, NAME_MAX)
    const command = text(t.command, FLAKE_LIMITS.command)
    if (!test || !command) continue
    rows.push({
      ...base,
      commitSha,
      treeSha,
      checkRun,
      command,
      suite: text(t.suite, NAME_MAX),
      file: text(t.file, NAME_MAX),
      test,
      status: t.status,
      durationMs: Number.isInteger(t.duration_ms) && t.duration_ms >= 0 ? t.duration_ms : null,
      attempt: t.attempt === 2 ? 2 : 1,
    })
  }
  return rows
}

// Tests in `checkRun` whose status is the opposite of the same test's in
// another run of the same tree. The run's own rerun pair (attempt 1 fail,
// attempt 2 pass) is not one: that is the farm's rerun flake, already sent.
const crossRunFlips = db.prepare(`
  SELECT DISTINCT n.suite, n.file, n.test, n.command
    FROM test_result n
    JOIN test_result o
      ON o.repo = n.repo AND o.tree_sha = n.tree_sha AND o.test = n.test
     AND o.suite IS n.suite AND o.file IS n.file
     AND o.check_run != n.check_run AND o.status IN ('pass','fail') AND o.status != n.status
   WHERE n.check_run = ? AND n.repo = ? AND n.tree_sha IS NOT NULL AND n.status IN ('pass','fail')
`)

const flakeExists = db.prepare(`
  SELECT 1 FROM check_flake WHERE repo = ? AND tree_sha = ? AND test = ? AND suite IS ? AND file IS ? LIMIT 1
`)

// Deletes test_result and check_flake rows older than 90 days (a flake's
// pings go with it, ON DELETE CASCADE). Returns how many test rows went.
export function pruneTestHistory(nowMs = Date.now()) {
  const cutoff = nowMs - TEST_RESULT_RETENTION_MS
  return db.transaction(() => {
    const removed = db.prepare('DELETE FROM test_result WHERE created_at_ms < ?').run(cutoff).changes
    db.prepare('DELETE FROM check_flake WHERE created_at_ms < ?').run(cutoff)
    return removed
  })()
}

// Stores an item's test runs, records any cross-run flake they reveal, and
// prunes. Rows are stored when this returns; the promise is the pings.
export function recordTestRuns({ itemId, runId = null, source, testRuns, now = Date.now, log = console, ...ping }) {
  const none = Promise.resolve({ stored: 0, flakes: 0, pinged: 0 })
  try {
    if (!Array.isArray(testRuns) || testRuns.length === 0 || !FLAKE_SOURCES.includes(source)) return none
    const repo = itemRepo(itemId)
    if (!repo) return none
    const nowMs = now()
    const base = { repo, itemId, runId: Number.isInteger(runId) ? runId : null, source, createdAtMs: nowMs }
    const entries = testRuns.map((run) => rowsOf(run, base)).filter((rows) => rows.length > 0)
    let stored = 0
    const found = db.transaction(() => {
      const flakes = []
      const seen = new Set()
      for (const rows of entries) {
        const kept = rows.slice(0, TEST_ROWS_MAX - stored)
        stored += kept.length
        for (const row of kept) insertRow.run(row)
        const first = kept[0]
        if (!first?.treeSha) continue
        for (const flip of crossRunFlips.all(first.checkRun, repo)) {
          const key = JSON.stringify([first.treeSha, flip.suite, flip.file, flip.test])
          if (seen.has(key) || flakeExists.get(repo, first.treeSha, flip.test, flip.suite, flip.file)) continue
          seen.add(key)
          flakes.push({
            test: flip.test,
            suite: flip.suite,
            file: flip.file,
            command: flip.command,
            check_run: first.checkRun,
            commit_sha: first.commitSha,
            tree_sha: first.treeSha,
          })
        }
      }
      return flakes
    })()
    if (entries.reduce((n, rows) => n + rows.length, 0) > stored) {
      log.warn?.(`[test_result] over ${TEST_ROWS_MAX} rows for ${itemId} — the rest are not stored`)
    }
    const flakeRows = storeFlakes({ repo, itemId, runId, source, detectedBy: 'history', flakes: found, nowMs })
    pruneTestHistory(nowMs)
    return pingRepeatOffenders({ repo, itemId, stored: flakeRows, nowMs, log, ...ping }).then((pinged) => ({
      stored,
      flakes: flakeRows.length,
      pinged,
    }))
  } catch (err) {
    log.error?.(`[test_result] not recorded for ${itemId}: ${redact(err?.message || String(err))}`)
    return none
  }
}

// The /api/farm/steps/:runId/test-runs route: item from the run's own row.
export function recordRunTestRuns(runId, testRuns, opts = {}) {
  const none = Promise.resolve({ stored: 0, flakes: 0, pinged: 0 })
  try {
    const owner = runOwner(runId)
    return owner ? recordTestRuns({ itemId: owner.itemId, runId, source: 'implement', testRuns, ...opts }) : none
  } catch (err) {
    const log = opts.log ?? console
    log.error?.(`[test_result] not recorded for run ${runId}: ${redact(err?.message || String(err))}`)
    return none
  }
}

// Nearest-rank percentile of an ascending array (p in (0, 1]).
function percentile(sorted, p) {
  return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

function median(sorted) {
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

// For one repo: each test's run count, failures, flake count, last seen, and
// median and p95 duration (ms, over the rows that have one). A test is
// (suite, file, test). Newest last_seen first.
export function testHistory(repo) {
  const tests = new Map()
  const rows = db
    .prepare(
      `SELECT suite, file, test, status, duration_ms, created_at_ms FROM test_result
        WHERE repo = ? ORDER BY suite, file, test`,
    )
    .iterate(repo)
  for (const row of rows) {
    const key = JSON.stringify([row.suite, row.file, row.test])
    let t = tests.get(key)
    if (!t) {
      t = { suite: row.suite, file: row.file, test: row.test, runs: 0, failures: 0, skips: 0, lastMs: 0, durations: [] }
      tests.set(key, t)
    }
    t.runs += 1
    if (row.status === 'fail') t.failures += 1
    if (row.status === 'skip') t.skips += 1
    if (row.created_at_ms > t.lastMs) t.lastMs = row.created_at_ms
    if (row.duration_ms !== null && row.status !== 'skip') t.durations.push(row.duration_ms)
  }
  const flakeCounts = new Map(
    db
      .prepare('SELECT suite, file, test, COUNT(*) AS n FROM check_flake WHERE repo = ? GROUP BY suite, file, test')
      .all(repo)
      .map((f) => [JSON.stringify([f.suite, f.file, f.test]), f.n]),
  )
  const out = [...tests.entries()].map(([key, t]) => {
    const sorted = t.durations.sort((a, b) => a - b)
    return {
      suite: t.suite,
      file: t.file,
      test: t.test,
      runs: t.runs,
      failures: t.failures,
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
