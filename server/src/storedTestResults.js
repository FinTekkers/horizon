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
  `SELECT id, started_at, ended_at, test_runs_expected AS expected FROM step_run
    WHERE item_id = ? AND step_index = ? AND substep_id IS NULL AND status = 'done' ORDER BY id DESC LIMIT 1`,
)
const selectRows = db.prepare(
  `SELECT id, check_run, commit_sha, run_label, command, attempt, exit_code, suite, file, test, status FROM test_result
    WHERE item_id = ? AND run_id = ? AND source = 'implement' ORDER BY id`,
)
const hasRows = db.prepare(`SELECT 1 FROM test_result WHERE item_id = ? AND run_id = ? AND source = 'implement' LIMIT 1`)
// The farm's check run passed during this implement run (HZ-257's record):
// its per-test rows are on their way.
const checksPassedDuring = db.prepare(
  `SELECT 1 FROM check_pass WHERE item_id = ? AND source = 'implement' AND recorded_at >= ? LIMIT 1`,
)
// HZ-751: the sha implement checked and pushed — the newest pass it recorded
// during the run. A pass is only recorded when a round passed.
const pushedShaDuring = db.prepare(
  `SELECT sha FROM check_pass WHERE item_id = ? AND source = 'implement' AND recorded_at >= ? ORDER BY id DESC LIMIT 1`,
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

// ---- the final check round (HZ-751) ----
// Every fix round of one implement run stores its rows under the same run_id,
// each round with its own check_run and commit_sha. Review judges only the
// final round, the one the pushed commit was checked with; earlier rounds are
// history, never a current failure. Rows are only read and filtered here.

// command -> { exit, failed } for one check run. Each command's last attempt
// decides: it failed on a fail row or an exit that is not 0 or was not
// recorded — latestBranchRunFailed's rule (store.js).
function commandOutcomes(rows) {
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

// Earlier check runs of the run, oldest first: one entry per failed command,
// or one per run that passed. `final` is the final round's outcomes, keyed
// "label command".
function historyOf(rows, current, final, state) {
  const runs = new Map()
  for (const r of rows) {
    if (current.has(r.check_run)) continue
    if (!runs.has(r.check_run)) runs.set(r.check_run, { label: r.run_label === 'branch' ? 'branch' : 'main', sha: r.commit_sha, rows: [] })
    runs.get(r.check_run).rows.push(r)
  }
  const history = []
  for (const [checkRun, run] of runs) {
    const outcomes = commandOutcomes(run.rows)
    const failed = [...outcomes].filter(([, o]) => o.failed)
    if (failed.length === 0) {
      history.push({ checkRun, label: run.label, sha: run.sha, command: null, exit: null, outcome: `all ${outcomes.size} command(s) passed` })
      continue
    }
    for (const [command, o] of failed) {
      const now = final.get(`${run.label} ${command}`)
      const outcome = !now
        ? 'not run in the final round'
        : now.failed
          ? 'still failing'
          : state === 'green'
            ? 'fixed in a later round'
            : 'passed in the final round'
      history.push({ checkRun, label: run.label, sha: run.sha, command, exit: o.exit, outcome })
    }
  }
  return history
}

// The final round of `rows` (one implement run's, in id order):
//   main      the check_run of the run's newest main row
//   branch    the check_run of its newest branch row, only if that run came
//             after the final main round and checked the same commit
//   state     'none'      no rows, and the run expected none (no checks)
//             'missing'   no main round was stored
//             'red'       a final-round command failed
//             'other_sha' it passed, but not at the sha implement pushed
//                         (or implement recorded no pushed sha in the run)
//             'green'     it passed at the pushed sha
//   regressionRan  every main command this run ran in any round has a
//             recorded exit in the final round
function roundOf(rows, pushedSha, expected) {
  const mains = rows.filter((r) => r.run_label !== 'branch')
  const branches = rows.filter((r) => r.run_label === 'branch')
  const lastMain = mains.at(-1)
  if (!lastMain) {
    const state = rows.length === 0 && !expected ? 'none' : 'missing'
    return { state, sha: null, pushedSha, main: [], branch: [], history: historyOf(rows, new Set(), new Map(), state), regressionRan: false }
  }
  const main = mains.filter((r) => r.check_run === lastMain.check_run)
  const lastBranch = branches.at(-1)
  let branch = []
  if (lastBranch && lastBranch.commit_sha === lastMain.commit_sha) {
    const run = branches.filter((r) => r.check_run === lastBranch.check_run)
    if (run[0].id > lastMain.id) branch = run
  }
  const mainOutcomes = commandOutcomes(main)
  const final = new Map()
  for (const [command, o] of mainOutcomes) final.set(`main ${command}`, o)
  for (const [command, o] of commandOutcomes(branch)) final.set(`branch ${command}`, o)
  const sha = lastMain.commit_sha
  let state = 'green'
  if ([...final.values()].some((o) => o.failed)) state = 'red'
  else if (!sha || sha !== pushedSha) state = 'other_sha'
  const current = new Set([lastMain.check_run, ...(branch.length > 0 ? [lastBranch.check_run] : [])])
  const regressionRan = [...new Set(mains.map((r) => r.command))].every((c) => mainOutcomes.get(c)?.exit != null)
  return { state, sha, pushedSha, main, branch, history: historyOf(rows, current, final, state), regressionRan }
}

const implementRunById = db.prepare(`SELECT id, started_at, test_runs_expected AS expected FROM step_run WHERE id = ?`)

// The final check round of implement run `runId` (see roundOf). May throw.
export function finalCheckRound(itemId, runId) {
  const run = runId == null ? null : implementRunById.get(runId)
  if (!run) return roundOf([], null, false)
  const pushedSha = pushedShaDuring.get(itemId, run.started_at)?.sha ?? null
  return roundOf(selectRows.all(itemId, run.id), pushedSha, run.expected > 0)
}

const short = (sha) => (sha ? `\`${sha.slice(0, 12)}\`` : 'an unrecorded commit')

// The round's state in plain words. Every state but green and none ends
// "this is a check failure": the server fails review on it (reviewCheckGate).
export function finalRoundText(round, runId) {
  switch (round.state) {
    case 'none':
      return 'No check round was stored for this run, and none was expected: no checks ran.'
    case 'green':
      return `The final check round passed at ${short(round.sha)}, the commit implement pushed. Judge the checks on this round only.`
    case 'red': {
      const failed = []
      for (const [label, rows] of [['main', round.main], ['branch', round.branch]]) {
        for (const [command, o] of commandOutcomes(rows)) {
          if (o.failed) failed.push(`${label} \`${command}\` ${o.exit == null ? 'exit status not recorded' : `exit ${o.exit}`}`)
        }
      }
      return `The final check round at ${short(round.sha)} failed: ${failed.join('; ')} — this is a check failure.`
    }
    case 'other_sha':
      return round.pushedSha
        ? `The final check round passed at ${short(round.sha)}, but implement pushed ${short(round.pushedSha)}: no final round at the pushed sha — this is a check failure.`
        : `The final check round passed at ${short(round.sha)}, but implement recorded no checked-and-pushed commit during this run (its check pass was refused, or has been pruned): no final round at the pushed sha — this is a check failure.`
    default:
      return `No final check round was stored for implement run #${runId}: no final round at the pushed sha — this is a check failure.`
  }
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
     FROM step_run WHERE item_id = ? AND step_index = ? AND substep_id IS NULL AND status = 'done' ORDER BY id DESC LIMIT 1`,
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
  // HZ-751: each command's last attempt is shown, marked (rerun) if it was
  // the farm's rerun.
  const commands = new Map()
  for (const r of rows) {
    const seen = commands.get(r.command)
    if (!seen || r.attempt > seen.attempt || (r.attempt === seen.attempt && seen.exit_code == null)) commands.set(r.command, r)
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

const HISTORY_MAX_LINES = 10

function renderHistory(history) {
  if (history.length === 0) return null
  const lines = [
    '### History (earlier fix rounds)',
    'Earlier check rounds of this run, superseded by the final round. They are history, not current evidence: never judge a current failure from them.',
  ]
  for (const h of history.slice(0, HISTORY_MAX_LINES)) {
    const what = h.command == null ? h.outcome : `\`${h.command}\` ${h.exit == null ? 'exit status not recorded' : `exit ${h.exit}`} — ${h.outcome}`
    lines.push(`- ${h.label} round at ${short(h.sha)}: ${what}`)
  }
  if (history.length > HISTORY_MAX_LINES) lines.push(`… ${history.length - HISTORY_MAX_LINES} more earlier entr(ies) not listed.`)
  return lines.join('\n')
}

// `round` is finalCheckRound's: only its rows are current evidence.
export function renderStoredResults(round, runId, { lost = false } = {}) {
  if (lost) {
    return [
      `## ${STORED_RESULTS_INPUT_LABEL}`,
      `The farm's test results for the implement step's run #${runId} were ${RESULTS_LOST_TEXT}: the farm could not deliver them before the server restarted, and none were stored. This is not evidence of a pass or a fail.`,
    ].join('\n\n')
  }
  const { main, branch } = round
  // A run with no checks renders as it did before HZ-751.
  const checked = round.state !== 'none'
  const intro = [
    `## ${STORED_RESULTS_INPUT_LABEL}`,
    runId == null
      ? 'No finished implement run was found for this item.'
      : `What the farm stored for the implement step's run #${runId}. This is the only evidence of which tests ran and how they ended; test-output files in the worktree (test-results/, build/test-results/, playwright-report/) are not.`,
    "`main` is the repo's configured check commands. `branch` is this item's own changed scripts/checks/, run after main's. Both decide pass or fail: a failure in either fails the check." +
      (checked ? ' Only the final check round below is current; earlier fix rounds are listed under History.' : ''),
  ].join('\n\n')
  const finalRound = checked
    ? [
        '### Final check round',
        finalRoundText(round, runId),
        `Horizon sets regression_tests_run from this round: ${round.regressionRan ? 'true' : 'false'}.`,
      ].join('\n')
    : ''
  const history = renderHistory(round.history)
  const room = STORED_RESULTS_MAX_CHARS - intro.length - finalRound.length - (history?.length ?? 0) - 200
  const sections = checked ? [finalRound] : []
  sections.push(
    main.length > 0 ? renderSection('main', main, branch.length > 0 ? Math.floor(room / 2) : room) : '### main\nNo per-test results were stored for this run.',
  )
  sections.push(
    branch.length > 0
      ? renderSection('branch', branch, Math.floor(room / 2))
      : checked
        ? '### branch\nNo branch run was recorded in the final round: this item changed no configured `scripts/checks/` script, or its branch run checked another commit.'
        : '### branch\nNo branch run was recorded: this item changed no configured `scripts/checks/` script.',
  )
  if (history) sections.push(history)
  return [intro, ...sections].join('\n\n').slice(0, STORED_RESULTS_MAX_CHARS)
}

// The orchestrator's entry point: the step-12 input for `itemId`. Never
// throws: a read error is said in the input, so no dispatch is lost to it.
export function buildStoredResultsInput(itemId) {
  try {
    const runId = latestImplementRunId(itemId)
    const lost = runId != null && storedResultsUpload(itemId).state === 'lost'
    return { label: STORED_RESULTS_INPUT_LABEL, content: renderStoredResults(finalCheckRound(itemId, runId), runId, { lost }) }
  } catch (err) {
    return {
      label: STORED_RESULTS_INPUT_LABEL,
      content: `## ${STORED_RESULTS_INPUT_LABEL}\n\nThe stored test results could not be read (${err.message}). There is no test evidence for this review.`,
    }
  }
}

// HZ-751: what review's verdict must say about the checks, from the final
// round of the item's latest implement run. null when that run had no checks
// (state 'none'): the reviewers' own values stand. Otherwise
// { state, regressionTestsRun, failure }, failure being null only for a green
// round. Never throws: a read error fails closed.
export function reviewCheckGate(itemId) {
  try {
    const runId = latestImplementRunId(itemId)
    if (runId == null) return null
    const round = finalCheckRound(itemId, runId)
    if (round.state === 'none') return null
    return {
      state: round.state,
      regressionTestsRun: round.regressionRan,
      failure: round.state === 'green' ? null : `Checks: ${finalRoundText(round, runId)}`,
    }
  } catch (err) {
    console.warn(`[stored results] could not read ${itemId}'s final check round: ${err.message}`)
    return {
      state: 'missing',
      regressionTestsRun: false,
      failure: `Checks: the final check round could not be read (${err.message}) — this is a check failure.`,
    }
  }
}
