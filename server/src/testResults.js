// HZ-327: every check run's per-test results, as data.
//
// The farm (farm/checks.py) sends one entry per run_checks() call —
// {check_run, commit_sha, tree_sha, tests: [{suite, file, test, status,
// duration_ms, command, attempt, failure_message}]} — from the JUnit XML its
// commands wrote to HORIZON_TEST_REPORT_DIR, or one row per command that
// wrote none. This module stores them (test_result), finds flakes across
// runs, answers the history query HZ-328 picks its blocking test set from,
// and prunes rows after 90 days.
//
// HZ-349: an entry may carry label 'main' or 'branch' (the item's own changed
// check scripts, run after main's) and commands: [{command, attempt,
// exit_code}]. Branch rows are stored apart (run_label) and never count as
// history or a flake: only main's runs judge.
//
// Like checkFlakes.js it never throws to its caller: a lost row is a gap in
// history, never a changed check result. The repo is the item row's.
//
// HZ-570: except for the implement route. A deploy restart used to lose a
// run's rows (farmd posted once, the route replied before storing). Now
// /complete stamps an upload ledger on the run (markUploadPending), the route
// stores before it replies and throws a failed insert so farmd retries, a
// retry replaces the run's rows, and the deploy drain waits on
// pendingUploads().

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from './db.js'
import { IMPLEMENT_STEP_INDEX } from '../../domain/js/lifecycle.js'
import { redact } from './caretakerRules.js'
import { FLAKE_LIMITS, FLAKE_SOURCES, itemRepo, pingRepeatOffenders, runOwner, storeFlakes } from './checkFlakes.js'
import { FLAKE_ROWS_SQL, RESULT_ROWS_SQL, summarizeTestHistory } from './testHistorySummary.js'

export const TEST_RESULT_RETENTION_MS = 90 * 24 * 3600 * 1000
export const TEST_STATUSES = ['pass', 'fail', 'skip']
// One report is a whole suite; this bounds one request, not a normal run.
export const TEST_ROWS_MAX = 50_000
const NAME_MAX = 500
// HZ-605: farm/checks.py FAILURE_MESSAGE_MAX_CHARS caps it first; this is the
// same cap again at the trust boundary — change the two together.
const FAILURE_MESSAGE_MAX = 300
const SHA_RE = /^[0-9a-f]{40,64}$/

function text(value, max) {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : null
}

const insertRow = db.prepare(`
  INSERT INTO test_result (repo, commit_sha, tree_sha, item_id, run_id, source, check_run, command, suite, file,
                           test, status, duration_ms, attempt, created_at_ms, run_label, exit_code, failure_message)
  VALUES (@repo, @commitSha, @treeSha, @itemId, @runId, @source, @checkRun, @command, @suite, @file,
          @test, @status, @durationMs, @attempt, @createdAtMs, @runLabel, @exitCode, @failureMessage)
`)

// "command attempt" -> exit code, from an entry's commands list.
function exitCodes(commands) {
  const codes = new Map()
  for (const c of Array.isArray(commands) ? commands : []) {
    const command = text(c?.command, FLAKE_LIMITS.command)
    if (command && Number.isInteger(c.exit_code)) codes.set(`${c.attempt === 2 ? 2 : 1} ${command}`, c.exit_code)
  }
  return codes
}

// The rows of one farm entry that can be stored, or [] for an unusable entry.
// An entry with no label, or an unknown one (an older farm), is main's.
function rowsOf(run, base) {
  if (run === null || typeof run !== 'object' || !Array.isArray(run.tests)) return []
  const checkRun = text(run.check_run, FLAKE_LIMITS.id)
  if (!checkRun) return []
  const commitSha = typeof run.commit_sha === 'string' && SHA_RE.test(run.commit_sha) ? run.commit_sha : null
  const treeSha = typeof run.tree_sha === 'string' && SHA_RE.test(run.tree_sha) ? run.tree_sha : null
  const runLabel = run.label === 'branch' ? 'branch' : 'main'
  const codes = exitCodes(run.commands)
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
      runLabel,
      exitCode: codes.get(`${t.attempt === 2 ? 2 : 1} ${command}`) ?? null,
      failureMessage: t.status === 'fail' ? text(t.failure_message, FAILURE_MESSAGE_MAX) : null,
    })
  }
  return rows
}

