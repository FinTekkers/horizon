// The agent orchestrator: runs agent-kind steps for any item whose cursor
// points at one, records every attempt as a step_run, logs an activity event
// with the agent's output, then advances the cursor and stops at the next
// human gate.
//
// Agents are MOCKED for now — each step behavior below fakes latency and
// produces a plausible output (and sometimes patches draft fields the Plan
// phase is meant to produce). The target state replaces runMockStep() with a
// dispatch to a real agent in a tmux session reporting progress back; the
// step_run/event bookkeeping and gate semantics stay exactly as they are.

import { db } from './db.js'
import { AGENTS } from './agentTokens.js'
import {
  STEPS,
  isClosed,
  isAbandoned,
  isBlocked,
  IMPLEMENT_STEP_INDEX,
  REVIEW_STEP_INDEX,
  ACCEPT_GATE_INDEX,
  DEPLOY_STEP_INDEX,
  requiredStepIndex,
} from '../../domain/js/lifecycle.js'
import { AUTO_RETRY_REASONS, REASON } from '../../domain/js/reasons.js'
import { patchLimits } from '../../domain/js/fields.js'
import {
  getItem,
  addEvent,
  notifyChange,
  registerAgentRunner,
  registerRunStateProvider,
  registerConflictRunProvider,
  recoverRejectedItems,
  blockersOf,
  requestChanges,
} from './store.js'
import { createMockPr, createDeployRelease, postIssueComment, createPrFromBranch } from './github.js'
import { PHASES } from '../../domain/js/lifecycle.js'
import { getActiveProjectId, getSetting, setSetting, getToken } from './settings.js'
import {
  FARM_URL,
  FARM_STEP_INDEXES,
  FARM_STEP_TIMEOUT_MS,
  FARM_QUEUE_TIMEOUT_MS,
  FARM_START_TIMEOUT_MS,
  FARM_CONFLICT_RESOLVE_TIMEOUT_MS,
  RECONCILE_SWEEP_MS,
  UI_URL,
} from './config.js'
import { PRIMARY_PERSONA_AGENT, isPersona, personaLabel, proposePersona } from './personas.js'

// Keyed by step_run.id (HZ-100) — NOT item id. Keying by item used to let a
// stale callback for a superseded run clear/overwrite the CURRENT run's
// watchdog (clearTimeout(timers[item_id]) has no way to know which run
// currently owns that slot). Every site below now always has the specific
// runId in scope, so each run's watchdog is independent of every other run
// ever dispatched for the same item.
const timers = {}

// The busy mutex kick() used to get for free from timers[item_id] truthiness
// — re-keying timers by run id removes that side effect, so this is now
// explicit: an item is "dispatching" from the moment kick() commits to a run
// until that run reaches a terminal state (done/cancelled/superseded),
// released by the same code paths that used to release the old timer slot
// (failFarmRun, finalizeReviewStep, finalizeDeployStep, the plain-completion
// tails of completeFarmRun/runMockStep, and cancel). Held across awaits
// (e.g. PR creation in completeFarmRun) so a second run can never be
// dispatched for an item whose first run is still mid-finalization.
const dispatching = new Set()

// Execution budget once an agent has actually started (HZ-57): the implement
// step legitimately runs long (real coding + tests), so its budget must
// outlast the farm's own 40-minute step timeout. Shared by dispatch-time
// arming, the /started callback, and restart re-arming so the three can't
// drift apart.
function executionBudgetFor(stepIndex) {
  return stepIndex === IMPLEMENT_STEP_INDEX ? Math.max(FARM_STEP_TIMEOUT_MS, 50 * 60 * 1000) : FARM_STEP_TIMEOUT_MS
}

// Hard cap enforced HERE, by the orchestrator, never by an agent prompt — a
// reviewer that keeps failing forwards the item to the human gate with the
// failing verdict attached rather than looping forever (HZ-30).
const REVIEW_CYCLE_CAP = 3

// Hard cap on consecutive AUTOMATIC retries of a step failure (HZ-76),
// enforced HERE and persisted on step_run.auto_retry_count — never decided
// by an agent or a prompt. Only retryable reasons are ever retried; anything
// else (malformed verdict, PR/release failure, checks-failed, an unrecognized
// or missing reason) pauses for a human exactly as before this existed —
// that default-safe behavior is what keeps a real defect from being masked.
//
// HZ-132: which reasons those are is no longer typed here. The vocabulary and
// its retryable flag are declared once, in domain/reasons.json, and
// AUTO_RETRY_REASONS is derived from it by domain/js/reasons.js — the farm
// emits the same constants and the UI's pause banner reads the same document.
export const AUTO_RETRY_CAP = 3

// MOCK_STEP_LATENCY_MS lets tests drive the mock pipeline without waiting.
const latency = () => Number(process.env.MOCK_STEP_LATENCY_MS) || 2000 + Math.floor(Math.random() * 3000)

// ---- bot farm lifecycle ----
// The farm runs with ONE project's context at a time. Switching projects
// tears the agents down and restarts them with the new context — mocked here
// with a delay (the real farm spin-up will take minutes).

const RESTART_MS = Number(process.env.FARM_RESTART_MS || 8000)

// ---- artifact prompt budget (HZ-29, reallocated by HZ-104) ----
// Prior artifacts (options analysis, impl plan, reviews) ride along in every
// dispatch to give the next agent its working context. Three failure modes
// this guards against: superseded attempts of a re-run step riding along
// next to the current one (dedup, unrelated to the budget below), an
// artifact silently cut off mid-sentence, and — HZ-102's actual bug — a
// fixed per-artifact reservation that truncated older artifacts even when
// the whole set was nowhere near the budget. The rule is now: never truncate
// while the budget is unspent; only when the total genuinely exceeds it does
// anything get reduced, and reduction always lands on a section or sentence
// boundary with the cut named and sized.
const TOTAL_ARTIFACT_BUDGET_CHARS = 60000
// Tie-break only: when trimming is unavoidable, the latest artifact — almost
// always the one the next step needs in full — gets a bigger share of
// whatever's left. It is not a fixed reservation and never fires when
// everything already fits.
const LATEST_ARTIFACT_WEIGHT = 3
// Write-side: a pathological-payload guard, not a working limit — mirrors the
// farm-side WRITE_ARTIFACT_SANITY_CEILING_CHARS. The dispatch-time budget
// above is what actually bounds the prompt.
const WRITE_TIME_SANITY_CEILING_CHARS = 200000

// Max-min water-filling: every artifact gets its full length if it fits,
// otherwise a share of the budget proportional to its weight. Artifacts
// smaller than their share are "peeled off" whole each pass; only the
// artifacts still too big to fit split what's left, recomputed each pass so
// no capacity a small artifact didn't need goes unused.
function allocateCaps(lengths, weights, budget) {
  const caps = new Array(lengths.length).fill(0)
  const active = new Set(lengths.map((_, i) => i))
  let remaining = budget
  let changed = true
  while (changed && active.size > 0) {
    changed = false
    const weightSum = [...active].reduce((sum, i) => sum + weights[i], 0)
    const level = weightSum > 0 ? remaining / weightSum : 0
    for (const i of [...active]) {
      if (lengths[i] <= weights[i] * level) {
        caps[i] = lengths[i]
        remaining -= lengths[i]
        active.delete(i)
        changed = true
      }
    }
  }
  const weightSum = [...active].reduce((sum, i) => sum + weights[i], 0)
  const level = weightSum > 0 ? remaining / weightSum : 0
  for (const i of active) caps[i] = Math.floor(weights[i] * level)
  return caps
}

// Splits markdown into ordered {heading, text} sections so a digest can drop
// or shrink whole sections instead of cutting raw characters. `text` for
// each section includes its own heading line. No headings found → a single
// section with heading: null, so plain (non-markdown) artifacts still digest
// sanely instead of crashing.
function splitSections(content) {
  const HEADING_RE = /^#{1,6}[ \t]+.*$/gm
  const matches = [...content.matchAll(HEADING_RE)]
  if (matches.length === 0) return [{ heading: null, text: content }]
  const sections = []
  if (matches[0].index > 0) sections.push({ heading: null, text: content.slice(0, matches[0].index) })
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length
    const heading = matches[i][0].replace(/^#{1,6}[ \t]+/, '').trim()
    sections.push({ heading, text: content.slice(start, end) })
  }
  return sections
}

// Finds the rightmost sentence/line boundary at or before `limit` so a cut
// never lands mid-sentence. Falls back to a hard cut at `limit` only for
// pathological text with no boundary at all (e.g. a single unbroken line of
// minified code) — visible in the marker as an omission either way.
function findCutPoint(text, limit) {
  if (limit >= text.length) return text.length
  if (limit <= 0) return 0
  const BOUNDARY_RE = /[.!?](?=\s|$)|\n/g
  let best = -1
  let m
  while ((m = BOUNDARY_RE.exec(text))) {
    const end = m.index + 1
    if (end > limit) break
    best = end
  }
  return best > 0 ? best : limit
}

function describeOmission(o) {
  return o.heading ? `"${o.heading}" (${o.chars} chars)` : `${o.chars} chars`
}

