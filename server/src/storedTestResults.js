// HZ-349: the step-12 reviewers' only test evidence — the per-test results
// HZ-327 stored for the item's latest finished implement run, read from
// test_result, grouped by the run that produced them: 'main' (the configured
// commands, which decide pass or fail) and 'branch' (the item's own changed
// scripts/checks/, run after main's). Test-output files in the worktree are
// never read here: a later run may have overwritten them (LS-98).

import { db } from './db.js'
import { BOOTED_AT } from './store.js'
import { msOf } from './sqlTime.js'
import { IMPLEMENT_STEP_INDEX } from '../../domain/js/lifecycle.js'

export const STORED_RESULTS_INPUT_LABEL = 'Stored test results (step record)'
// Its own cap, outside HZ-105's artifact budget, like the overlap input.
export const STORED_RESULTS_MAX_CHARS = 12000
// farmd posts an implement run's test results just AFTER its result, and the
// review step is dispatched as soon as that result lands. How long dispatch
// waits for rows a farm check run is known to have sent.
export const STORED_RESULTS_WAIT_MS = Number(process.env.STORED_RESULTS_WAIT_MS ?? 15000)
const STORED_RESULTS_POLL_MS = 200

const latestImplementRun = db.prepare(
  `SELECT id, started_at, ended_at FROM step_run
    WHERE item_id = ? AND step_index = ? AND status = 'done' ORDER BY id DESC LIMIT 1`,
)
const selectRows = db.prepare(
  `SELECT run_label, command, attempt, exit_code, suite, file, test, status FROM test_result
    WHERE item_id = ? AND run_id = ? AND source = 'implement' ORDER BY id`,
)
const hasRows = db.prepare(`SELECT 1 FROM test_result WHERE item_id = ? AND run_id = ? AND source = 'implement' LIMIT 1`)
// The farm's check run passed during this implement run (HZ-257's record):
// its per-test rows are on their way.
const checksPassedDuring = db.prepare(
  `SELECT 1 FROM check_pass WHERE item_id = ? AND source = 'implement' AND recorded_at >= ? LIMIT 1`,
)

export function latestImplementRunId(itemId) {
  return latestImplementRun.get(itemId, IMPLEMENT_STEP_INDEX)?.id ?? null
}

export function storedResultsFor(itemId, runId) {
  const out = { main: [], branch: [] }
  if (runId == null) return out
  for (const row of selectRows.all(itemId, runId)) (row.run_label === 'branch' ? out.branch : out.main).push(row)
  return out
}

// Synchronous, so a dispatch with nothing to wait for stays synchronous: the
// implement run whose rows dispatch should wait for, or null. Only a run that
// ended within the wait window and recorded a farm check pass qualifies.
// Never throws: a lookup error is "nothing to wait for".
export function storedResultsPending(itemId, nowMs = Date.now()) {
  try {
    const run = latestImplementRun.get(itemId, IMPLEMENT_STEP_INDEX)
    if (!run || STORED_RESULTS_WAIT_MS <= 0 || hasRows.get(itemId, run.id)) return null
    const endedMs = Date.parse(`${run.ended_at ?? ''}Z`.replace(' ', 'T'))
    if (!(nowMs - endedMs < STORED_RESULTS_WAIT_MS)) return null
    return checksPassedDuring.get(itemId, run.started_at) ? run.id : null
  } catch (err) {
    console.warn(`[stored results] could not tell whether ${itemId}'s results are pending: ${err.message}`)
    return null
  }
}

// HZ-570: the upload ledger testResults.js keeps on the run. While farmd may
// still retry (STORED_RESULTS_RETRY_WINDOW_S, its FARM_TEST_RUNS_RETRY_MAX_S)
// review is held, not dispatched; only once farmd can no longer deliver is a
// run whose server restarted after it ended said to have lost its results.
export const RESULTS_LOST_TEXT = 'results lost to a server restart'
export const STORED_RESULTS_RETRY_WINDOW_S = Number(process.env.STORED_RESULTS_RETRY_WINDOW_S ?? 900)

const latestUpload = db.prepare(
  `SELECT id, ended_at, test_runs_expected AS expected, test_runs_stored_at AS storedAt, test_runs_abandoned AS abandoned
     FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'done' ORDER BY id DESC LIMIT 1`,
)

// { state, runId } for the item's latest done implement run:
//   'waiting'  its rows are promised and farmd may still deliver them
//   'lost'     they never came, and the server restarted after the run ended
//   'none'     anything else — stored, never promised, rejected by this
//              server, or not delivered with no restart — which review reads
//              as it always has
// Times are parsed, never compared as text: ended_at is SQLite's
// "YYYY-MM-DD HH:MM:SS", BOOTED_AT an ISO string. Never throws.
// The orchestrator holds review while 'waiting' and re-queues the checks on
// 'lost' (up to its cap); buildStoredResultsInput says 'lost' in the input.
export function storedResultsUpload(itemId, { nowMs = Date.now(), bootedAt = BOOTED_AT } = {}) {
  try {
    const run = latestUpload.get(itemId, IMPLEMENT_STEP_INDEX)
    if (!run) return { state: 'none', runId: null }
    if (!(run.expected > 0) || run.storedAt || run.abandoned === 'rejected' || !run.ended_at) return { state: 'none', runId: run.id }
    const endedMs = msOf(run.ended_at)
    if (run.abandoned == null && nowMs - endedMs < STORED_RESULTS_RETRY_WINDOW_S * 1000) return { state: 'waiting', runId: run.id }
    // ended_at has whole seconds: a run that ended in the boot's own second
    // is not known to be before it.
    return { state: endedMs + 1000 <= Date.parse(bootedAt) ? 'lost' : 'none', runId: run.id }
  } catch (err) {
    console.warn(`[stored results] could not read ${itemId}'s upload: ${err.message}`)
    return { state: 'none', runId: null }
  }
}