// Tests in `checkRun` whose status is the opposite of the same test's in
// another run of the same tree. The run's own rerun pair (attempt 1 fail,
// attempt 2 pass) is not one: that is the farm's rerun flake, already sent.
// HZ-349: main's runs only — a branch script's tests are never a flake.
const crossRunFlips = db.prepare(`
  SELECT DISTINCT n.suite, n.file, n.test, n.command
    FROM test_result n
    JOIN test_result o
      ON o.repo = n.repo AND o.tree_sha = n.tree_sha AND o.test = n.test
     AND o.suite IS n.suite AND o.file IS n.file
     AND o.check_run != n.check_run AND o.status IN ('pass','fail') AND o.status != n.status
     AND o.run_label = 'main'
   WHERE n.check_run = ? AND n.repo = ? AND n.tree_sha IS NOT NULL AND n.status IN ('pass','fail')
     AND n.run_label = 'main'
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

// HZ-570: an implement run's rows are replaced, never added to, so farmd's
// retry after a restart (even one whose first post committed before the
// server died) leaves exactly one copy. The ledger closes in the same
// transaction.
const deleteRunRows = db.prepare(`DELETE FROM test_result WHERE run_id = ? AND source = 'implement'`)
const closeUpload = db.prepare(`UPDATE step_run SET test_runs_stored = ?, test_runs_stored_at = datetime('now') WHERE id = ?`)

// Stores an item's test runs, records any cross-run flake they reveal, and
// prunes. Rows are stored when this returns; the promise is the pings.
export function recordTestRuns(opts) {
  return storeTestRuns(opts).pings
}

// recordTestRuns' body: { stored, pings }. HZ-570: throwOnError re-throws a
// failed insert (the implement route answers 503 so farmd retries); otherwise
// it never throws, as premerge relies on.
function storeTestRuns({ itemId, runId = null, source, testRuns, now = Date.now, log = console, throwOnError = false, ...ping }) {
  const none = { stored: 0, pings: Promise.resolve({ stored: 0, flakes: 0, pinged: 0 }) }
  const ledgerRunId = Number.isInteger(runId) && source === 'implement' ? runId : null
  let committed = false
  try {
    const usable = Array.isArray(testRuns) && testRuns.length > 0 && FLAKE_SOURCES.includes(source)
    const repo = usable ? itemRepo(itemId) : null
    if (!repo) {
      // Nothing to store is still an answer: the ledger closes at 0 rows.
      if (ledgerRunId !== null) closeUpload.run(0, ledgerRunId)
      return none
    }
    const nowMs = now()
    const base = { repo, itemId, runId: Number.isInteger(runId) ? runId : null, source, createdAtMs: nowMs }
    const entries = testRuns.map((run) => rowsOf(run, base)).filter((rows) => rows.length > 0)
    let stored = 0
    const found = db.transaction(() => {
      if (ledgerRunId !== null) deleteRunRows.run(ledgerRunId)
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
      if (ledgerRunId !== null) closeUpload.run(stored, ledgerRunId)
      return flakes
    })()
    committed = true
    if (entries.reduce((n, rows) => n + rows.length, 0) > stored) {
      log.warn?.(`[test_result] over ${TEST_ROWS_MAX} rows for ${itemId} — the rest are not stored`)
    }
    const flakeRows = storeFlakes({ repo, itemId, runId, source, detectedBy: 'history', flakes: found, nowMs })
    pruneTestHistory(nowMs)
    const pings = pingRepeatOffenders({ repo, itemId, stored: flakeRows, nowMs, log, ...ping }).then((pinged) => ({
      stored,
      flakes: flakeRows.length,
      pinged,
    }))
    return { stored, pings }
  } catch (err) {
    log.error?.(`[test_result] not recorded for ${itemId}: ${redact(err?.message || String(err))}`)
    // Only a failed insert is worth a retry: rows already committed stand.
    if (throwOnError && !committed) throw err
    return none
  }
}

// The /api/farm/steps/:runId/test-runs route: item from the run's own row.
// HZ-570: { stored, unknownRun, pings }, and a failed insert throws (the
// route answers 503 and farmd retries).
export function recordRunTestRuns(runId, testRuns, opts = {}) {
  const owner = runOwner(runId)
  if (!owner) return { stored: 0, unknownRun: true, pings: Promise.resolve({ stored: 0, flakes: 0, pinged: 0 }) }
  const { stored, pings } = storeTestRuns({ itemId: owner.itemId, runId, source: 'implement', testRuns, ...opts, throwOnError: true })
  return { stored, unknownRun: false, pings }
}

// HZ-570: /complete says how many rows farmd will post for this implement
// run. Only an active implement run is stamped, so a late /complete for a
// closed run never reopens its ledger.
const stampUpload = db.prepare(
  `UPDATE step_run SET test_runs_expected = ?, test_runs_stored = NULL, test_runs_stored_at = NULL, test_runs_abandoned = NULL
    WHERE id = ? AND status = 'active' AND step_index = ?`,
)
export function markUploadPending(runId, expected) {
  if (!Number.isInteger(runId) || !Number.isInteger(expected) || expected <= 0) return
  stampUpload.run(expected, runId, IMPLEMENT_STEP_INDEX)
}

// HZ-570: farmd stopped retrying this run's upload. `why` is 'rejected' (the
// server answered 4xx) or 'gave_up' (farmd's retry window ran out).
export const UPLOAD_ABANDON_WHYS = ['rejected', 'gave_up']
const abandonUpload = db.prepare(
  `UPDATE step_run SET test_runs_abandoned = ? WHERE id = ? AND test_runs_expected > 0 AND test_runs_stored_at IS NULL`,
)
export function markUploadAbandoned(runId, why) {
  if (!Number.isInteger(runId) || !UPLOAD_ABANDON_WHYS.includes(why)) return false
  return abandonUpload.run(why, runId).changes > 0
}

// HZ-570: the uploads a deploy drain waits for — stamped, not stored, not
// abandoned, and stamped within the last `windowS` (a stale row must not hold
// every deploy). The partial index idx_step_run_upload_pending serves it.
export const PENDING_UPLOAD_WINDOW_S = 900
const pendingUploadRows = db.prepare(
  `SELECT id AS runId, item_id AS itemId, test_runs_expected AS expected, ended_at AS endedAt FROM step_run
    WHERE test_runs_expected > 0 AND test_runs_stored_at IS NULL AND test_runs_abandoned IS NULL
      AND julianday(COALESCE(ended_at, started_at)) >= julianday('now') - ? / 86400.0
    ORDER BY id`,
)
export function pendingUploads({ windowS = PENDING_UPLOAD_WINDOW_S } = {}) {
  return pendingUploadRows.all(windowS).map((row) => ({ ...row }))
}

// HZ-570: a test-only pause in the test-runs route, so a restart test can kill
// the server at a known point: while <dir>/<stage>-<runId> exists the request
// waits, after writing <dir>/<stage>-<runId>.reached. Stage 'before' is before
// the insert, 'after' between its commit and the reply. Off unless
// HORIZON_TEST_RUNS_HOLD_DIR is set.
export async function testRunsHold(stage, runId, dir = process.env.HORIZON_TEST_RUNS_HOLD_DIR) {
  if (!dir) return
  const gate = join(dir, `${stage}-${runId}`)
  if (!existsSync(gate)) return
  writeFileSync(`${gate}.reached`, '')
  while (existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 50))
}

// For one repo: each test's history (see testHistorySummary.js). Newest
// last_seen first.
export function testHistory(repo) {
  return summarizeTestHistory(repo, db.prepare(RESULT_ROWS_SQL).iterate(repo), db.prepare(FLAKE_ROWS_SQL).all(repo))
}