// Digests `content` down to (approximately) `cap` chars: keeps whole
// sections top-down until the cap is reached, cuts the first section that
// doesn't fit at a sentence/heading boundary, and drops the rest — never a
// raw mid-sentence slice. The marker names every omitted or shrunk section
// with its size so reduction stays visible (HZ-29's requirement), just
// better-shaped than a flat truncation count.
export function digestToFit(content, cap) {
  if (cap >= content.length) return content
  const boundedCap = Math.max(cap, 0)
  const sections = splitSections(content)
  let kept = ''
  const omitted = []
  for (const section of sections) {
    const remaining = boundedCap - kept.length
    if (remaining <= 0) {
      omitted.push({ heading: section.heading, chars: section.text.length })
      continue
    }
    if (section.text.length <= remaining) {
      kept += section.text
      continue
    }
    const cutAt = findCutPoint(section.text, remaining)
    kept += section.text.slice(0, cutAt)
    const omittedChars = section.text.length - cutAt
    if (omittedChars > 0) omitted.push({ heading: section.heading, chars: omittedChars })
  }
  const marker =
    omitted.length > 0
      ? `[...reduced: kept ${kept.length} of ${content.length} chars; omitted ${omitted.map(describeOmission).join(', ')}...]`
      : `[...reduced: kept ${kept.length} of ${content.length} chars...]`
  return `${kept}\n\n${marker}`
}

// How often the 60,000 budget actually binds is an open question this item
// is meant to answer with real data (see HZ-29's mistake: shipping a policy
// without measuring the case it governs) rather than assume. Logged once per
// real dispatch, not per artifact — deliberately not console.log-and-forget:
// the shape is fixed and small so a test can assert on it directly instead
// of only being verifiable by grepping a log later.
function logArtifactBudgetUsage(totalChars, truncated) {
  console.log(
    JSON.stringify({
      event: 'artifact_budget_usage',
      totalChars,
      budgetChars: TOTAL_ARTIFACT_BUDGET_CHARS,
      bound: truncated,
    }),
  )
}

// Exported for tests. Never truncates while the total fits the budget — that
// alone fixes HZ-102's shape (a 12,037-char plan behind a later artifact,
// both well under 60,000, no longer loses 75% of itself to a flat
// per-artifact reservation). Only when the total genuinely exceeds the
// budget does anything get reduced, via water-filling (latest artifact
// weighted to win ties) plus a heading/sentence-aware digest instead of a
// raw slice.
export function budgetArtifacts(rows) {
  if (rows.length === 0) return []
  const lengths = rows.map((r) => r.artifact.length)
  const totalChars = lengths.reduce((sum, len) => sum + len, 0)
  const fits = totalChars <= TOTAL_ARTIFACT_BUDGET_CHARS
  logArtifactBudgetUsage(totalChars, !fits)
  if (fits) {
    return rows.map((row) => ({
      label: STEPS[row.step_index]?.label || `step ${row.step_index}`,
      content: row.artifact,
      truncated: false,
      stepIndex: row.step_index,
    }))
  }
  const weights = rows.map((_, i) => (i === rows.length - 1 ? LATEST_ARTIFACT_WEIGHT : 1))
  const caps = allocateCaps(lengths, weights, TOTAL_ARTIFACT_BUDGET_CHARS)
  return rows.map((row, i) => {
    const full = row.artifact
    const cap = caps[i]
    const truncated = full.length > cap
    const content = truncated ? digestToFit(full, cap) : full
    return { label: STEPS[row.step_index]?.label || `step ${row.step_index}`, content, truncated, stepIndex: row.step_index }
  })
}

// Exported for tests. `step.requires` (domain/steps.json) names prior
// steps this step cannot review without in full. Returns one entry per
// required label whose budgeted artifact was truncated — empty when every
// required input is suppliable whole (including when the step has no
// `requires` at all, which is most steps).
export function missingRequiredInputs(step, rows, budgeted) {
  return (step.requires || [])
    .map((label) => {
      const reqIndex = requiredStepIndex(label)
      const entry = budgeted.find((b) => b.stepIndex === reqIndex)
      if (!entry?.truncated) return null
      const row = rows.find((r) => r.step_index === reqIndex)
      return { label, fullLen: row.artifact.length, gotLen: entry.content.length }
    })
    .filter(Boolean)
}

let farm = { status: 'running', since: new Date().toISOString(), runStates: {} }

export function getFarmState() {
  // runStates is an internal cache for store.js (via registerRunStateProvider),
  // not part of the farm's own status — keep it out of this public snapshot.
  const { runStates, ...publicState } = farm
  return { ...publicState, activeProjectId: getActiveProjectId() }
}

// ---- queued vs running (HZ-54) ----
// The board showed every dispatched step as "in progress" whether an agent
// was actually working on it or it was just sitting in the farm's queue.
// The farm now reports a small state vocabulary ({state, reason} — never a
// tmux session name) per run_id via POST /runs/status, polled here on an
// interval independent of the request path so snapshot()/listItems() stay
// synchronous. Cached on `farm.runStates`, keyed by step_run.id (string).
// How often to retry reaching a farm we have lost contact with.
const FARM_RECOVERY_POLL_MS = Number(process.env.FARM_RECOVERY_POLL_MS || 15_000)
const RUN_STATE_POLL_MS = Number(process.env.FARM_RUN_STATE_POLL_MS || 4000)
let runStatePollInFlight = false

// Exported for tests: normally driven by the setInterval in init(), below.
export function pollRunStates() {
  if (runStatePollInFlight) return Promise.resolve() // don't let a slow farm response overlap the next tick
  const active = db.prepare("SELECT id FROM step_run WHERE status = 'active'").all()
  if (active.length === 0) {
    farm.runStates = {}
    return Promise.resolve()
  }
  runStatePollInFlight = true
  return farmFetch('/runs/status', { run_ids: active.map((r) => String(r.id)) })
    .then((data) => {
      farm.runStates = data.states || {}
      notifyChange()
    })
    .catch(() => {}) // fail soft: an unreachable/old/slow farm just leaves the last-known cache in place
    .finally(() => {
      runStatePollInFlight = false
    })
}

// e2e only, wired behind TEST_HOOKS_ENABLED in app.js: the e2e suite runs
// with no real farm daemon, so pollRunStates() never has anything to poll.
// This lets a spec seed farm.runStates directly, exactly the shape a real
// /runs/status reply would populate, so the board's queued/running rendering
// gets real end-to-end coverage without standing up a fake farm process.
export function setRunStateForTest(runId, state, reason = null) {
  farm.runStates = { ...farm.runStates, [String(runId)]: { state, reason } }
  notifyChange()
}

// e2e only (HZ-154), same wiring and same reasoning as the hook above: the
// suite has no farm daemon, so the scoped conflict path's whole visible
// outcome — the item coming back to the Accept gate resolved, with the
// activity feed naming the files, the hunks and the scoped verdict, and the
// implement step's attempt count sitting still — would otherwise be covered
// only below the UI. This queues ONE canned /conflicts/resolve reply for the
// next resolveConflicts() call, in place of the farmd round trip.
//
// It stubs farmd's ANSWER, never the trigger or the gate: the click, the
// session, the PIN, the escalation path and every guard clause in
// resolveConflicts() all still run exactly as they do in production. Left
// null unless a spec sets it, and the route that sets it exists only when
// HORIZON_TEST_HOOKS=1, which production never sets.
let cannedConflictReply = null

export function setConflictReplyForTest(reply) {
  cannedConflictReply = reply
}

function takeCannedConflictReply() {
  const reply = cannedConflictReply
  cannedConflictReply = null
  return reply
}

// ---- real farm (farm/ Python daemon) plumbing ----

// Every farm call is bounded — a hung farmd (network partition, a deadlocked
// git/test subprocess it never gets to) must not hang the caller forever.
// Most routes here just write a queue file or read in-memory state, so the
// default is generous only in the "should never realistically be hit" sense;
// /conflicts/resolve is the one call that legitimately runs long (a real git
// merge plus the target repo's own test suite) and passes its own timeout,
// sized the same as the implement step's own execution budget below.
const DEFAULT_FARM_FETCH_TIMEOUT_MS = 30_000