// Resolves once the run's rows are stored, or after STORED_RESULTS_WAIT_MS.
export async function waitForStoredResults(itemId, runId, waitMs = STORED_RESULTS_WAIT_MS) {
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    try {
      if (hasRows.get(itemId, runId)) return
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, STORED_RESULTS_POLL_MS))
  }
}

const name = (r) => `${r.suite ? `${r.suite} › ` : ''}${r.test}${r.file ? ` (${r.file})` : ''}`

// One label's section, within `budget` chars. Totals and every command's
// exit status are always shown in full; then failing tests, then skipped,
// then passing, until the budget runs out — the rest are counted, not listed.
function renderSection(label, rows, budget) {
  const count = (status) => rows.filter((r) => r.status === status).length
  const head = [`### ${label}`, `Totals: ${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped.`]
  const commands = new Map()
  for (const r of rows) {
    const key = `${r.attempt} ${r.command}`
    if (!commands.has(key) || commands.get(key).exit_code == null) commands.set(key, r)
  }
  head.push('Commands:')
  for (const c of commands.values()) {
    const exit = c.exit_code == null ? 'exit status not recorded' : `exit ${c.exit_code}`
    head.push(`- \`${c.command}\`${c.attempt === 2 ? ' (rerun)' : ''} — ${exit}`)
  }
  const lines = [...head]
  let used = lines.join('\n').length
  let unlisted = 0
  for (const status of ['fail', 'skip', 'pass']) {
    const group = rows.filter((r) => r.status === status)
    if (group.length === 0) continue
    const title = `${status === 'fail' ? 'Failed' : status === 'skip' ? 'Skipped' : 'Passed'}:`
    if (used + title.length + 1 > budget) {
      unlisted += group.length
      continue
    }
    lines.push(title)
    used += title.length + 1
    for (const r of group) {
      const line = `- ${name(r)}${r.attempt === 2 ? ' [rerun]' : ''}`
      if (used + line.length + 1 > budget) {
        unlisted += 1
        continue
      }
      lines.push(line)
      used += line.length + 1
    }
  }
  if (unlisted > 0) lines.push(`… ${unlisted} more result(s) not listed for space — the totals above are exact.`)
  return lines.join('\n')
}

export function renderStoredResults({ main, branch }, runId, { lost = false } = {}) {
  if (lost) {
    return [
      `## ${STORED_RESULTS_INPUT_LABEL}`,
      `The farm's test results for the implement step's run #${runId} were ${RESULTS_LOST_TEXT}: the farm could not deliver them before the server restarted, and none were stored. This is not evidence of a pass or a fail.`,
    ].join('\n\n')
  }
  const intro = [
    `## ${STORED_RESULTS_INPUT_LABEL}`,
    runId == null
      ? 'No finished implement run was found for this item.'
      : `What the farm stored for the implement step's run #${runId}. This is the only evidence of which tests ran and how they ended; test-output files in the worktree (test-results/, build/test-results/, playwright-report/) are not.`,
    "`main` is the repo's configured check commands. `branch` is this item's own changed scripts/checks/, run after main's. Both decide pass or fail: a failure in either fails the check.",
  ].join('\n\n')
  const room = STORED_RESULTS_MAX_CHARS - intro.length - 200
  const sections = []
  sections.push(
    main.length > 0 ? renderSection('main', main, branch.length > 0 ? Math.floor(room / 2) : room) : '### main\nNo per-test results were stored for this run.',
  )
  sections.push(
    branch.length > 0
      ? renderSection('branch', branch, Math.floor(room / 2))
      : '### branch\nNo branch run was recorded: this item changed no configured `scripts/checks/` script.',
  )
  return [intro, ...sections].join('\n\n').slice(0, STORED_RESULTS_MAX_CHARS)
}

// The orchestrator's entry point: the step-12 input for `itemId`. Never
// throws: a read error is said in the input, so no dispatch is lost to it.
export function buildStoredResultsInput(itemId) {
  try {
    const runId = latestImplementRunId(itemId)
    const lost = runId != null && storedResultsUpload(itemId).state === 'lost'
    return { label: STORED_RESULTS_INPUT_LABEL, content: renderStoredResults(storedResultsFor(itemId, runId), runId, { lost }) }
  } catch (err) {
    return {
      label: STORED_RESULTS_INPUT_LABEL,
      content: `## ${STORED_RESULTS_INPUT_LABEL}\n\nThe stored test results could not be read (${err.message}). There is no test evidence for this review.`,
    }
  }
}