async function farmFetch(path, body, { timeoutMs = DEFAULT_FARM_FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetch(`${FARM_URL}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`farm request to ${path} timed out after ${timeoutMs}ms`)
    throw err
  } finally {
    clearTimeout(timer)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `farm returned ${res.status} for ${path}`)
    // Callers that must tell one farm refusal from another (HZ-188: a busy
    // item vs a paused farm, both 409) read these, never the message text.
    err.status = res.status
    err.code = data.error
    throw err
  }
  return data
}

// Live log tail for a farm run (HZ-5): farmd serves the tmux pipe-pane
// mirror, paged by byte offset. Returns { status, data } so the route can
// pass the farm's own status (200/404) through; throws when the farm itself
// is unreachable.
export async function fetchRunLog(runId, offset = 0) {
  const res = await fetch(`${FARM_URL}/runs/${runId}/log?offset=${encodeURIComponent(offset)}`)
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

// ---- HZ-92: mechanical merge-conflict resolution ----
// A PR whose only problem is a mechanical merge conflict (renames, a
// deletion, non-overlapping edits — HZ-83's PR #90 was exactly this) does
// not need a full implement cycle. farmd's /conflicts/resolve is a plain
// `git merge` gated on the repo's own tests, no agent involved. On success
// this function deliberately touches NOTHING but the activity log — no
// step_run row, no cursor change — so the implement step's attempt count and
// every already-passed downstream step (review, the gate itself) are left
// exactly as they were. Any conflict this script can't be sure is correct
// (real overlapping edits, or a clean merge whose tests then fail) escalates
// through the exact same fallback the "send back to resolve conflicts"
// button already used before this existed: requestChanges to the implement
// step — so semantic conflicts are never auto-resolved and the Accept gate/
// PIN path is untouched either way.
//
// Deliberate pivot from the reviewed plan's auto-trigger design (a
// pollPrStates hook + registerConflictResolver + a conflict_resolution_run
// table, dispatching as soon as GitHub reports mergeable=false): the
// architecture review found that design's own required safety net — stale
// `active` row recovery after a farmd crash, which the unique
// (item_id, pr_head_sha) index would otherwise let permanently block retries
// on that commit — was never actually scheduled as work, plus an
// unresolved dedup race between poll ticks. This human-button trigger avoids
// both by construction: there is no row to go stale and no poll loop to race,
// because a run only ever starts in response to one explicit click, gated by
// the same Accept-gate PIN as every other gate action. The trade this makes
// is a bounded-but-long synchronous farmd call (real git merge + the repo's
// own test suite) instead of an async dispatch — FARM_CONFLICT_RESOLVE_TIMEOUT_MS
// (config.js) is what bounds that trade.
//
// HZ-154 adds a narrow middle path INSIDE the same call: farmd may now resolve
// the conflicted hunks themselves (deterministically where the two sides
// edited different lines of the hunk, otherwise with a tool-restricted agent)
// and review only the resolution delta, rather than escalating every
// overlapping edit to a full re-implementation plus a full re-review of the
// whole PR. Everything above
// still holds: one human click, no row, no poll loop, no step_run write, and
// the item only ever comes back to this gate for a human. The reasons below
// grew a code per way that path can refuse — Python's own list is
// farm/conflict_resolver.py's ESCALATION_REASONS, and
// orchestrator-conflict-reason-parity.test.mjs holds the two in sync.
export const CONFLICT_ESCALATION_REASONS = {
  merge_conflict: 'both branches changed the same lines — needs a human or a full implement cycle to resolve',
  tests_failed: "the merge applied cleanly but the repo's own tests failed afterward",
  branch_missing: 'the PR branch could not be found on the remote',
  push_rejected: 'the branch changed on GitHub while resolving — try again',
  conflict_too_large: 'too many conflicted files or lines for a scoped fix — needs a full implement cycle',
  conflict_unsupported: 'the conflict is a rename, a deletion or a binary clash — needs a full implement cycle',
  resolution_unsure: 'the resolution agent reported it could not be sure of the fix',
  resolution_out_of_scope: 'the resolution changed code outside the conflicted regions — rejected, nothing pushed',
  markers_remaining: 'conflict markers were still present after the resolution — rejected, nothing pushed',
  scoped_review_rejected: 'the scoped review of the resolution rejected it',
  scoped_checks_failed: "the conflicted hunks were resolved but the repo's own checks then failed",
}

// The success line for the scoped path: names the files and hunks that were
// resolved and the scoped review's verdict, so the event log answers "what
// exactly changed, and who said it was fine" without opening the PR.
function scopedResolutionText(pr, result) {
  const { strategy, hunks, paths = [] } = result.resolution || {}
  const review = result.review || {}
  const how = strategy === 'deterministic' ? 'both sides kept, no agent needed' : 'resolved by an agent'
  const verdict =
    review.reviewed === false
      ? review.summary || 'no agent review — the resolution used only parent lines'
      : `scoped review ${review.verdict === 'pass' ? 'passed' : 'failed'}: ${review.summary || 'no summary'}`
  return (
    `resolved ${hunks || 0} conflicted hunk(s) on PR #${pr} in ${paths.join(', ') || 'the PR branch'} (${how}) — ` +
    `${verdict} — no re-implementation and no re-review of the rest of the PR (${result.summary || 'pushed'})`
  )
}

// HZ-188: one resolver run per item. Each click used to start another farmd
// resolver in the same worktree, and they reset each other's merges. This map
// is the server half of the guard (farmd's item_lock is the other, and holds
// on its own); it is also the item's visible progress — store.listItems()
// reads it as `conflictRun`, so every tab, and a reloaded page, sees a run in
// progress. Memory-only on purpose (HZ-92: no row to go stale): a restart
// forgets it, and farmd's lock still refuses a duplicate in that window.
// resolveConflicts() is the only writer, and its `finally` always moves the
// entry out of `running`, so a timed-out or crashed call never leaves the
// item locked.
//
// state: running → resolved | escalated (sent back to implement, with the
// reason — including farmd unreachable or timed out) | failed (nothing ran
// and nothing was sent back — farmd reported another writer owns the item,
// or this code threw).
const conflictRuns = new Map()

export function getConflictRun(id) {
  return conflictRuns.get(id) || null
}

registerConflictRunProvider(getConflictRun)

const FARM_ITEM_BUSY_REASON = "another run is still using this item's workspace — nothing was started, try again once it finishes"

export async function resolveConflicts(id, actor = 'You') {
  const item = getItem(id)
  if (!item) return { error: 'not_found' }
  if (isClosed(item) || isAbandoned(item)) return { error: 'closed' }
  if (item.cursor !== ACCEPT_GATE_INDEX) return { error: 'not_at_accept_gate' }
  if (!item.repo || item.pr == null) return { error: 'no_pr' }
  // getItem() returns the raw work_item row (unlike store.listItems(), which
  // booleanizes this column for the UI) — 0 is "GitHub reports conflicts",
  // 1 is mergeable, NULL is unknown/not yet computed.
  if (item.pr_mergeable !== 0) return { error: 'not_conflicted' }
  if (!FARM_URL && cannedConflictReply === null) return { error: 'farm_unavailable' }
  if (conflictRuns.get(id)?.state === 'running') return { error: 'resolve_in_progress' }

  conflictRuns.set(id, { state: 'running', since: new Date().toISOString(), reason: null })
  notifyChange()
  let outcome = { state: 'failed', reason: 'conflict resolution stopped unexpectedly' }
  try {
    const run = await runConflictResolution(id, item, actor)
    outcome = { state: run.state, reason: run.reason }
    return run.result
  } finally {
    conflictRuns.set(id, { ...outcome, since: new Date().toISOString() })
    notifyChange()
  }
}

// The resolver call itself; returns { result, state, reason } — the route's
// reply plus the conflictRun outcome resolveConflicts() records.
async function runConflictResolution(id, item, actor) {
  const branch = `horizon/${id.toLowerCase()}`
  let result
  try {
    result =
      cannedConflictReply !== null
        ? takeCannedConflictReply()
        : await farmFetch(
            '/conflicts/resolve',
            { item: { id, repo: item.repo }, branch },
            { timeoutMs: FARM_CONFLICT_RESOLVE_TIMEOUT_MS },
          )
  } catch (err) {
    // farmd's item_lock is held — another resolver or an implement/review
    // step owns the worktree. Not a failed resolution: nothing ran, so
    // nothing is sent back. Every other farm refusal (farm_not_running is
    // also a 409) keeps the escalation below.
    if (err.status === 409 && err.code === 'resolve_in_progress') {
      return { result: { error: 'resolve_in_progress' }, state: 'failed', reason: FARM_ITEM_BUSY_REASON }
    }
    const reason = `automatic conflict resolution could not run (${err.message})`
    requestChanges(id, 'Accept the code', `PR #${item.pr}: ${reason}`, actor)
    return { result: { ok: true, resolved: false, escalated: true, reason }, state: 'escalated', reason }
  }

  if (result.resolved) {
    // The mechanical text stays byte-identical: only farmd reporting
    // mode: 'scoped' switches to the richer line.
    addEvent(id, {
      who: 'Horizon',
      text:
        result.mode === 'scoped'
          ? scopedResolutionText(item.pr, result)
          : `resolved merge conflicts on PR #${item.pr} mechanically — no re-implementation needed (${result.summary || 'merged and pushed'})`,
      color: '#0E6E74',
      initials: 'RS',
    })
    return {
      result:
        result.mode === 'scoped'
          ? { ok: true, resolved: true, mode: 'scoped', review: result.review || null }
          : { ok: true, resolved: true },
      state: 'resolved',
      reason: null,
    }
  }

  const reason = CONFLICT_ESCALATION_REASONS[result.reason] || result.detail || 'conflict resolution could not complete automatically'
  requestChanges(id, 'Accept the code', `PR #${item.pr}: ${reason}`, actor)
  return { result: { ok: true, resolved: false, escalated: true, reason }, state: 'escalated', reason }
}

function projectPayload(projectId) {
  const project = db.prepare('SELECT * FROM project WHERE id = ?').get(projectId)
  const repos = db.prepare('SELECT repo, prefix FROM project_repo WHERE project_id = ?').all(projectId)
  return { project: { id: project.id, name: project.name }, repos, token: getToken() }
}

async function waitForFarmRunning() {
  const deadline = Date.now() + FARM_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const status = await farmFetch('/farm/status')
    if (status.status === 'running') return
    if (status.status === 'error') throw new Error(`farm failed to start: ${status.error}`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  throw new Error('farm did not become ready in time')
}

async function startRealFarm(projectId, log) {
  farm = { status: 'restarting', since: new Date().toISOString() }
  notifyChange()
  try {
    await farmFetch('/farm/start', projectPayload(projectId))
    await waitForFarmRunning()
    farm = { status: 'running', since: new Date().toISOString() }
    const resumed = resumeActiveItems()
    log?.info(`Farm up for project ${projectId}; resumed ${resumed} item(s)`)
  } catch (err) {
    log?.warn(`Farm start failed: ${err.message}`)
    farm = { status: 'error', error: err.message, since: new Date().toISOString() }
  }
  notifyChange()
}

// Called at boot and when the active project's farm should exist but doesn't.
export function ensureFarm(log) {
  if (!FARM_URL) return
  const activeId = getActiveProjectId()
  if (!activeId || farm.status === 'restarting') return
  if (farm.status === 'running' && farm.projectId === activeId) return
  farm.projectId = activeId
  startRealFarm(activeId, log).then(() => {
    farm.projectId = activeId
  })
}

export function switchProject(projectId, log) {
  // Agents down: cancel every in-flight step across all items. Snapshot
  // dispatching first — cancel() mutates it as each item is cancelled.
  for (const id of [...dispatching]) cancel(id, 'superseded')
  setSetting('active_project_id', String(projectId))

  if (FARM_URL) {
    farm.projectId = projectId
    ;(async () => {
      try {
        await farmFetch('/farm/stop', {})
      } catch {
        // farm may already be down; start will surface real problems
      }
      await startRealFarm(projectId, log)
    })()
    return
  }

  // No real farm configured: simulate the restart as before.
  farm = { status: 'restarting', since: new Date().toISOString() }
  notifyChange()
  log?.info(`Bot farm restarting with project ${projectId} context (${RESTART_MS}ms simulated)`)
  setTimeout(() => {
    farm = { status: 'running', since: new Date().toISOString() }
    const resumed = resumeActiveItems()
    log?.info(`Bot farm up for project ${projectId}; resumed ${resumed} item(s)`)
    notifyChange()
  }, RESTART_MS).unref()
}

function projectActive(item) {
  const activeId = getActiveProjectId()
  return item.project_id == null || activeId == null || item.project_id === activeId
}

function resumeActiveItems() {
  let resumed = 0
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) {
    const item = getItem(id)
    if (runnable(item)) {
      kick(id)
      resumed++
    }
  }
  return resumed
}

// Lets tests/e2e specs drive the mock review through the fail-then-retry-
// then-pass loop deterministically: fails the first N cycles (counted from
// work_item.review_cycle_count, the same counter the real cap enforcement
// reads), then passes. 0 (default) never fails.
const MOCK_REVIEW_FAIL_COUNT = Number(process.env.MOCK_REVIEW_FAIL_COUNT) || 0

const MOCK_QA_PASS = { verdict: 'pass', regression_tests_run: true, new_code_unit_coverage: true, e2e_test_present: true, findings: [] }

// Mock behavior per step label (HZ-117: keyed by label, not index — the
// pipeline's step identities are fixed, see domain/steps.json; an insertion
// elsewhere in STEPS must never repoint one of these at the wrong step).
// Returns { summary, patch? } where patch updates work_item fields, mimicking
// the artifacts each agent is supposed to produce.
export const MOCK_STEP_BEHAVIOR = {
  'Define the outcome': (it) => {
    const result = it.desc
      ? { summary: 'refined the outcome statement from the issue description', patch: {} }
      : { summary: 'drafted an outcome statement for gate review', patch: { desc: `Deliver: ${it.title}` } }
    // Propose the Eng specialist persona once; never re-propose over a set
    // value — it may be a human's choice (the server-side no-clobber is the
    // real guard). Only the Eng slot is proposed: the other agents' personas
    // default and the human picks them at the gate (same rule as the real PM
    // agent's, see farm/roles/pm.md).
    if (!it.personas?.[PRIMARY_PERSONA_AGENT]) {
      const persona = proposePersona(it, PRIMARY_PERSONA_AGENT)
      result.patch.personas = { [PRIMARY_PERSONA_AGENT]: persona }
      result.summary += ` — proposed the ${personaLabel(PRIMARY_PERSONA_AGENT, persona)} persona (confirm at the gate)`
    }
    if (Object.keys(result.patch).length === 0) delete result.patch
    return result
  },
  'Define how we measure success': (it) =>
    it.metric
      ? { summary: 'validated the success metric is measurable' }
      : {
          summary: 'drafted a success metric for gate review',
          patch: { metric: `Draft — define a measurable target for “${it.title}” (confirm at the gate)` },
        },
  'Set guardrails': (it) =>
    it.guardrails
      ? { summary: 'confirmed guardrails; defaults also apply' }
      : {
          summary: 'set draft guardrails',
          patch: { guardrails: 'Draft — defaults apply: tests, linters and e2e must pass; no destructive data changes.' },
        },
  'Plan options & trade-offs (pros / cons)': () => ({
    summary: 'prepared options A/B/C with trade-offs; recommends B (robust, medium effort)',
  }),
  'Draft implementation plan': () => ({ summary: 'drafted the implementation plan: components touched, sequencing, test impact' }),
  'Architecture review': () => ({ summary: 'architecture review passed — no encapsulation or duplication concerns' }),
  'QA reviews the test plan': () => ({ summary: 'test plan covers the success metric; added two edge cases' }),
  // The digest must never imply a decision — in demo mode there is no real PM
  // review, and only the human decides at the gate that follows.
  'Summarize reviews & recommend': () => ({
    summary: 'review digest unavailable in demo mode — a human must decide at the next gate',
  }),
  // Execute: the code change takes the form of a GitHub PR. The mock commits
  // a placeholder file; the PR/branch mechanics are the real integration.
  'Specialist agent implements': async (it) => {
    if (!it.repo || it.issue == null) {
      return { summary: 'implementation complete on a feature branch; all checks green (no GitHub — PR skipped)' }
    }
    if (it.pr != null) {
      return { summary: `implementation updated — PR #${it.pr} still open for review` }
    }
    try {
      const pr = await createMockPr(it)
      return {
        summary: `implementation complete — opened PR #${pr.number} for the “Accept the code” gate`,
        patch: { pr: pr.number, pr_url: pr.html_url },
      }
    } catch (err) {
      return { summary: `implementation complete, but opening the PR failed: ${err.message}` }
    }
  },
  // Automated review (HZ-30): read-only code + QA review of the diff the
  // implement step just produced. MOCK_REVIEW_FAIL_COUNT makes this
  // deterministically fail its first N cycles (driven by the same
  // review_cycle_count column the real cap enforcement reads), so the
  // fail -> re-implement -> pass loop is exercisable without a real farm.
  'Automated review (code + QA)': (it) => {
    if ((it.review_cycle_count || 0) < MOCK_REVIEW_FAIL_COUNT) {
      return {
        summary: 'automated review found a guardrail violation — sent back to implement (mock)',
        verdict: {
          code_review: {
            verdict: 'fail',
            findings: [{ file: '(mock)', line: 1, severity: 'block', detail: 'mock guardrail violation for loop testing' }],
          },
          qa_review: MOCK_QA_PASS,
        },
      }
    }
    return {
      summary: 'automated review passed — code and QA both clear (mock)',
      verdict: { code_review: { verdict: 'pass', findings: [] }, qa_review: MOCK_QA_PASS },
    }
  },
  // Deploy: publish a GitHub Release, which the self-deploy webhook
  // (server/src/deploy.js) picks up to pull the tag onto shoreward.ai. The
  // mock is the deploy content, not the plumbing.
  'Deploy the changes': async (it) => {
    if (!it.repo || it.issue == null) {
      return { summary: 'deployed to the target environment; smoke checks passed (no GitHub — release skipped)' }
    }
    try {
      const release = await createDeployRelease(it)
      return {
        summary: `published release ${release.tag_name}${release.addedWorkflow ? ' (and added the Horizon Deploy workflow to the repo)' : ''} — the self-deploy webhook will pull it to shoreward.ai`,
        patch: { release_tag: release.tag_name, release_url: release.html_url },
      }
    } catch (err) {
      return { summary: `deploy simulated, but publishing the release failed: ${err.message}` }
    }
  },
}

function runnable(item) {
  return (
    farm.status === 'running' &&
    item &&
    projectActive(item) &&
    !isClosed(item) &&
    !isAbandoned(item) &&
    !item.paused &&
    !item.rejected &&
    STEPS[item.cursor].kind === 'agent' &&
    !isBlocked(blockersOf(item.id))
  )
}

export function kick(id, opts = {}) {
  const item = getItem(id)
  if (!runnable(item) || dispatching.has(id)) return
  dispatching.add(id)

  const stepIndex = item.cursor
  const step = STEPS[stepIndex]
  const attempt =
    db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM step_run WHERE item_id = ? AND step_index = ?').get(
      id,
      stepIndex,
    ).n
  const autoRetryCount = opts.autoRetryCount || 0
  const runId = db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent, auto_retry_count) VALUES (?, ?, ?, ?, ?)')
    .run(id, stepIndex, attempt, step.agent, autoRetryCount).lastInsertRowid

  if (FARM_URL && FARM_STEP_INDEXES.has(stepIndex)) {
    dispatchToFarm(id, stepIndex, runId, attempt)
  } else {
    timers[runId] = setTimeout(() => runMockStep(id, stepIndex, runId), latency())
  }
}

// ---- farm-dispatched steps ----

async function dispatchToFarm(id, stepIndex, runId, attempt) {
  const step = STEPS[stepIndex]
  let item = getItem(id)

  // Queue watchdog: bounds how long a step may sit queued behind other work
  // before the farm actually launches an agent on it. Deliberately NOT
  // step-type-dependent (queue delay is about farm contention, not what the
  // step does) and deliberately much shorter than the execution budget below
  // — if the farm never calls back to confirm a launch (POST .../started),
  // this is what catches a step that's stuck in the queue (or a farm that's
  // down, or a lost task file) within a bounded window (HZ-57).
  timers[runId] = setTimeout(
    () => failFarmRun(runId, 'step was never picked up by the farm', REASON.NEVER_PICKED_UP),
    FARM_QUEUE_TIMEOUT_MS,
  )

  // Deploy's real side effect — publishing the GitHub release that the
  // self-deploy webhook picks up — needs the GitHub token, which only this
  // Node process holds; the farm never gets it. So this side publishes the
  // release itself, BEFORE handing the step to the farm, and the farm's
  // DevOps agent only does what it actually has the credentials and tools
  // for: deep post-deploy verification of the already-published release.
  let releaseFields = {}
  if (stepIndex === DEPLOY_STEP_INDEX && item.repo && item.issue != null) {
    try {
      const release = await createDeployRelease(item)
      releaseFields = { release_tag: release.tag_name, release_url: release.html_url }
      db.prepare("UPDATE work_item SET release_tag = ?, release_url = ?, updated_at = datetime('now') WHERE id = ?").run(
        release.tag_name,
        release.html_url,
        id,
      )
    } catch (err) {
      return failFarmRun(runId, `publishing the release failed: ${err.message}`)
    }
    // The world may have changed while awaiting the GitHub call (a human
    // could have cancelled/rejected the item) — re-check before dispatching.
    if (!runStillActive(runId)) return
    item = getItem(id)
  }

  // Undelivered human feedback rides along and is considered delivered.
  const feedback = db
    .prepare('SELECT message, target, created_at FROM feedback WHERE item_id = ? AND delivered_at IS NULL')
    .all(id)
  if (feedback.length > 0) {
    db.prepare("UPDATE feedback SET delivered_at = datetime('now') WHERE item_id = ? AND delivered_at IS NULL").run(id)
  }

  // Prior artifacts (options analysis, impl plan, reviews) give later agents
  // their working context — the implement step reads the approved plan, and
  // the review step reads the implement step's check-runner evidence (its
  // pass/fail note lives in step_run.output, not artifact, since implement
  // never sets artifact — without the OR clause the QA reviewer would never
  // see proof that regression tests actually ran). Keep only the
  // most-recently-completed row per step_index: a re-run step's superseded
  // attempt must not ride along next to the current one. Only steps BEFORE
  // this one count as prior: after a send-back, the item's earlier cycle
  // left done artifacts at and after this step (e.g. step 8's own old QA
  // verdict and step 9's summary of it). Feeding those back biases the
  // re-review toward its own stale conclusion and, on HZ-128, pushed the
  // total 3 chars over budget so HZ-105 refused the required plan forever.
  const rows = db
    .prepare(
      `SELECT step_index, artifact, output FROM step_run
       WHERE item_id = ? AND status = 'done' AND (artifact IS NOT NULL OR step_index = ?)
         AND step_index < ?
         AND id IN (
           SELECT MAX(id) FROM step_run
           WHERE item_id = ? AND status = 'done' AND (artifact IS NOT NULL OR step_index = ?)
           GROUP BY step_index
         )
       ORDER BY id`,
    )
    .all(id, IMPLEMENT_STEP_INDEX, stepIndex, id, IMPLEMENT_STEP_INDEX)
    .map((row) => ({ step_index: row.step_index, artifact: row.artifact ?? row.output ?? '' }))
  const budgeted = budgetArtifacts(rows)

  // HZ-105: a step whose `requires` names a prior artifact must never review
  // it half-shown — the exact HZ-102 failure shape was a reviewer judging a
  // quarter of an implementation plan and reporting the rest as absent. If
  // the budget allocator had to truncate a required artifact, stop here:
  // no dispatch, no verdict, no artifact. failFarmRun pauses the item and
  // names the artifact, its full size, and the shortfall — a capacity
  // decision for a human, never auto-retried (see AUTO_RETRY_REASONS).
  const missingRequired = missingRequiredInputs(step, rows, budgeted)
  if (missingRequired.length > 0) {
    const detail = missingRequired
      .map((m) => `"${m.label}" needs ${m.fullLen} chars, only ${m.gotLen} could be supplied (${m.fullLen - m.gotLen} short)`)
      .join('; ')
    return failFarmRun(runId, `required input incomplete: ${detail}`, REASON.REQUIRED_INPUT_INCOMPLETE)
  }

  const artifacts = budgeted.map(({ label, content }) => ({ label, content }))
  const truncatedLabels = budgeted.filter((a) => a.truncated).map((a) => a.label)
  if (truncatedLabels.length > 0) {
    addEvent(id, {
      who: 'Horizon',
      text: `artifact truncated for context budget: ${truncatedLabels.join(', ')}`,
      color: '#9C333E',
      initials: 'HZ',
    })
  }

  farmFetch('/steps/run', {
    run_id: runId,
    attempt,
    artifacts,
    item: {
      id: item.id,
      title: item.title,
      desc: item.desc,
      metric: item.metric,
      guardrails: item.guardrails,
      priority: item.priority,
      repo: item.repo,
      issue: item.issue,
      personas: item.personas,
      ...releaseFields,
    },
    step: { index: stepIndex, label: step.label, agent: step.agent },
    feedback,
  }).catch((err) => {
    failFarmRun(runId, `could not hand the step to the farm: ${err.message}`, REASON.UNREACHABLE)
  })
}

// Called from POST /api/farm/steps/:runId/started, pushed by farmd the
// moment it actually claims a queued task (ephemeral dispatch or the PM
// queue) — see farm/farmd.py's _notify_started. Flips the watchdog from the
// queue-wait timer to the real execution budget, timed from now rather than
// from dispatch. A cancelled/completed/stale run reports back `active:
// false` so the farm knows NOT to launch it (HZ-57) — runStillActive's same
// status check, reused here, is what keeps a cancelled run cancelled.
//
// Idempotent: a duplicate started POST (farmd retrying after a lost reply)
// must not reset an already-running execution timer back to full duration.
export function markFarmRunStarted(runId) {
  const run = db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
  if (!run || run.status !== 'active') return { ok: true, active: false }
  if (run.agent_started_at) return { ok: true, active: true }

  clearTimeout(timers[runId])
  db.prepare("UPDATE step_run SET agent_started_at = datetime('now') WHERE id = ?").run(runId)
  const executionMs = executionBudgetFor(run.step_index)
  timers[runId] = setTimeout(() => failFarmRun(runId, 'step timed out', REASON.TIMEOUT), executionMs)
  return { ok: true, active: true }
}

// Which work_item columns an agent may patch — DERIVED from domain/fields.json
// (HZ-134), the same document farm/pm_agent.py builds its PATCH_FIELDS from, so
// the two sides of the wire cannot disagree about which fields exist. Only the
// key list is needed here: the limits themselves are enforced agent-side, at the
// point the over-long value is produced, where a marker can still be attached.
//
// `personas` is deliberately NOT in this list and never will be: since HZ-125 it
// is an { agent: persona id } object rather than a text column, so it is
// validated and written separately (see completeFarmRun and writeWorkItemPatch
// below). That is also why domain/fields.json marks the legacy `persona` column
// agentRevisable: false — nothing reaches it through this loop any more.
const FARM_PATCH_FIELDS = Object.keys(patchLimits())
// Display copy, deliberately NOT in domain/ (guardrail 5): these are the names a
// human reads in the GitHub step comment, not part of the field model. A
// patchable field missing from this map is written to the database but silently
// omitted from the comment, so domain-fields-consumers.test.mjs drives
// stepCommentBody with every patchable column set and asserts each one renders.
const PATCH_FIELD_LABELS = { desc: 'Outcome', metric: 'Success metric', guardrails: 'Guardrails', personas: 'Specialist personas' }

// Applies a completed step's patch to the item. Split out because `personas` is
// an object that merges into one JSON column while every other field is a plain
// column assignment — building `SET <key> = ?` straight off the patch keys (as
// both callers used to) would emit `SET personas = ?` and fail.
function writeWorkItemPatch(id, item, patch) {
  const fields = Object.keys(patch || {}).filter((f) => f !== 'personas')
  const assignments = fields.map((f) => `${f} = ?`)
  const values = fields.map((f) => patch[f])
  if (patch?.personas) {
    // Merge, never replace: a patch that proposes an eng persona must not drop
    // the qa persona a human already chose.
    assignments.push('personas_json = ?')
    values.push(JSON.stringify({ ...item.personas, ...patch.personas }))
  }
  if (assignments.length === 0) return
  db.prepare(`UPDATE work_item SET ${assignments.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
    ...values,
    id,
  )
}

// Exported for tests: the comment body is the human-readable record, so its
// rendering (e.g. persona labels, never raw ids) is pinned directly.
export function stepCommentBody(item, stepIndex, attempt, summary, patch, isMock, artifactMd) {
  const step = STEPS[stepIndex]
  const agent = AGENTS[step.agent]
  const lines = [`### 🤖 ${agent.label} — ${step.label}`, '', summary]
  const changed = Object.keys(patch || {}).filter((k) => PATCH_FIELD_LABELS[k])
  if (changed.length > 0) {
    lines.push('', '**Updated fields:**')
    for (const key of changed) {
      const shown =
        key === 'personas'
          ? Object.entries(patch.personas)
              .map(([agent, persona]) => `${agent} — ${personaLabel(agent, persona)}`)
              .join(', ')
          : patch[key]
      lines.push(`- **${PATCH_FIELD_LABELS[key]}:** ${shown}`)
    }
  }
  if (artifactMd) {
    lines.push('', '---', '', artifactMd.slice(0, 60000)) // GitHub's comment cap is 65536
  }
  lines.push(
    '',
    `_${PHASES[step.phase]} phase · attempt ${attempt}${isMock ? ' · mock agent' : ''} · [open in Horizon](${UI_URL}/${item.id.toLowerCase()}) · posted by Horizon_`,
  )
  return lines.join('\n')
}

// Every completed agent step is mirrored onto the GitHub issue — the issue
// thread is the human-readable record of what the bots did.
function postStepComment(item, stepIndex, attempt, summary, patch, isMock, artifactMd) {
  if (!item.repo || item.issue == null) return
  postIssueComment(item, stepCommentBody(item, stepIndex, attempt, summary, patch, isMock, artifactMd)).catch((err) => {
    addEvent(item.id, {
      who: 'Horizon',
      text: `could not post the step result to issue #${item.issue}: ${err.message}`,
      color: '#9C333E',
      initials: 'HZ',
    })
    notifyChange()
  })
}

// ---- automated review verdict (HZ-30) ----
// The reviewer is read-only (its farm tool allowlist has no Edit/Write/Bash)
// and structured JSON, validated HERE by the script — never trusted from the
// agent's prose, and never able to approve the human gate itself.

const VERDICT_VALUES = new Set(['pass', 'fail'])
const QA_BOOLEAN_FLAGS = ['regression_tests_run', 'new_code_unit_coverage', 'e2e_test_present']

// Exported for tests. A malformed/missing verdict is an infra/format
// problem, not a guardrail violation — the caller routes it to failFarmRun
// (pause for a human), which does NOT consume a review cycle.
export function validateVerdict(v) {
  if (!v || typeof v !== 'object') return false
  for (const key of ['code_review', 'qa_review']) {
    const section = v[key]
    if (!section || typeof section !== 'object' || !VERDICT_VALUES.has(section.verdict)) return false
  }
  return QA_BOOLEAN_FLAGS.every((flag) => typeof v.qa_review[flag] === 'boolean')
}

// Exported for tests. Compact, file/line-referenced feedback for whichever
// sub-pass(es) failed — this is what the implement step's next attempt reads
// as "Human feedback to address" (build_prompt in farm/step_agent.py).
export function formatReviewFeedback(verdict, cycle) {
  const lines = [`Automated review cycle ${cycle}/${REVIEW_CYCLE_CAP} failed — fix and re-implement.`]
  for (const [key, label] of [['code_review', 'Code review'], ['qa_review', 'QA review']]) {
    const section = verdict[key]
    if (section.verdict !== 'fail') continue
    lines.push('', `${label} findings:`)
    const findings = Array.isArray(section.findings) ? section.findings : []
    if (findings.length === 0) lines.push('- (no specific findings provided)')
    for (const f of findings.slice(0, 10)) {
      const loc = f?.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'general'
      lines.push(`- **${loc}** — ${f?.detail || f?.severity || 'issue flagged'}`)
    }
    if (key === 'qa_review') {
      const missing = QA_BOOLEAN_FLAGS.filter((flag) => section[flag] === false)
      if (missing.length > 0) lines.push(`- missing: ${missing.join(', ')}`)
    }
  }
  return lines.join('\n').slice(0, 2000)
}

// A markdown rendering so the mock path (no real agent artifact_md) still
// gives the human gate and the GitHub issue something to read.
function mockReviewArtifactMd(verdict) {
  const section = (label, s) =>
    `## ${label}\n**${s.verdict}**` + (s.verdict === 'fail' ? `\n- ${s.findings?.[0]?.detail || 'guardrail violation'}` : '')
  return [section('Code review', verdict.code_review), '', section('QA review', verdict.qa_review)].join('\n')
}

// Shared by completeFarmRun (real farm) and runMockStep (demo mode) so the
// pass/fail/cap routing is identical either way — verdict already validated
// by the caller. Closes the step_run row itself, then either advances the
// cursor (pass), rolls back to implement with feedback queued (fail, under
// cap), or force-advances to the human gate with the failing verdict still
// attached (fail, cap reached) — the loop counter that proves the cap is
// enforced lives in work_item.review_cycle_count, read back by tests.
function finalizeReviewStep(id, runId, text, artifactMd, verdict, patch, isMock) {
  // This run has fully completed by the time we're called (no more awaits
  // pending on it) — safe to release the busy mutex before any of the three
  // branches below calls kick() for the item's next step.
  dispatching.delete(id)
  const step = STEPS[REVIEW_STEP_INDEX]
  const agent = AGENTS[step.agent]
  const attempt = db.prepare('SELECT attempt FROM step_run WHERE id = ?').get(runId)?.attempt || 1
  db.prepare("UPDATE step_run SET status = 'done', output = ?, artifact = ?, ended_at = datetime('now') WHERE id = ?").run(
    text,
    artifactMd,
    runId,
  )

  const passed = verdict.code_review.verdict === 'pass' && verdict.qa_review.verdict === 'pass'
  if (passed) {
    db.prepare("UPDATE work_item SET cursor = cursor + 1, updated_at = datetime('now') WHERE id = ?").run(id)
    addEvent(id, { who: agent.label, text: `completed “${step.label}” — ${text.slice(0, 300)}`, color: agent.color, initials: agent.initials })
    postStepComment(getItem(id), REVIEW_STEP_INDEX, attempt, text, patch, isMock, artifactMd)
    notifyChange()
    kick(id)
    return
  }

  db.prepare("UPDATE work_item SET review_cycle_count = review_cycle_count + 1, updated_at = datetime('now') WHERE id = ?").run(id)
  const cycle = db.prepare('SELECT review_cycle_count FROM work_item WHERE id = ?').get(id).review_cycle_count

  if (cycle >= REVIEW_CYCLE_CAP) {
    db.prepare("UPDATE work_item SET cursor = cursor + 1, updated_at = datetime('now') WHERE id = ?").run(id)
    addEvent(id, {
      who: 'Horizon',
      text: `automated review cap (${REVIEW_CYCLE_CAP}) reached — forwarded to the human gate with the failing verdict attached`,
      color: '#9C333E',
      initials: 'HZ',
    })
    postStepComment(getItem(id), REVIEW_STEP_INDEX, attempt, text, patch, isMock, artifactMd)
    notifyChange()
    kick(id)
    return
  }

  db.prepare('INSERT INTO feedback (item_id, target, message) VALUES (?, ?, ?)').run(
    id,
    STEPS[IMPLEMENT_STEP_INDEX].agent,
    formatReviewFeedback(verdict, cycle),
  )
  db.prepare("UPDATE work_item SET cursor = ?, updated_at = datetime('now') WHERE id = ?").run(IMPLEMENT_STEP_INDEX, id)
  addEvent(id, {
    who: agent.label,
    text: `automated review failed (cycle ${cycle}/${REVIEW_CYCLE_CAP}) — sent back to “${STEPS[IMPLEMENT_STEP_INDEX].label}”`,
    color: '#9C333E',
    initials: agent.initials,
  })
  postStepComment(getItem(id), REVIEW_STEP_INDEX, attempt, text, patch, isMock, artifactMd)
  notifyChange()
  kick(id)
}

// ---- deploy verdict (HZ-22) ----
// The release itself is already published by the time this runs (JS side,
// dispatchToFarm) — this is the DevOps agent's deep-verification gate: did
// the deployed site actually render, not just answer 200. Reuses the same
// pass/fail enum as the automated review verdict.

// Exported for tests, same shape/rationale as validateVerdict: a malformed
// reply is an infra/format problem, not a real deploy failure, so the caller
// routes it to failFarmRun (pause for a human) rather than treating it as a
// failed deploy.
export function validateDeployVerdict(v) {
  return !!v && typeof v === 'object' && VERDICT_VALUES.has(v.verdict)
}

// A failing deploy verdict has no analogous "retry loop" the way code review
// does (redeploying isn't re-implementing) — it just pauses the item for a
// human to decide (rollback, redeploy, investigate), same as failFarmRun,
// but keeps the step_run's artifact/summary evidence instead of discarding it.
function finalizeDeployStep(id, runId, text, artifactMd, verdict, patch) {
  dispatching.delete(id) // this run is fully complete — no more awaits pending on it
  const step = STEPS[DEPLOY_STEP_INDEX]
  const agent = AGENTS[step.agent]
  const attempt = db.prepare('SELECT attempt FROM step_run WHERE id = ?').get(runId)?.attempt || 1
  db.prepare("UPDATE step_run SET status = 'done', output = ?, artifact = ?, ended_at = datetime('now') WHERE id = ?").run(
    text,
    artifactMd,
    runId,
  )

  if (verdict.verdict !== 'pass') {
    db.prepare("UPDATE work_item SET paused = 1, updated_at = datetime('now') WHERE id = ?").run(id)
    addEvent(id, {
      who: agent.label,
      text: `deploy verification failed — ${text.slice(0, 300)} — item paused; resume to redeploy`,
      color: '#9C333E',
      initials: agent.initials,
    })
    postStepComment(getItem(id), DEPLOY_STEP_INDEX, attempt, text, patch, false, artifactMd)
    notifyChange()
    return
  }

  db.prepare("UPDATE work_item SET cursor = cursor + 1, updated_at = datetime('now') WHERE id = ?").run(id)
  addEvent(id, { who: agent.label, text: `completed “${step.label}” — ${text.slice(0, 300)}`, color: agent.color, initials: agent.initials })
  postStepComment(getItem(id), DEPLOY_STEP_INDEX, attempt, text, patch, false, artifactMd)
  notifyChange()
  kick(id)
}

export async function completeFarmRun(runId, { summary, patch, artifacts }) {
  const run = db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
  if (!run || run.status !== 'active') return { ok: true, stale: true }
  const id = run.item_id
  const item = getItem(id)

  clearTimeout(timers[runId])
  delete timers[runId]

  if (!item || item.cursor !== run.step_index || !runnable(item)) {
    dispatching.delete(id)
    closeActiveRuns(id, 'superseded')
    return { ok: true, stale: true }
  }

  const cleanPatch = {}
  for (const field of FARM_PATCH_FIELDS) {
    if (typeof patch?.[field] === 'string' && patch[field].trim()) cleanPatch[field] = patch[field].trim()
  }
  // Persona patches are dropped (not failed) when invalid, and when the item
  // already carries one for that agent — a set value may be a human's gate-time
  // choice, and the farm must never clobber it. The run itself still completes.
  // Per-agent since HZ-125: a proposal for the qa slot still lands on an item
  // whose eng slot a human already set.
  if (patch?.personas && typeof patch.personas === 'object' && !Array.isArray(patch.personas)) {
    const survivors = {}
    for (const [agent, persona] of Object.entries(patch.personas)) {
      if (isPersona(agent, persona) && !item.personas?.[agent]) survivors[agent] = persona
    }
    if (Object.keys(survivors).length > 0) cleanPatch.personas = survivors
  }
  writeWorkItemPatch(id, item, cleanPatch)

  const step = STEPS[run.step_index]
  const agent = AGENTS[step.agent]
  let text = String(summary || 'completed the step').slice(0, 600)

  // The implement step's artifact is a pushed branch: this side owns turning
  // it into the PR. If that fails, the step fails — no PR, no advance.
  if (typeof artifacts?.branch === 'string' && item.repo && item.issue != null) {
    try {
      const pr = await createPrFromBranch(item, artifacts.branch)
      db.prepare("UPDATE work_item SET pr = ?, pr_url = ?, updated_at = datetime('now') WHERE id = ?").run(
        pr.number,
        pr.html_url,
        id,
      )
      text = `${text} — opened PR #${pr.number}${artifacts.files_changed ? ` (${artifacts.files_changed})` : ''}`.slice(0, 700)
    } catch (err) {
      return failFarmRun(runId, `code pushed to ${artifacts.branch} but the PR could not be opened: ${err.message}`)
    }
  }

  const artifactMd =
    typeof artifacts?.artifact_md === 'string' ? artifacts.artifact_md.slice(0, WRITE_TIME_SANITY_CEILING_CHARS) : null

  if (run.step_index === REVIEW_STEP_INDEX) {
    if (!validateVerdict(artifacts?.verdict)) return failFarmRun(runId, 'malformed review verdict JSON')
    finalizeReviewStep(id, runId, text, artifactMd, artifacts.verdict, cleanPatch, false)
    return { ok: true }
  }

  if (run.step_index === DEPLOY_STEP_INDEX) {
    if (!validateDeployVerdict(artifacts?.verdict)) return failFarmRun(runId, 'malformed deploy verdict JSON')
    finalizeDeployStep(id, runId, text, artifactMd, artifacts.verdict, cleanPatch)
    return { ok: true }
  }

  // HZ-102 provenance: farm/step_agent.py only sets these two fields when a
  // persona forced a non-default provider for this step (PERSONA_PROVIDERS
  // ships empty per HZ-121, so today this only happens via a test-registered
  // fixture persona) — every other step keeps writing NULL here, unchanged
  // from before this column existed.
  const provider =
    typeof artifacts?.provider === 'string' && artifacts.provider.trim() ? artifacts.provider.trim() : null
  const commandId =
    typeof artifacts?.command_id === 'string' && artifacts.command_id.trim() ? artifacts.command_id.trim() : null

  db.prepare(
    "UPDATE step_run SET status = 'done', output = ?, artifact = ?, provider = ?, command_id = ?, ended_at = datetime('now') WHERE id = ?",
  ).run(text, artifactMd, provider, commandId, runId)
  db.prepare("UPDATE work_item SET cursor = cursor + 1, updated_at = datetime('now') WHERE id = ?").run(id)
  addEvent(id, { who: agent.label, text: `completed “${step.label}” — ${text.slice(0, 300)}`, color: agent.color, initials: agent.initials })
  postStepComment(getItem(id), run.step_index, run.attempt, text, cleanPatch, false, artifactMd)
  notifyChange()
  dispatching.delete(id)
  kick(id)
  return { ok: true }
}

// reason is one of AUTO_RETRY_REASONS's tags (assigned by the call site that
// detected the failure) or null/unrecognized — only a tagged reason, under
// the cap, on a still-runnable item is ever auto-retried. Everything else
// pauses for a human exactly as it always has (HZ-76's default-safe rule).
export function failFarmRun(runId, error, reason = null) {
  const run = db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
  if (!run || run.status !== 'active') return { ok: true, stale: true }
  const id = run.item_id

  clearTimeout(timers[runId])
  delete timers[runId]
  dispatching.delete(id) // this run is now terminal — release before any retry kick() below re-acquires it

  // No 'failed' status in older DBs' CHECK constraint — record as cancelled
  // with a FAILED-prefixed output, and say why.
  db.prepare(
    "UPDATE step_run SET status = 'cancelled', output = ?, ended_at = datetime('now') WHERE id = ?",
  ).run(`FAILED: ${String(error).slice(0, 300)}`, runId)
  // Tell the farm too (same call cancel() makes): a step failed here by
  // either watchdog firing (queue or execution) may still be sitting queued
  // or running on the farm side. Without this, farmd can claim and launch a
  // task file whose run the server has already given up on (HZ-57) — the
  // /started callback double-checks this too, but a run failed before it
  // ever reaches that checkpoint needs the task file removed directly.
  if (FARM_URL) farmFetch('/steps/cancel', { run_id: runId }).catch(() => {})

  const retryable = reason != null && AUTO_RETRY_REASONS.has(reason) && runnable(getItem(id))

  if (retryable && run.auto_retry_count < AUTO_RETRY_CAP) {
    const nextCount = run.auto_retry_count + 1
    addEvent(id, {
      who: 'Horizon',
      text: `transient failure (${reason}): ${String(error).slice(0, 200)} — auto-retrying (${nextCount}/${AUTO_RETRY_CAP})`,
      color: '#DFA200',
      initials: 'HZ',
    })
    notifyChange()
    kick(id, { autoRetryCount: nextCount })
    return { ok: true, retried: true }
  }

  db.prepare("UPDATE work_item SET paused = 1, updated_at = datetime('now') WHERE id = ?").run(id)
  // Mirrors the `(${reason})` tag already used for the auto-retrying event
  // above — empty when reason is null, so the untagged wording below stays
  // byte-identical to what existing consumers already parse (HZ-94).
  const reasonTag = reason != null ? ` (${reason})` : ''
  addEvent(id, {
    who: 'Horizon',
    text: retryable
      ? `agent step failed${reasonTag}: ${String(error).slice(0, 200)} — auto-retry budget (${AUTO_RETRY_CAP}) exhausted; item paused, resume to retry`
      : `agent step failed${reasonTag}: ${String(error).slice(0, 200)} — item paused; resume to retry`,
    color: '#9C333E',
    initials: 'HZ',
  })
  notifyChange()
  return { ok: true }
}

// A run only completes if its own step_run row is still active — cancel/
// reject/restart flip that row's status, which safely no-ops the in-flight run
// even if it was mid-await (e.g. creating a PR) when the human acted.
function runStillActive(runId) {
  return db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId)?.status === 'active'
}

async function runMockStep(id, stepIndex, runId) {
  // The dispatch timer already fired to get us here — nothing left to watch.
  // dispatching (the busy mutex) stays held until this run fully exits, so a
  // concurrent kick() can't start a duplicate run across the awaits below.
  delete timers[runId]
  const item = getItem(id)
  // Re-validate: the world may have changed while the "agent" was working.
  if (!runnable(item) || item.cursor !== stepIndex || !runStillActive(runId)) {
    dispatching.delete(id)
    closeActiveRuns(id, 'superseded')
    return
  }

  const step = STEPS[stepIndex]
  const agent = AGENTS[step.agent]
  const behavior = MOCK_STEP_BEHAVIOR[step.label] || (() => ({ summary: `completed ${step.label.toLowerCase()}` }))
  let { summary, patch, verdict } = await behavior(item)

  // Deliver any queued human feedback to this "agent" — the mock acknowledges
  // it in its output; a real agent gets it injected into its session.
  const pendingFeedback = db
    .prepare('SELECT id, message FROM feedback WHERE item_id = ? AND delivered_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(id)
  if (pendingFeedback) {
    db.prepare("UPDATE feedback SET delivered_at = datetime('now') WHERE item_id = ? AND delivered_at IS NULL").run(id)
    summary = `addressed your feedback (“${pendingFeedback.message.slice(0, 80)}”) — ${summary}`
  }

  // Re-check after any await (e.g. PR creation): a pause/reject may have landed.
  const after = getItem(id)
  if (!runnable(after) || after.cursor !== stepIndex || !runStillActive(runId)) {
    dispatching.delete(id)
    if (runStillActive(runId)) closeActiveRuns(id, 'superseded')
    return
  }

  if (patch) writeWorkItemPatch(id, after, patch)

  if (stepIndex === REVIEW_STEP_INDEX) {
    // finalizeReviewStep releases the busy mutex itself before it calls kick().
    finalizeReviewStep(id, runId, summary, mockReviewArtifactMd(verdict), verdict, patch, true)
    return
  }

  db.prepare("UPDATE step_run SET status = 'done', output = ?, ended_at = datetime('now') WHERE id = ?").run(
    summary,
    runId,
  )
  db.prepare("UPDATE work_item SET cursor = cursor + 1, updated_at = datetime('now') WHERE id = ?").run(id)
  addEvent(id, {
    who: agent.label,
    text: `completed “${step.label}” — ${summary}`,
    color: agent.color,
    initials: agent.initials,
  })
  const attempt = db.prepare('SELECT attempt FROM step_run WHERE id = ?').get(runId)?.attempt || 1
  postStepComment(getItem(id), stepIndex, attempt, summary, patch, true)
  notifyChange()
  dispatching.delete(id)
  kick(id) // next step, until a gate/closure
}

function closeActiveRuns(id, status) {
  db.prepare("UPDATE step_run SET status = ?, ended_at = datetime('now') WHERE item_id = ? AND status = 'active'").run(
    status,
    id,
  )
}

// Called by the store when a human halts work mid-step. The farm is told to
// kill the run's session too — a superseded attempt must not keep burning
// tokens or race its replacement on the shared horizon/<item-id> branch.
export function cancel(id, status = 'cancelled') {
  const activeRuns = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND status = 'active'").all(id)
  for (const run of activeRuns) {
    clearTimeout(timers[run.id])
    delete timers[run.id]
  }
  dispatching.delete(id)
  closeActiveRuns(id, status)
  if (FARM_URL) {
    for (const run of activeRuns) {
      farmFetch('/steps/cancel', { run_id: run.id }).catch(() => {})
    }
  }
}

// ---- durable reconciliation (HZ-100) ----
// timers[] lives only in this process's memory — a run whose watchdog was
// somehow lost (the item-keyed clobbering bug fixed above, a future bug, a
// process crash and a rearm that itself throws for one row) can sit `active`
// forever with nothing watching it. HZ-93's run 640 sat active for 16
// minutes next to an idle, healthy farm; it moved only when a human failed
// it by hand.
//
// This sweep is the DB-backed backstop, independent of any in-memory timer:
// any `active` step_run with no local timer (rearmFarmRuns/dispatchToFarm/
// markFarmRunStarted already cover the rows that DO have one — those are
// left strictly alone, timer or no farm check) is checked against the farm
// directly. The farm's own claim (still queued, or a live session) is proof
// of life; only a run the farm explicitly cannot vouch for is failed —
// through the exact same failFarmRun path (and the same already-tagged
// 'never_picked_up' reason) the queue watchdog above already uses, so
// HZ-76's default-safe auto-retry rule is never widened.
let reconcileInFlight = false

export async function reconcileActiveRuns() {
  if (!FARM_URL || reconcileInFlight) return { checked: 0, failed: 0 }
  reconcileInFlight = true
  try {
    const candidates = db
      .prepare("SELECT id FROM step_run WHERE status = 'active'")
      .all()
      .filter((run) => !timers[run.id])
    if (candidates.length === 0) return { checked: 0, failed: 0 }

    let alive
    try {
      const data = await farmFetch('/runs/alive', { run_ids: candidates.map((r) => String(r.id)) })
      alive = data.alive || {}
    } catch {
      // An unreachable farm is not evidence of death — leave every candidate
      // alone; the next sweep tries again.
      return { checked: candidates.length, failed: 0 }
    }

    let failed = 0
    for (const { id: runId } of candidates) {
      // Proof of life from the farm, or a timer that got armed while this
      // sweep was awaiting the farm call — either way, leave it alone.
      if (alive[String(runId)] || timers[runId]) continue
      failFarmRun(
        runId,
        'step_run left active with no local timer, no farm claim, and no live agent session',
        REASON.NEVER_PICKED_UP,
      )
      failed++
    }
    return { checked: candidates.length, failed }
  } finally {
    reconcileInFlight = false
  }
}

export async function init(log) {
  registerAgentRunner({ kick, cancel })
  // store.js reads this to attach {state, reason} onto activeRun in
  // listItems() — a plain object lookup, never a network call, so
  // snapshot()/listItems() stay synchronous (HZ-54).
  registerRunStateProvider(() => farm.runStates || {})
  // Default the active project to the first one if never chosen.
  if (!getSetting('active_project_id')) {
    const first = db.prepare('SELECT id FROM project ORDER BY id LIMIT 1').get()
    if (first) setSetting('active_project_id', String(first.id))
  }
  if (FARM_URL) {
    // Ask the farm about every currently-active row BEFORE rearmFarmRuns()
    // below gives each one a local timer. rearmFarmRuns() arms one
    // unconditionally for every active row — even one the farm never picked
    // up gets a generous fallback timer, HZ-57's deliberate pre-migration
    // safety valve — so once it has run, reconcileActiveRuns()'s own
    // `!timers[run.id]` filter finds nothing and a boot-time call after it
    // is theatre: dead for exactly the row shape (agent_started_at unset,
    // i.e. never confirmed started) this sweep exists to catch. Awaiting it
    // here first lets a genuinely abandoned row fail fast via never_picked_up
    // instead of sitting under rearm's fallback until that timer expires.
    const swept = await reconcileActiveRuns()
    if (swept.failed > 0) log.info(`Reconcile sweep failed ${swept.failed} stranded run(s) at boot`)
    // Farm runs SURVIVE a server restart — the agents live in tmux, not in
    // this process. Re-arm their watchdogs instead of superseding them.
    // Skips any row the sweep above already re-dispatched (that retry's own
    // kick() already armed its own, correctly-scoped timer) — otherwise this
    // would clobber it with an execution-budget timer instead of the shorter
    // queue watchdog a freshly-dispatched run actually needs.
    const rearmed = rearmFarmRuns()
    if (rearmed > 0) log.info(`Re-armed watchdogs for ${rearmed} in-flight farm run(s)`)
    setInterval(pollRunStates, RUN_STATE_POLL_MS).unref()
    // Re-probe a farm we've lost contact with. startRealFarm() pins
    // status:'error' when it can't reach farmd, and runnable() refuses to
    // dispatch anything while that holds — so a transient outage stops ALL
    // work until someone restarts this process, with nothing in the UI saying
    // why. That is not hypothetical: a deploy restarts the farm, the server
    // reaches for it mid-restart, gets 'fetch failed', and latches.
    // ensureFarm() already returns immediately when the farm is healthy, so
    // this only does work while something is actually wrong.
    setInterval(() => ensureFarm(log), FARM_RECOVERY_POLL_MS).unref()
    // The interval that catches a timer lost later, while the process keeps
    // running — the boot-time case is now handled by the awaited call above.
    setInterval(reconcileActiveRuns, RECONCILE_SWEEP_MS).unref()
  } else {
    // Mock runs die with this process: close them; resume will re-kick.
    closeAllOrphanedRuns()
  }
  const recovered = recoverRejectedItems()
  if (recovered > 0) log.info(`Requeued ${recovered} rejected item(s) for rework`)
  if (FARM_URL) {
    // Real farm: don't resume items until the farm reports ready.
    ensureFarm(log)
  } else {
    const resumed = resumeActiveItems()
    if (resumed > 0) log.info(`Orchestrator resumed ${resumed} item(s) mid-agent-step`)
  }
}

// Exported for tests: server-restart re-arming is the other half of HZ-57's
// fix (dispatch-time bookkeeping is easy to get right once; surviving a
// redeploy without resetting or dropping the ceiling is the part that's easy
// to get subtly wrong — see the two cases commented inline below).
export function rearmFarmRuns() {
  const active = db
    .prepare("SELECT id, item_id, step_index, agent_started_at, started_at FROM step_run WHERE status = 'active'")
    .all()
    // A row that already has a timer was just (re-)dispatched by something
    // else already running in this process — most notably, init()'s reconcile
    // sweep retrying a row it just failed. That dispatch already armed its
    // own correctly-scoped timer; overwriting it here with an execution-budget
    // timer would both leak the original setTimeout and give a freshly-queued
    // run the wrong watchdog.
    .filter((run) => !timers[run.id])
  for (const run of active) {
    // agent_started_at set: the execution clock was already running — arm
    // the REMAINING budget, not a fresh grant. A server restart (redeploy
    // restarts horizon-server directly) must not reset a long implement
    // step's ceiling back to full duration every time it happens (HZ-57).
    //
    // agent_started_at NULL: either genuinely still queued, or an active row
    // from before this column existed — a step already executing when this
    // fix deploys never gets a (now unreachable) late /started call, so it
    // would look indistinguishable from "never picked up". Fall back to
    // started_at (dispatch time) with the full execution budget rather than
    // the shorter queue budget: the pre-migration case must not be killed
    // right after the very deploy meant to stop premature cancellation. The
    // cost is a genuinely-still-queued step gets a more generous — but still
    // bounded — window than usual on a restart.
    const anchor = run.agent_started_at || run.started_at
    const elapsedMs = Date.now() - new Date(anchor).getTime()
    const remainingMs = Math.max(0, executionBudgetFor(run.step_index) - elapsedMs)
    timers[run.id] = setTimeout(() => failFarmRun(run.id, 'step timed out', REASON.TIMEOUT), remainingMs)
    // Re-key removed the free busy-mutex side effect timers[item_id] used to
    // give kick() — without this, a restart would leave every one of these
    // items looking idle and resumeActiveItems()/a human resume could
    // dispatch a second run right on top of the one just re-armed above.
    dispatching.add(run.item_id)
  }
  return active.length
}

function closeAllOrphanedRuns() {
  db.prepare("UPDATE step_run SET status = 'superseded', ended_at = datetime('now') WHERE status = 'active'").run()
}
