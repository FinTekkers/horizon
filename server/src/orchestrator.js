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

import http from 'node:http'
import https from 'node:https'
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
  itemKindOf,
  kindStepIndex,
  EXECUTE_STEP_INDEX,
} from '../../domain/js/lifecycle.js'
import { AUTO_RETRY_REASONS, REASON } from '../../domain/js/reasons.js'
import { patchLimits, addedCriteriaLines } from '../../domain/js/fields.js'
import {
  getItem,
  addEvent,
  notifyChange,
  registerAgentRunner,
  registerRunStateProvider,
  claimGateAction,
  finishGateAction,
  getConflictRun as conflictRunOf,
  sweepGateActions,
  recoverRejectedItems,
  blockersOf,
  requestChanges,
  reviewRejected,
  isProjectEnabled,
  setProjectEnabled as writeProjectEnabled,
  getRepoCheckCommands,
  getRepoConfig,
  implementStartedBefore,
  CHECKS_WAIVER,
  recordCheckPass,
  CHECKS_PASSED_SHA_KEY,
  CHECKS_FINISHED_AT_KEY,
  stepSlug,
  providerDefaultsFromRow,
  resolveStepProviders,
  approvedPlanCheck,
} from './store.js'
import { createMockPr, createDeployRelease, postIssueComment, syncIssueBodyFields, createPrFromBranch, getPrHeadSha } from './github.js'
import { PHASES } from '../../domain/js/lifecycle.js'
import { getActiveProjectId, getFarmProjectId, getSetting, setSetting, getToken } from './settings.js'
import {
  FARM_URL,
  FARM_STEP_INDEXES,
  FARM_STEP_TIMEOUT_MS,
  DEPLOY_WAIT_MS,
  FARM_QUEUE_TIMEOUT_MS,
  FARM_START_TIMEOUT_MS,
  FARM_CONFLICT_RESOLVE_TIMEOUT_MS,
  PAUSE_CHECKPOINT_TIMEOUT_S,
  GATE_ACTION_SWEEP_MS,
  RECONCILE_SWEEP_MS,
  UI_URL,
  FIX_PASS_ENABLED,
  FIX_PASS_TURN_DIVISOR,
  FIX_PASS_MAX_LINES,
  REVIEW_CYCLE_CAP,
} from './config.js'
import { PRIMARY_PERSONA_AGENT, isPersona, personaLabel, proposePersona } from './personas.js'
import { SUMMARIZE_STEP_INDEX, OVERLAP_INPUT_LABEL, computeOverlap, overlapFailure, applyOverlap } from './overlapService.js'
import { renderOverlapInput, renderOverlapSection, replaceOverlapSection } from './overlap.js'
import { DEPLOY_BLOCK_MESSAGE, isDeployBlocked, onDrainEnd } from './deployDrain.js'
import { deployWaitFor } from './deployWait.js'
import * as deployQueue from './deployQueue.js'
import { findTargetByRepo } from './deployTargets.js'
import { deploySkipArtifact, deploySkipReason } from './deploySkip.js'
import { servedRulesFor } from './rulesStore.js'
import { OPTIONS_STEP_INDEX, proposeSplit } from './split.js'
import { awaitsSpawnedCode, hasSpawned, linkSpawned, requestKeyFor, spawnItems, spawnRuleOf, spawnedCodeLive, validateSpawnSpec } from './spawn.js'
import { recordFlakes } from './checkFlakes.js'
import { splitCheckError } from './checkHeadline.js'
import { recordTestRuns } from './testResults.js'
import { enqueueRuleBlockPing } from './ruleBlock.js'
import { buildStoredResultsInput, storedResultsPending, waitForStoredResults } from './storedTestResults.js'

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

// HZ-185: items a human is forwarding from a rejected review to Accept the
// code. Held from before the implement run is cancelled until the forward
// lands or is refused, so a second click is refused and kick() cannot start
// a fresh implement run in the window between cancel and the cursor move.
// Memory-only on purpose: a restart forgets it.
const forwarding = new Set()

// HZ-194: item id -> the promise of its pause's farm call, while a paused
// run may still be pushing its WIP checkpoint. kick() and stopActiveRuns()
// wait on it, so neither a resumed attempt nor a reject-forward's PR-head
// read (HZ-185) can run before that push lands. Memory-only, like
// forwarding: a restart forgets it, and farmd's own bound still ends the save.
const pausing = new Map()

// HZ-321: item id -> the kick() opts of a dispatch held back while a
// self-deploy drains (deployDrain.js). Released by releaseDeployHeld() when
// the drain ends without a restart; a restart forgets it, and boot's
// resumeActiveItems() dispatches the same items again.
const heldForDeploy = new Map()

// Execution budget once an agent has actually started (HZ-57): the implement
// step legitimately runs long (real coding + tests), so its budget must
// outlast the farm's own 40-minute step timeout. Shared by dispatch-time
// arming, the /started callback, and restart re-arming so the three can't
// drift apart.
// HZ-275: the Deploy step first waits up to DEPLOY_WAIT_MS for its release
// to go live, so its budget is that wait on top of the usual one.
export function executionBudgetFor(stepIndex) {
  if (stepIndex === IMPLEMENT_STEP_INDEX) return Math.max(FARM_STEP_TIMEOUT_MS, 50 * 60 * 1000)
  if (stepIndex === DEPLOY_STEP_INDEX) return FARM_STEP_TIMEOUT_MS + DEPLOY_WAIT_MS
  return FARM_STEP_TIMEOUT_MS
}

// Hard cap enforced HERE, by the orchestrator, never by an agent prompt — a
// reviewer that keeps failing forwards the item to the human gate with the
// failing verdict attached rather than looping forever (HZ-30). The value
// lives in config.js (REVIEW_CYCLE_CAP), so the caretaker reads the same one.

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
// HZ-207: one farm runs every enabled project's items at once; each step
// carries its own project and repo. Enabling or disabling a project is a
// flag write — it never restarts the farm or cancels a step.

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
// `requires` at all, which is most steps). HZ-383: each label resolves in the
// item's own kind, so a Task step's `requires` never names a change row.
export function missingRequiredInputs(step, rows, budgeted, kind = 'change') {
  return (step.requires || [])
    .map((label) => {
      const reqIndex = kindStepIndex(label, kind)
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

// HZ-221: Node's built-in fetch (undici) gives up after 300s waiting for
// response headers, whatever our AbortController says — and farmd answers
// /conflicts/resolve only once the repo's whole suite has run. A call allowed
// to wait at least that long goes via node:http instead, which has no header
// ceiling; every shorter call stays on fetch, unchanged.
export const FARM_FETCH_HEADER_CEILING_MS = 300_000
let farmFetchHeaderCeilingMs = FARM_FETCH_HEADER_CEILING_MS

// Test-only: lowers the ceiling so a test can cross it in milliseconds rather
// than waiting out the real 300s. null restores the default. Nothing under
// src/ calls this (farm-fetch-long-call.test.mjs pins that).
export function setFarmFetchHeaderCeilingForTest(ms) {
  farmFetchHeaderCeilingMs = ms == null ? FARM_FETCH_HEADER_CEILING_MS : ms
}

export function farmFetchTransport(timeoutMs) {
  return timeoutMs < farmFetchHeaderCeilingMs ? 'fetch' : 'http'
}

// A minimal fetch-shaped request over node:http(s), for farmFetch's long
// calls. It deliberately fakes fetch's own failures — an AbortError on
// timeout, TypeError('fetch failed') on a network error — so farmFetch's
// catch and every caller see exactly what they see from fetch. Unlike fetch,
// whose abort timer stops once headers arrive, timeoutMs here bounds the
// whole exchange, body included: it is the only limit, and on expiry the
// request and its socket are destroyed. agent: false leaves no keep-alive
// socket behind.
function farmHttpRequest(url, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const fail = (err) => settle(reject, new TypeError('fetch failed', { cause: err }))
    const { protocol } = new URL(url)
    const req = (protocol === 'https:' ? https : http).request(url, { method, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('error', fail)
      res.on('end', () => {
        const status = res.statusCode
        const text = Buffer.concat(chunks).toString('utf8')
        settle(resolve, { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) })
      })
    })
    timer = setTimeout(() => {
      settle(reject, new DOMException('This operation was aborted', 'AbortError'))
      req.destroy()
    }, timeoutMs)
    req.on('error', fail)
    req.on('close', () => fail(new Error('socket closed before the response completed')))
    req.end(body)
  })
}

export async function farmFetch(path, body, { timeoutMs = DEFAULT_FARM_FETCH_TIMEOUT_MS } = {}) {
  const url = `${FARM_URL}${path}`
  const init = {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
  const viaFetch = farmFetchTransport(timeoutMs) === 'fetch'
  const controller = viaFetch ? new AbortController() : null
  const timer = viaFetch ? setTimeout(() => controller.abort(), timeoutMs) : null
  let res
  try {
    res = viaFetch
      ? await fetch(url, { ...init, signal: controller.signal })
      : await farmHttpRequest(url, { ...init, timeoutMs })
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
// resolver in the same worktree, and they reset each other's merges. The
// item's 'resolve' gate_action row (HZ-216, store.js) is the server half of
// the guard (farmd's item_lock is the other, and holds on its own); it is also
// the item's visible progress — store.listItems() reads it as `conflictRun`
// and `gateAction`, so every tab, and a reloaded page, sees a run in progress.
// Persisted since HZ-216, so a restart neither forgets a run nor allows a
// second one; its lease (FARM_CONFLICT_RESOLVE_TIMEOUT_MS plus a margin) and
// the sweep in init() end a run nobody finished. resolveConflicts() is the
// only claimer, and its `finally` always moves the row out of `running`, so a
// timed-out or crashed call never leaves the item locked.
//
// state: running → resolved | escalated (sent back to implement, with the
// reason — including farmd unreachable or timed out) | failed (nothing ran
// and nothing was sent back — farmd reported another writer owns the item,
// this code threw, or the lease ran out).
export function getConflictRun(id) {
  return conflictRunOf(id)
}

const FARM_ITEM_BUSY_REASON = "another run is still using this item's workspace — nothing was started, try again once it finishes"
// HZ-256: a self-deploy stopped the resolver (deployDrain.js). Nothing was pushed.
const FARM_RESOLVE_CANCELLED_REASON = 'a deploy stopped this run before it pushed anything — try again'

// HZ-235: autoResolve.js starts this same run when main moves. Its options
// change only what is recorded: startedBy on the lock row, the lock's detail,
// and one `startedEvent` line written once the claim succeeds (never for a
// refused call). The button's route passes none of them.
export async function resolveConflicts(id, actor = 'You', { startedBy = 'human', detail = null, startedEvent = null } = {}) {
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
  // HZ-250: no new run while a self-deploy drains (same tick as the claim).
  if (isDeployBlocked()) return { error: DEPLOY_BLOCK_MESSAGE }
  const claim = claimGateAction(id, 'resolve', {
    detail: detail ?? `resolving conflicts on PR #${item.pr}`,
    timeoutMs: FARM_CONFLICT_RESOLVE_TIMEOUT_MS,
    startedBy,
  })
  if (!claim) return { error: 'resolve_in_progress' }
  if (startedBy === 'main_moved' && startedEvent) {
    addEvent(id, { who: 'Horizon', text: startedEvent, color: '#0E6E74', initials: 'HZ' })
  }

  let outcome = { state: 'failed', reason: 'conflict resolution stopped unexpectedly' }
  try {
    const run = await runConflictResolution(id, item, actor)
    outcome = { state: run.state, reason: run.reason }
    return run.result
  } finally {
    finishGateAction(id, 'resolve', claim.token, outcome)
  }
}

// HZ-257: a farm report (implement artifacts, resolver reply) that names the
// exact pushed commit its checks passed on becomes a check_pass row. The repo
// is the item row's, never the payload's. A report without the fields, or a
// refused write, records nothing and changes nothing else.
function recordFarmCheckPass(item, report, source) {
  const sha = report?.[CHECKS_PASSED_SHA_KEY]
  if (sha === undefined || !item.repo) return
  recordCheckPass({ repo: item.repo, itemId: item.id, sha, finishedAt: report[CHECKS_FINISHED_AT_KEY], source })
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
            { item: { id, repo: item.repo }, branch, ...checkCommandsField(item) },
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
    // HZ-256: cancelled for a deploy — not an escalation either. The row is
    // already `interrupted`, so finishGateAction() below writes nothing.
    if (err.status === 409 && err.code === 'cancelled') {
      return { result: { error: 'cancelled' }, state: 'failed', reason: FARM_RESOLVE_CANCELLED_REASON }
    }
    const reason = `automatic conflict resolution could not run (${err.message})`
    requestChanges(id, 'Accept the code', `PR #${item.pr}: ${reason}`, actor)
    return { result: { ok: true, resolved: false, escalated: true, reason }, state: 'escalated', reason }
  }

  // HZ-327: the resolver's flakes and per-test results, resolved or not.
  recordFlakes({ itemId: id, source: 'conflict_resolver', flakes: result?.flakes })
  recordTestRuns({ itemId: id, source: 'conflict_resolver', testRuns: result?.test_runs })

  if (result.resolved) {
    recordFarmCheckPass(item, result, 'conflict_resolver')
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

// Called at boot and when the farm should exist but doesn't. farmd is started
// for the farm project (the concierge's, until HZ-209), never the board's, so
// switching the board can't restart it.
export function ensureFarm(log) {
  if (!FARM_URL) return
  const farmId = getFarmProjectId()
  if (!farmId || farm.status === 'restarting') return
  if (farm.status === 'running' && farm.projectId === farmId) return
  if (!getSetting('farm_project_id')) setSetting('farm_project_id', String(farmId))
  farm.projectId = farmId
  startRealFarm(farmId, log).then(() => {
    farm.projectId = farmId
  })
}

// HZ-207: a flag write. Enabling kicks the project's runnable items; disabling
// only stops new dispatch — nothing is cancelled, paused, re-queued or sent to
// the farm, in this project or any other. The farm project can't be disabled:
// the concierge is pinned to it until HZ-209.
export function setProjectEnabled(projectId, enabled, log) {
  if (!enabled && projectId === getFarmProjectId()) return { error: 'farm_project_cannot_be_disabled' }
  const written = writeProjectEnabled(projectId, enabled)
  if (written.error) return written
  if (enabled) {
    let kicked = 0
    for (const { id } of db.prepare('SELECT id FROM work_item WHERE project_id = ?').all(projectId)) {
      if (runnable(getItem(id))) {
        kick(id)
        kicked++
      }
    }
    log?.info(`Project ${projectId} enabled; kicked ${kicked} item(s)`)
  } else {
    log?.info(`Project ${projectId} disabled; its in-flight steps finish, no new ones start`)
  }
  return { ok: true, enabled: !!enabled }
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
  // HZ-383: a Task's three read-only planning steps. Each returns an artifact,
  // so demo mode shows the same "View full artifact" link the farm path does.
  Assess: () => ({
    summary: 'assessed the task: found the scripts it needs; no new code needed (mock)',
    artifact_md: '## Scripts found\n- (mock) none — demo mode\n\n## Code needed\n**none**',
  }),
  'Run plan': () => ({
    summary: 'planned 1 command in the repo root with a 5 minute budget (mock)',
    artifact_md:
      '## Commands\n1. `echo demo` (mock)\n\n## Dry run\nExpected output: `demo` — described, never executed\n\n' +
      '## Run plan block\n```json run-plan\n{"cwd": ".", "commands": ["echo demo"], "budget_minutes": 5}\n```',
  }),
  'Impact review': () => ({
    summary: 'impact review passed — no load, rate-limit or deploy-overlap concerns (mock)',
    artifact_md: '## Verdict\n**pass** (mock)\n\n## Undo\nNothing to undo in demo mode.',
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
    // HZ-304: this branch publishes a real release, so it is held to the same
    // rule as the farm path. runMockStep fails the run on `failure`.
    const failure = readinessFailure(it, DEPLOY_STEP_INDEX)
    if (failure) return { failure }
    // HZ-358: the same skip as the farm path, so demo mode matches it.
    const skip = deploySkipReason(it)
    if (skip) {
      clearReleaseFields(it.id)
      return { summary: skip }
    }
    try {
      const release = await createDeployRelease(it)
      return {
        summary: `published release ${release.tag_name} — the self-deploy webhook will pull it to shoreward.ai`,
        patch: { release_tag: release.tag_name, release_url: release.html_url },
      }
    } catch (err) {
      return { summary: `deploy simulated, but publishing the release failed: ${err.message}` }
    }
  },
}

// Whether an item may start a new step: its project must be enabled (HZ-207).
function runnable(item) {
  return inFlightRunnable(item) && isProjectEnabled(item.project_id)
}

// The check a step already in flight is held to. It sets the project's
// enabled flag aside, so disabling a project never discards a running step's
// result — the step finishes normally and only the next dispatch is held.
function inFlightRunnable(item) {
  return (
    farm.status === 'running' &&
    item &&
    !isClosed(item) &&
    !isAbandoned(item) &&
    !item.paused &&
    !item.rejected &&
    // HZ-346: a run stopped on a rule holds the item until a dependency it
    // gained closes, or a human resumes or sends it back (store.js).
    !item.rule_block_json &&
    STEPS[item.cursor].kind === 'agent' &&
    // HZ-377: a step with no runner waits where it is — it is never
    // dispatched, to the farm or to the mock path, so no run is ever recorded.
    STEPS[item.cursor].runsIn !== 'none' &&
    !isBlocked(blockersOf(item.id))
  )
}

export function kick(id, opts = {}) {
  // HZ-194: a resume right after a pause waits for the paused run's
  // checkpoint push, so the next attempt starts on it.
  const saving = pausing.get(id)
  if (saving) {
    saving.then(() => kick(id, opts))
    return
  }
  const item = getItem(id)
  if (!runnable(item) || dispatching.has(id) || forwarding.has(id)) return
  // HZ-321: no new step starts while a self-deploy drains. Held here, after
  // the runnable check, so failFarmRun's retry decision is unchanged.
  if (isDeployBlocked()) {
    heldForDeploy.set(id, opts)
    return
  }
  // HZ-333: Deploy joins its target's queue and publishes nothing; the queue
  // kicks it again once a batch containing its merge is live. Farm mode only:
  // the mock Deploy step keeps today's per-item release.
  if (FARM_URL && item.cursor === DEPLOY_STEP_INDEX && deployQueue.queueTargetFor(item) && !deployQueue.releasedEntryFor(id)) {
    deployQueue.join(item).catch((err) => console.warn(`deploy queue: ${id} could not join: ${err.message}`))
    return
  }
  // HZ-379: a step that waits for its item's spawned code starts only once
  // that code is live, and runs on the deployed commit. The check is async;
  // its answer comes back through kick(), so runnable() — and with it every
  // blocker — is checked again after the await.
  if (awaitsSpawnedCode(STEPS[item.cursor]) && !opts.spawnedCode && hasSpawned(id)) {
    holdForSpawnedCode(id, opts)
    return
  }
  spawnHolds.delete(id)
  clearTimeout(spawnRechecks.get(id))
  spawnRechecks.delete(id)
  dispatching.add(id)

  const stepIndex = item.cursor
  const step = STEPS[stepIndex]
  // HZ-321: a run a self-deploy stopped was never a finished attempt, so its
  // redispatch keeps that run's attempt and auto-retry count. HZ-346: nor is
  // a run a rule blocked — the block does not use up an attempt.
  const last = db
    .prepare(
      'SELECT attempt, auto_retry_count, deploy_interrupted, rule_blocked FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id DESC LIMIT 1',
    )
    .get(id, stepIndex)
  const keepsAttempt = last?.deploy_interrupted === 1 || last?.rule_blocked === 1
  const attempt = keepsAttempt
    ? last.attempt
    : db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM step_run WHERE item_id = ? AND step_index = ?').get(
        id,
        stepIndex,
      ).n
  const autoRetryCount = keepsAttempt ? last.auto_retry_count : opts.autoRetryCount || 0
  const toFarm = FARM_URL && FARM_STEP_INDEXES.has(stepIndex)
  // HZ-182: decided once, here, and stored on the run — completion reads the
  // scope the run was dispatched with, never a recomputation from the item.
  // Mock runs stay full: demo mode has no commits to scope a review to.
  const scope = toFarm ? scopeFor(item, stepIndex) : null
  const runId = db
    .prepare(
      'INSERT INTO step_run (item_id, step_index, attempt, agent, auto_retry_count, scope_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, stepIndex, attempt, step.agent, autoRetryCount, scope ? JSON.stringify(scope) : null).lastInsertRowid

  if (toFarm) {
    dispatchToFarm(id, stepIndex, runId, attempt, scope, opts.spawnedCode?.sha || null)
  } else {
    timers[runId] = setTimeout(() => runMockStep(id, stepIndex, runId), latency())
  }
}

// HZ-379: the hold in kick() above. One check per item at a time; a check
// that finds the code not live yet logs why once per reason and checks again
// in SPAWN_RECHECK_MS. A restart drops the timer, and init()'s
// resumeActiveItems() kicks the item again.
export const SPAWN_RECHECK_MS = 60 * 1000
const spawnChecking = new Set()
const spawnHolds = new Map() // item id -> the last reason logged
const spawnRechecks = new Map() // item id -> its one re-check timer

function holdForSpawnedCode(id, opts) {
  if (spawnChecking.has(id)) return
  spawnChecking.add(id)
  const item = getItem(id)
  const label = STEPS[item.cursor].label
  spawnedCodeLive(item)
    .then((live) => {
      spawnChecking.delete(id)
      if (live.ready) {
        kick(id, { ...opts, spawnedCode: { sha: live.sha } })
        return
      }
      if (spawnHolds.get(id) !== live.reason) {
        spawnHolds.set(id, live.reason)
        addEvent(id, {
          who: 'Horizon',
          text: `“${label}” waits for the code it asked for: ${live.reason}`,
          color: '#DFA200',
          initials: 'HZ',
        })
        notifyChange()
      }
      clearTimeout(spawnRechecks.get(id))
      spawnRechecks.set(id, setTimeout(() => kick(id, opts), SPAWN_RECHECK_MS).unref())
    })
    .catch((err) => {
      spawnChecking.delete(id)
      console.warn(`spawn: ${id} could not check its spawned code: ${err.message}`)
    })
}

// HZ-358: a skipped deploy leaves no release on the item.
function clearReleaseFields(id) {
  db.prepare("UPDATE work_item SET release_tag = NULL, release_url = NULL, updated_at = datetime('now') WHERE id = ?").run(id)
}

// ---- farm-dispatched steps ----

async function dispatchToFarm(id, stepIndex, runId, attempt, scope, checkoutSha = null) {
  const step = STEPS[stepIndex]
  let item = getItem(id)

  // HZ-304: an unready repo fails here, in this call — before the queue
  // watchdog below is armed and before a release is published or an agent
  // spent. No timer, no poll; the reason is untagged, so never auto-retried.
  const unready = readinessFailure(item, stepIndex)
  if (unready) return failFarmRun(runId, unready)

  // HZ-358: a repo marked 'no deploy' with no target has nothing to ship. No
  // release, no farm run: step 14 completes here as "not deployed". A tag
  // left by an earlier attempt is cleared so gate 15 shows none.
  const skip = stepIndex === DEPLOY_STEP_INDEX ? deploySkipReason(item) : null
  if (skip) {
    clearReleaseFields(id)
    return completeFarmRun(runId, {
      summary: skip,
      artifacts: { artifact_md: deploySkipArtifact(item), verdict: { verdict: 'pass' } },
    })
  }

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
  // HZ-275: where and how long the farm waits for this release to go live
  // before its smoke check. Absent for a repo with no deploy target.
  let deployWait = null
  const shipped = stepIndex === DEPLOY_STEP_INDEX ? deployQueue.releasedEntryFor(id) : null
  if (shipped) {
    // HZ-333: a deploy queue batch already published and deployed this
    // item's release; the wait bound counts from that deploy's start.
    releaseFields = { release_tag: shipped.tag, release_url: shipped.release_url }
    deployWait = deployWaitFor(item.repo, { startedAt: shipped.startedAtMs })
  } else if (stepIndex === DEPLOY_STEP_INDEX && item.repo && item.issue != null) {
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
    deployWait = deployWaitFor(item.repo)
  }

  // HZ-236: step 9 sees every other in-flight item's footprint and the
  // decision the server will apply. Context only: completeFarmRun recomputes
  // and applies. Awaited before the feedback stamp below, so a run cancelled
  // meanwhile never marks feedback delivered that it did not send.
  let overlapInput = null
  if (stepIndex === SUMMARIZE_STEP_INDEX) {
    let check
    try {
      check = await computeOverlap(id)
    } catch (err) {
      check = overlapFailure(id, err)
    }
    if (!runStillActive(runId)) return
    overlapInput = { label: OVERLAP_INPUT_LABEL, content: renderOverlapInput(check) }
  }

  // HZ-349: step 12 reads its test evidence from the stored per-test results,
  // never from the worktree. Waits only when the implement run's rows are
  // known to be on their way (farmd posts them just after the result).
  if (stepIndex === REVIEW_STEP_INDEX) {
    const pendingRunId = storedResultsPending(id)
    if (pendingRunId !== null) {
      await waitForStoredResults(id, pendingRunId)
      if (!runStillActive(runId)) return
    }
  }

  // HZ-204: built BEFORE the delivered_at stamp below, so this attempt's own
  // pending feedback rides in `feedback` only, never twice.
  const projectContext = step.runsIn === 'pm' ? buildProjectContext(id) : null

  // Undelivered human feedback rides along and is considered delivered.
  const feedback = db
    .prepare('SELECT message, target, created_at FROM feedback WHERE item_id = ? AND delivered_at IS NULL')
    .all(id)
  if (feedback.length > 0) {
    db.prepare(
      "UPDATE feedback SET delivered_at = datetime('now'), delivered_run_id = ? WHERE item_id = ? AND delivered_at IS NULL",
    ).run(runId, id)
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
  const missingRequired = missingRequiredInputs(step, rows, budgeted, itemKindOf(item))
  if (missingRequired.length > 0) {
    const detail = missingRequired
      .map((m) => `"${m.label}" needs ${m.fullLen} chars, only ${m.gotLen} could be supplied (${m.fullLen - m.gotLen} short)`)
      .join('; ')
    return failFarmRun(runId, `required input incomplete: ${detail}`, REASON.REQUIRED_INPUT_INCOMPLETE)
  }
  if (refuseUnapprovedRun(runId, id, stepIndex)) return

  const artifacts = budgeted.map(({ label, content }) => ({ label, content }))
  if (overlapInput) artifacts.push(overlapInput)
  if (stepIndex === REVIEW_STEP_INDEX) artifacts.push(buildStoredResultsInput(id))
  // HZ-207: every farm step carries its own project; farmd refuses one
  // without a project or repo and never falls back to a global project.
  const project =
    item.project_id == null
      ? null
      : db.prepare('SELECT id, name, provider_defaults_json FROM project WHERE id = ?').get(item.project_id)
  // HZ-188: an implement run on a PR GitHub reports as conflicted (a
  // resolve-conflicts escalation, or any other send-back while main has moved
  // underneath it) must start on a branch that already has origin/main merged
  // in — otherwise the agent reworks the old base and the conflict survives
  // (HZ-125, HZ-144). The farm does the merge and lists the conflicted files
  // in the prompt; this only says when. pr_mergeable is the raw column here:
  // 0 is "GitHub reports conflicts", null is unknown.
  const mergeMain = stepIndex === IMPLEMENT_STEP_INDEX && item.pr_mergeable === 0
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
      // HZ-383: farmd and step_agent pick the step's runner by kind and label.
      kind: itemKindOf(item),
      title: item.title,
      desc: item.desc,
      metric: item.metric,
      guardrails: item.guardrails,
      priority: item.priority,
      repo: item.repo,
      issue: item.issue,
      personas: item.personas,
      // HZ-357: copied into the task here, so a choice changed after this
      // hand-off applies to the next dispatch, never to this run. HZ-370:
      // merged with the project's defaults (the item's choice wins), copied
      // the same way; a step with neither keeps today's routing.
      providerChoices: resolveStepProviders(item.providerChoices, providerDefaultsFromRow(project)),
      ...releaseFields,
    },
    step: { index: stepIndex, label: step.label, agent: step.agent },
    ...(project ? { project: { id: project.id, name: project.name } } : {}),
    feedback,
    ...(mergeMain ? { merge_main: true } : {}),
    ...(deployWait ? { deploy_wait: deployWait } : {}),
    ...(scope ? { scope } : {}),
    // HZ-379: the deployed commit a step that waited for spawned code runs on.
    ...(checkoutSha ? { checkout_sha: checkoutSha } : {}),
    ...(projectContext ? { project_context: projectContext } : {}),
    ...checkCommandsField(item),
    ...rulesOverrideField(project?.name, item.repo),
  }).catch((err) => {
    // A refused task is not an unreachable farm: say why, and don't retry.
    if (err.status === 400 && Object.hasOwn(FARM_REFUSALS, err.code ?? '')) return failFarmRun(runId, FARM_REFUSALS[err.code])
    failFarmRun(runId, `could not hand the step to the farm: ${err.message}`, REASON.UNREACHABLE)
  })
}

// HZ-245: the repo's Admin-configured check commands ride with the task, read
// from the DB at dispatch. Absent (never null) when nothing is configured.
// HZ-304: then the farm's checks fail by name, unless checks_waiver rides too.
function checkCommandsField(item) {
  const checkCommands = getRepoCheckCommands(item.repo)
  if (checkCommands) return { check_commands: checkCommands }
  const waiver = checksWaiverFor(item)
  return waiver ? { checks_waiver: waiver } : {}
}

// ---- repo readiness (HZ-304) ----
// Horizon never silently builds or ships an unready repo. Both rules read the
// DB at the moment of dispatch; nothing is cached. An item with no repo (a
// demo item) is never judged.

// The named reason an implement or deploy step must not start, or null.
// Implement needs check commands, or the repo marked 'no checks'. Deploy
// needs a deploy_target row for the repo, or the repo marked 'no deploy' —
// whether or not the item has an issue. A target that exists but fails
// re-validation is not "missing": it takes the deploy path exactly as before.
export function readinessFailure(item, stepIndex) {
  if (!item?.repo) return null
  if (stepIndex === IMPLEMENT_STEP_INDEX) {
    const config = getRepoConfig(item.repo)
    if (config?.checks || config?.noChecks) return null
    return `no check commands configured for ${item.repo}`
  }
  if (stepIndex === DEPLOY_STEP_INDEX) {
    if (getRepoConfig(item.repo)?.noDeploy || findTargetByRepo(item.repo)) return null
    return `no deploy target configured for ${item.repo}`
  }
  return null
}

// Why a repo with no check commands may still run checks for this item, or
// null. Configured commands always win: no waiver is ever sent beside them.
// 'predates_enforcement' covers an item whose implement started before the
// repo was enforced: it may pre-merge and resolve conflicts as before. A
// send-back to implement still fails at dispatch (readinessFailure).
export function checksWaiverFor(item) {
  const config = item?.repo ? getRepoConfig(item.repo) : null
  if (!config || config.checks) return null
  if (config.noChecks) return CHECKS_WAIVER.NO_CHECKS
  if (implementStartedBefore(item.id, config.enforcedSince)) return CHECKS_WAIVER.PREDATES_ENFORCEMENT
  return null
}

// HZ-246: project/repo rules saved in Admin, read from the DB at dispatch
// (farmd refreshes them again when it claims the task). Absent when neither
// scope has DB rules, so farmd reads the files exactly as before and an older
// farm sees no new key.
function rulesOverrideField(projectName, repo) {
  const overrides = servedRulesFor(projectName, repo)
  return Object.keys(overrides).length > 0 ? { rules_override: overrides } : {}
}

// HZ-245: Admin's placeholders — what farmd's auto-detection finds for the
// repo on its hub clone. Read-only, short timeout; a farm that is off or
// unreachable yields available:false and the UI shows empty placeholders.
export async function fetchCheckDefaults(repo) {
  const empty = { available: false, defaults: { install: null, test: null, lint: null, e2e: null } }
  if (!FARM_URL) return empty
  try {
    const data = await farmFetch('/repos/check-defaults', { repo }, { timeoutMs: 5000 })
    return { available: true, defaults: { ...empty.defaults, ...(data.defaults || {}) } }
  } catch {
    return empty
  }
}

const FARM_REFUSALS = {
  'missing project': 'missing project: this item belongs to no project, so the farm cannot run it',
  'missing item.repo': 'missing repo: this item has no repository, so the farm cannot run it',
  'step kind mismatch': "step kind mismatch: this step does not belong to the item's kind",
}

// Agents whose steps run in the PM lane — derived, so a step moving lanes
// changes which feedback counts as PM-lane history.
const PM_LANE_AGENTS = [...new Set(STEPS.filter((s) => s.runsIn === 'pm').map((s) => s.agent))]
const PROJECT_CONTEXT_ITEMS = 10
const PROJECT_CONTEXT_FEEDBACK = 5

// HZ-204 (HZ-115 Stage 1): the explicit context a PM step gets in place of a
// resumed session's memory — other recent items in the same project and the
// latest human feedback already delivered to PM-lane steps. This only SELECTS
// rows; farm/pm_steps.py's render_project_context() owns all trimming and the
// size cap, so there is one owner for the budget.
//
// `rejected` is deliberately not filtered on: it means "sent back right now"
// (store.js resets it as the item advances), and those items are often the
// most relevant context. Abandoned items are dropped.
export function buildProjectContext(itemId) {
  const row = db.prepare('SELECT project_id FROM work_item WHERE id = ?').get(itemId)
  const projectId = row?.project_id ?? null
  const items = db
    .prepare(
      `SELECT id, title, "desc", updated_at FROM work_item
       WHERE project_id IS ? AND id <> ? AND abandoned_at IS NULL
       ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
    )
    .all(projectId, itemId, PROJECT_CONTEXT_ITEMS)
  const placeholders = PM_LANE_AGENTS.map(() => '?').join(', ')
  const feedback = PM_LANE_AGENTS.length
    ? db
        .prepare(
          `SELECT f.item_id, f.target, f.message, f.created_at
           FROM feedback f JOIN work_item w ON w.id = f.item_id
           WHERE w.project_id IS ? AND f.delivered_at IS NOT NULL AND f.target IN (${placeholders})
           ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
        )
        .all(projectId, ...PM_LANE_AGENTS, PROJECT_CONTEXT_FEEDBACK)
    : []
  return { items, feedback }
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
// (HZ-134), the same document farm/pm_steps.py builds its PATCH_FIELDS from, so
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
// The bound on an implement step's `## Manual checks` (HZ-345), the same one
// farm/step_agent.py applies before sending it.
const MANUAL_CHECKS_MAX_CHARS = 3000
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

// HZ-345: after "Review before execution" no agent adds a metric line or a
// guardrail. Only a human (the GitHub issue, synced by the webhook) or an
// Autopilot ruling (caretakerRuling.js) can, and neither comes through here:
// this runs on the two agent-patch paths only, so the actor is the code path,
// never anything the agent wrote. A field that would gain a line is dropped
// whole and the rest of the patch still applies. Moving lines into the
// "Deferred to a follow-up item" line adds none, so the split-scope rewrite
// still lands. An unchanged echo is never checked, so it logs nothing.
const EXECUTION_GATE_INDEX = requiredStepIndex('Review before execution')
const CRITERIA_FIELDS = ['metric', 'guardrails']

function lockCriteriaPatch(item, stepIndex, patch) {
  if (!patch || stepIndex <= EXECUTION_GATE_INDEX) return { patch, blocked: [] }
  const blocked = CRITERIA_FIELDS.filter(
    (field) =>
      typeof patch[field] === 'string' &&
      patch[field] !== item[field] &&
      addedCriteriaLines(item[field], patch[field]).length > 0,
  )
  if (blocked.length === 0) return { patch, blocked }
  const kept = { ...patch }
  for (const field of blocked) delete kept[field]
  return { patch: kept, blocked }
}

function applyCriteriaLock(id, item, stepIndex, patch) {
  const { patch: kept, blocked } = lockCriteriaPatch(item, stepIndex, patch)
  for (const field of blocked) {
    addEvent(id, {
      who: 'Horizon',
      text: `Kept ${field} unchanged: “${STEPS[stepIndex].label}” added a line after “${STEPS[EXECUTION_GATE_INDEX].label}”`,
      color: '#9C333E',
      initials: 'HZ',
    })
  }
  return kept
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
// Body text first, then the comment: the comment's webhook re-reads the body,
// so a refinement must already be in it (see syncIssueBodyFields).
const BODY_FIELDS = ['desc', 'metric', 'guardrails']
function postStepComment(item, stepIndex, attempt, summary, patch, isMock, artifactMd) {
  if (!item.repo || item.issue == null) return
  const touchesBody = !isMock && patch && BODY_FIELDS.some((f) => typeof patch[f] === 'string')
  const bodySynced = touchesBody
    ? syncIssueBodyFields(item).catch((err) => {
        addEvent(item.id, {
          who: 'Horizon',
          text: `could not update issue #${item.issue}'s body with the refined fields: ${err.message}`,
          color: '#9C333E',
          initials: 'HZ',
        })
      })
    : Promise.resolve()
  bodySynced.then(() => postIssueComment(item, stepCommentBody(item, stepIndex, attempt, summary, patch, isMock, artifactMd))).catch((err) => {
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

// ---- fix pass + delta review (HZ-182) ----
// A rejection used to restart a full implement run and a full review of the
// whole PR, and each re-review found unrelated new issues (HZ-124: rejected 7
// times). Now a rejection under the cap leads to a fix-only implement run on a
// third of the budget, then a review of only the commits since the last
// review, which must say whether each previous finding is resolved. Every
// decision below is made HERE; the farm only executes the scope it is handed.

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function storedFixFindings(item) {
  const findings = item.fix_findings_json ? parseJson(item.fix_findings_json) : null
  return Array.isArray(findings) ? findings : []
}

// Both scopes require the same state; anything missing means full mode. The
// first review of an item always lands here as full: last_reviewed_sha is only
// ever written by a completed review.
function fixPassReady(item) {
  return FIX_PASS_ENABLED && item.fix_pass === 1 && !!item.last_reviewed_sha && storedFixFindings(item).length > 0
}

// Exported for tests. The scope the next implement run is dispatched with.
export function implementScope(item) {
  if (!fixPassReady(item)) return { mode: 'full' }
  const step = STEPS[IMPLEMENT_STEP_INDEX]
  return {
    mode: 'fix',
    base_sha: item.last_reviewed_sha,
    max_turns: Math.floor(step.maxTurns / FIX_PASS_TURN_DIVISOR),
    timeout_s: Math.floor(step.timeoutS / FIX_PASS_TURN_DIVISOR),
    findings: storedFixFindings(item),
  }
}

// Exported for tests. The scope the next review is dispatched with. The
// implement completion clears fix_pass when the fix outgrew a delta review,
// so this needs no line count of its own.
export function reviewScope(item) {
  if (!fixPassReady(item)) return { mode: 'full' }
  return {
    mode: 'delta',
    base_sha: item.last_reviewed_sha,
    previous_findings: storedFixFindings(item).map((f, index) => ({ ...f, index })),
  }
}

function scopeFor(item, stepIndex) {
  if (stepIndex === IMPLEMENT_STEP_INDEX) return implementScope(item)
  if (stepIndex === REVIEW_STEP_INDEX) return reviewScope(item)
  return null
}

function runScope(run) {
  const scope = run.scope_json ? parseJson(run.scope_json) : null
  return scope && typeof scope === 'object' ? scope : { mode: 'full' }
}

// Exported for tests. A delta verdict is a full verdict plus ONE merged
// previous_findings array (the farm merges both reviewers fail-closed).
// Anything else is malformed: the caller routes it to failFarmRun, exactly as
// a malformed full verdict is today.
export function validateDeltaVerdict(v) {
  if (!validateVerdict(v) || !Array.isArray(v.previous_findings)) return false
  return v.previous_findings.every(
    (p) => p && typeof p === 'object' && Number.isInteger(p.index) && typeof p.resolved === 'boolean',
  )
}

const SECTION_LABELS = [['code_review', 'Code review'], ['qa_review', 'QA review']]

// The findings a full review rejected on, kept as the fix pass's record. A
// failing section with no block finding still yields one entry, so a fix pass
// never starts from an empty list.
function blockingFindings(verdict) {
  const blocks = []
  for (const [key, label] of SECTION_LABELS) {
    const section = verdict[key]
    if (section.verdict !== 'fail') continue
    const found = (Array.isArray(section.findings) ? section.findings : []).filter(
      (f) => f && typeof f === 'object' && f.severity !== 'note',
    )
    if (key === 'qa_review') {
      for (const flag of QA_BOOLEAN_FLAGS) if (section[flag] === false) found.push({ detail: `QA: ${flag} is false` })
    }
    if (found.length === 0) found.push({ detail: `${label} failed without a specific finding` })
    blocks.push(...found.map((f) => ({ file: typeof f.file === 'string' ? f.file : null, line: f.line ?? null, detail: String(f.detail || 'issue flagged') })))
  }
  return blocks
}

const normalizePath = (p) => p.replace(/^\.\//, '')

// Exported for tests. The note-versus-block rule of a delta review, in code.
// Blocks on exactly: a previous finding not reported `resolved: true`, a new
// finding in a file the fix diff changed, a new finding with no file (it
// cannot be placed outside the diff), a failing section with no findings, and
// a false QA flag. A new finding in a file the fix did not touch is in code an
// earlier review already passed: it becomes a note.
export function resolveDeltaFindings(verdict, deltaFiles, previousFindings) {
  const inDelta = new Set(deltaFiles.map(normalizePath))
  const reported = new Map()
  for (const p of verdict.previous_findings) reported.set(p.index, p)
  const unresolved = previousFindings
    .filter((prev) => reported.get(prev.index)?.resolved !== true)
    .map((prev) => ({ ...prev, detail: `unresolved: ${String(prev.detail).replace(/^unresolved: /, '')}` }))
  const blocks = []
  const notes = []
  for (const [key, label] of SECTION_LABELS) {
    const section = verdict[key]
    if (section.verdict !== 'fail') continue
    const findings = Array.isArray(section.findings) ? section.findings : []
    if (findings.length === 0) blocks.push({ file: null, line: null, detail: `${label} failed without a specific finding` })
    for (const f of findings) {
      const entry = { file: typeof f?.file === 'string' ? f.file : null, line: f?.line ?? null, detail: String(f?.detail || 'issue flagged') }
      if (f?.severity === 'note') notes.push(entry)
      else if (entry.file === null || inDelta.has(normalizePath(entry.file))) blocks.push(entry)
      else notes.push(entry)
    }
    if (key === 'qa_review') {
      for (const flag of QA_BOOLEAN_FLAGS) {
        if (section[flag] === false) blocks.push({ file: null, line: null, detail: `QA: ${flag} is false` })
      }
    }
  }
  return { passed: unresolved.length === 0 && blocks.length === 0, blocks: [...unresolved, ...blocks], notes }
}

// What the next fix pass reads as "Human feedback to address" after a delta
// review rejects: only the blocks, so it is never told to fix a note.
function formatFixFeedback(blocks, cycle) {
  const lines = [`Automated fix-pass review cycle ${cycle}/${REVIEW_CYCLE_CAP} failed — fix only these findings.`, '']
  for (const f of blocks.slice(0, 10)) {
    lines.push(`- **${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'general'}** — ${f.detail}`)
  }
  return lines.join('\n').slice(0, 2000)
}

function notesSection(notes) {
  return [
    '## Notes — outside the fix diff, not blocking',
    ...notes.map((n) => `- ${n.file ? `\`${n.file}${n.line ? `:${n.line}` : ''}\`` : 'general'} — ${n.detail}`),
  ].join('\n')
}

// A delta review's farm report must carry what the server needs to apply the
// rule above. Missing any of it is malformed, never "nothing changed".
function deltaReport(artifacts) {
  if (!validateDeltaVerdict(artifacts?.verdict)) return null
  const { reviewed_sha: sha, delta_files: files } = artifacts
  if (typeof sha !== 'string' || !sha.trim()) return null
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) return null
  return { reviewedSha: sha.trim(), deltaFiles: files }
}

// After an implement run: keep the fix pass only when the run WAS a fix pass
// and the farm proved its diff small and descended from the reviewed commit.
// Anything else (a full run, an oversize diff, a missing count from an older
// farm, a rebase or a merge from main touching the PR's files) sends the next
// review back to full.
function settleFixPass(id, run, artifacts) {
  const item = getItem(id)
  if (item.fix_pass !== 1) return
  const lines = artifacts?.fix_diff_lines
  let reason = null
  if (runScope(run).mode !== 'fix') reason = 'this implement run was a full run'
  else if (typeof artifacts?.scope_fallback === 'string') reason = `the fix diff could not be scoped (${artifacts.scope_fallback})`
  else if (!Number.isInteger(lines)) reason = 'the farm reported no fix diff size'
  else if (lines > FIX_PASS_MAX_LINES) reason = `the fix diff changed ${lines} lines (limit ${FIX_PASS_MAX_LINES})`
  if (!reason) return
  db.prepare("UPDATE work_item SET fix_pass = 0, updated_at = datetime('now') WHERE id = ?").run(id)
  addEvent(id, { who: 'Horizon', text: `next review is a full review: ${reason}`, color: '#DFA200', initials: 'HZ' })
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
//
// HZ-182: `review` is { reviewedSha, delta } from the farm's report — null on
// the mock path, which has no commits, so demo mode stays full by
// construction. HZ-369: plus { provider, commandId }, the run's provenance. `delta` (validated by the caller) is set only for a review the
// farm actually ran as a delta review; it swaps the pass rule for
// resolveDeltaFindings. Fix-pass cycles count toward the same cap.
function finalizeReviewStep(id, runId, text, artifactMd, verdict, patch, isMock, review) {
  // This run has fully completed by the time we're called (no more awaits
  // pending on it) — safe to release the busy mutex before any of the three
  // branches below calls kick() for the item's next step.
  dispatching.delete(id)
  const step = STEPS[REVIEW_STEP_INDEX]
  const agent = AGENTS[step.agent]
  const attempt = db.prepare('SELECT attempt FROM step_run WHERE id = ?').get(runId)?.attempt || 1
  const delta = review?.delta
    ? resolveDeltaFindings(verdict, review.delta.deltaFiles, review.delta.previousFindings)
    : null
  if (delta && delta.notes.length > 0) artifactMd = [artifactMd, notesSection(delta.notes)].filter(Boolean).join('\n\n')
  db.prepare(
    "UPDATE step_run SET status = 'done', output = ?, artifact = ?, provider = ?, command_id = ?, ended_at = datetime('now') WHERE id = ?",
  ).run(text, artifactMd, review?.provider || null, review?.commandId || null, runId)
  // Written on every completed review, pass or fail: the next delta starts here.
  db.prepare('UPDATE work_item SET last_reviewed_sha = ? WHERE id = ?').run(review?.reviewedSha || null, id)

  const passed = delta ? delta.passed : verdict.code_review.verdict === 'pass' && verdict.qa_review.verdict === 'pass'
  if (passed) {
    db.prepare(
      "UPDATE work_item SET cursor = cursor + 1, fix_pass = 0, fix_findings_json = NULL, updated_at = datetime('now') WHERE id = ?",
    ).run(id)
    addEvent(id, { who: agent.label, text: `completed “${step.label}” — ${text.slice(0, 300)}`, color: agent.color, initials: agent.initials })
    postStepComment(getItem(id), REVIEW_STEP_INDEX, attempt, text, patch, isMock, artifactMd)
    notifyChange()
    kick(id)
    return
  }

  db.prepare("UPDATE work_item SET review_cycle_count = review_cycle_count + 1, updated_at = datetime('now') WHERE id = ?").run(id)
  const cycle = db.prepare('SELECT review_cycle_count FROM work_item WHERE id = ?').get(id).review_cycle_count

  if (cycle >= REVIEW_CYCLE_CAP) {
    postStepComment(getItem(id), REVIEW_STEP_INDEX, attempt, text, patch, isMock, artifactMd)
    forwardToAcceptGate(id, {
      who: 'Horizon',
      initials: 'HZ',
      reason: `automated review cap (${REVIEW_CYCLE_CAP}) reached`,
      reviewRunId: runId,
    })
    return
  }

  // The feedback row is the human-readable copy the fix pass reads;
  // fix_findings_json is the machine record the next delta review is judged
  // against. The findings reach the implement prompt once, through feedback.
  db.prepare('INSERT INTO feedback (item_id, target, message) VALUES (?, ?, ?)').run(
    id,
    STEPS[IMPLEMENT_STEP_INDEX].agent,
    delta ? formatFixFeedback(delta.blocks, cycle) : formatReviewFeedback(verdict, cycle),
  )
  const fixFindings = delta ? delta.blocks.map(({ file, line, detail }) => ({ file, line, detail })) : blockingFindings(verdict)
  db.prepare(
    "UPDATE work_item SET cursor = ?, fix_pass = ?, fix_findings_json = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(IMPLEMENT_STEP_INDEX, FIX_PASS_ENABLED && review?.reviewedSha ? 1 : 0, JSON.stringify(fixFindings), id)
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

// The one way a failing review reaches the human gate (HZ-185): the review cap
// above and a human's forwardRejectedReview below both land here, so both log
// the same event shape and leave the item in the same state. It only moves the
// cursor — Accept the code is still a gate, decided with the gate PIN.
// forwarded_review_run_id / forwarded_by / forwarded_sha say which verdict the
// gate shows, who sent it there, and which commit that verdict read.
function forwardToAcceptGate(id, { who, initials, reason, reviewRunId }) {
  db.prepare(
    `UPDATE work_item SET cursor = ?, fix_pass = 0, fix_findings_json = NULL, forwarded_review_run_id = ?,
       forwarded_by = ?, forwarded_sha = last_reviewed_sha, updated_at = datetime('now') WHERE id = ?`,
  ).run(ACCEPT_GATE_INDEX, reviewRunId, who, id)
  const event = {
    who,
    text: `${reason} — forwarded to the human gate with the failing verdict attached (review run #${reviewRunId})`,
    color: '#9C333E',
    initials,
  }
  addEvent(id, event)
  notifyChange()
  kick(id)
  return event
}

// HZ-185: a human with the gate PIN forwards an item the latest review just
// rejected to Accept the code, instead of letting it run another implement
// cycle. Cancels the implement run the rejection started, and refuses — the
// item goes back to implement with its findings — if the PR head moved past
// the commit that review read, so the gate never shows code nobody reviewed.
export async function forwardRejectedReview(id, actor = 'You') {
  const item = getItem(id)
  if (!item) return { error: 'not_found' }
  if (isClosed(item) || isAbandoned(item) || PHASES[STEPS[item.cursor].phase] !== 'Execute') return { error: 'not_in_execute' }
  if (!reviewRejected(item)) return { error: 'review_not_rejected' }
  if (forwarding.has(id)) return { error: 'forward_in_progress' }
  const reviewRun = db
    .prepare("SELECT id, ended_at FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'done' ORDER BY id DESC LIMIT 1")
    .get(id, REVIEW_STEP_INDEX)
  if (!reviewRun) return { error: 'review_not_rejected' }

  forwarding.add(id)
  try {
    return await forwardOrRefuse(id, item, actor, reviewRun)
  } finally {
    forwarding.delete(id)
    // Forwarded: a no-op at the gate. Refused: restarts implement.
    kick(id)
  }
}

async function forwardOrRefuse(id, item, actor, reviewRun) {
  // The rejection's own feedback row: finalizeReviewStep inserts it right
  // after it closes the review run. Only that row is consumed or re-queued —
  // never other feedback a human queued for implement.
  const rejection = db
    .prepare('SELECT id FROM feedback WHERE item_id = ? AND target = ? AND created_at >= ? ORDER BY id LIMIT 1')
    .get(id, STEPS[IMPLEMENT_STEP_INDEX].agent, reviewRun.ended_at)
  const refuse = (error, why) => {
    if (rejection) db.prepare('UPDATE feedback SET delivered_at = NULL WHERE id = ?').run(rejection.id)
    addEvent(id, {
      who: 'Horizon',
      text: `forward to “${STEPS[ACCEPT_GATE_INDEX].label}” refused — ${why}; “${STEPS[IMPLEMENT_STEP_INDEX].label}” restarts with the review findings`,
      color: '#9C333E',
      initials: 'HZ',
    })
    notifyChange()
    return { error }
  }

  if (!(await stopActiveRuns(id, 'cancelled'))) return refuse('branch_unverified', 'the farm did not confirm the implement run was stopped')
  let head
  try {
    head = await getPrHeadSha(item)
  } catch (err) {
    return refuse('branch_unverified', `could not read the PR head (${err.message})`)
  }
  // null = no PR (demo mode): there is no branch to have moved.
  if (head !== null && head !== item.last_reviewed_sha) {
    return refuse('branch_moved', `PR #${item.pr} moved past the commit the review read`)
  }
  // Someone else (a send-back, a restart) may have moved the item while this
  // awaited — theirs wins, and they already restarted whatever comes next.
  if (!reviewRejected(getItem(id))) return { error: 'review_not_rejected' }

  if (rejection) {
    db.prepare("UPDATE feedback SET delivered_at = COALESCE(delivered_at, datetime('now')) WHERE id = ?").run(rejection.id)
  }
  forwardToAcceptGate(id, {
    who: actor,
    initials: 'YOU',
    reason: `skipped the remaining automated review cycles (cycle ${item.review_cycle_count}/${REVIEW_CYCLE_CAP} failed)`,
    reviewRunId: reviewRun.id,
  })
  return { ok: true, forwarded: true }
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

  deployQueue.endDeployEntry(id, verdict.verdict === 'pass' ? 'passed' : 'failed')
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

// HZ-235: told when a farm step run ends (completed or failed), so
// autoResolve.js can re-check an item it skipped while that step ran. Called
// on a microtask and guarded, so a listener can never fail the run.
const stepEndedListeners = []

export function onStepEnded(fn) {
  stepEndedListeners.push(fn)
}

function emitStepEnded(id) {
  queueMicrotask(() => {
    for (const fn of stepEndedListeners) {
      try {
        fn(id)
      } catch {
        // a listener's failure is its own
      }
    }
  })
}

export async function completeFarmRun(runId, { summary, patch, artifacts }) {
  const run = db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
  if (!run || run.status !== 'active') return { ok: true, stale: true }
  const id = run.item_id
  const item = getItem(id)

  clearTimeout(timers[runId])
  delete timers[runId]

  if (!item || item.cursor !== run.step_index || !inFlightRunnable(item)) {
    dispatching.delete(id)
    closeActiveRuns(id, 'superseded')
    return { ok: true, stale: true }
  }

  let cleanPatch = {}
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
  cleanPatch = applyCriteriaLock(id, item, run.step_index, cleanPatch)
  writeWorkItemPatch(id, item, cleanPatch)

  const step = STEPS[run.step_index]
  const agent = AGENTS[step.agent]
  let text = String(summary || 'completed the step').slice(0, 600)

  // The implement step's artifact is a pushed branch: this side owns turning
  // it into the PR. If that fails, the step fails — no PR, no advance.
  // HZ-345: the implement step's statements for Manual metric lines go in the
  // PR body, and in this step's output, which is what the review reads.
  const manualChecks =
    typeof artifacts?.manual_checks === 'string' && artifacts.manual_checks.trim()
      ? artifacts.manual_checks.trim().slice(0, MANUAL_CHECKS_MAX_CHARS)
      : null
  if (typeof artifacts?.branch === 'string' && item.repo && item.issue != null) {
    try {
      const pr = await createPrFromBranch(item, artifacts.branch, { manualChecks })
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
  if (manualChecks) text = `${text}\n\n## Manual checks\n${manualChecks}`

  let artifactMd =
    typeof artifacts?.artifact_md === 'string' ? artifacts.artifact_md.slice(0, WRITE_TIME_SANITY_CEILING_CHARS) : null

  // HZ-102 provenance: since HZ-357 farm/step_agent.py sets these two fields
  // on every run of a providerOverrideEligible step whose reply named the
  // provider that ran (Default runs included), so the item page can show
  // "Ran on …". Every other step keeps writing NULL here.
  // HZ-369: review is eligible too, so this is read before its branch.
  const provider =
    typeof artifacts?.provider === 'string' && artifacts.provider.trim() ? artifacts.provider.trim() : null
  const commandId =
    typeof artifacts?.command_id === 'string' && artifacts.command_id.trim() ? artifacts.command_id.trim() : null

  if (run.step_index === REVIEW_STEP_INDEX) {
    if (!validateVerdict(artifacts?.verdict)) return failFarmRun(runId, 'malformed review verdict JSON')
    // HZ-182: delta rules apply only when the run was DISPATCHED as a delta
    // review and the farm confirms it ran one. A farm that fell back to the
    // full range (stale base, merge from main) is judged by the full rules.
    const scope = runScope(run)
    let delta = null
    if (scope.mode === 'delta' && artifacts.review_mode === 'delta') {
      const report = deltaReport(artifacts)
      if (!report) return failFarmRun(runId, 'malformed fix-pass review verdict JSON')
      const previousFindings = Array.isArray(scope.previous_findings) ? scope.previous_findings : []
      delta = { deltaFiles: report.deltaFiles, previousFindings }
    }
    const reviewedSha = typeof artifacts.reviewed_sha === 'string' && artifacts.reviewed_sha.trim() ? artifacts.reviewed_sha.trim() : null
    finalizeReviewStep(id, runId, text, artifactMd, artifacts.verdict, cleanPatch, false, {
      reviewedSha,
      delta,
      provider,
      commandId,
    })
    emitStepEnded(id)
    return { ok: true }
  }

  if (run.step_index === DEPLOY_STEP_INDEX) {
    if (!validateDeployVerdict(artifacts?.verdict)) return failFarmRun(runId, 'malformed deploy verdict JSON')
    finalizeDeployStep(id, runId, text, artifactMd, artifacts.verdict, cleanPatch)
    emitStepEnded(id)
    return { ok: true }
  }

  // HZ-236: the overlap check is recomputed here and this result is the one
  // applied — the dispatch-time copy was context for the model only. The
  // server's `## Overlap` section replaces any the model wrote, so a computed
  // decision can never be downgraded. A failed check never fails the step:
  // its peers are listed as not checked. All awaits come first; from the
  // re-check on there is none, because the dependency edge applyOverlap may
  // add blocks this item, and the run must be marked done before anything
  // could see a blocked item holding an active run.
  if (run.step_index === SUMMARIZE_STEP_INDEX) {
    let check
    try {
      check = await computeOverlap(id)
    } catch (err) {
      check = overlapFailure(id, err)
    }
    if (!runStillActive(runId)) return { ok: true, stale: true }
    artifactMd = replaceOverlapSection(artifactMd || '', renderOverlapSection(applyOverlap(id, check)))
  }

  // HZ-313: a split the plan proposes is validated and recorded here, and
  // shown at gate 5. Nothing is filed until that gate is approved; a refusal
  // is a `## Blockers` bullet, never a failed run.
  if (run.step_index === OPTIONS_STEP_INDEX) {
    artifactMd = proposeSplit(item, runId, artifacts?.split, artifactMd)
  }

  // HZ-379: a step whose reply asks for items (domain/steps.json's spawnsOn)
  // files them before it completes. A malformed ask or a failed filing fails
  // the run, so it never advances without them; a retry asks under the same
  // key and files nothing twice. The edges are added after the last await, in
  // the same tick that marks the run done, so kick() below finds the item
  // blocked and the next step never dispatches while a child is open.
  const spawnRule = spawnRuleOf(step)
  let spawnKey = null
  if (spawnRule && artifacts && Object.hasOwn(artifacts, spawnRule.field) && artifacts[spawnRule.field] != null) {
    const checked = validateSpawnSpec(artifacts[spawnRule.field])
    if (checked.error) return failFarmRun(runId, `malformed ${spawnRule.field}: ${checked.error}`)
    spawnKey = requestKeyFor(id, run.step_index)
    const filed = await spawnItems(item, [checked.spec], { requestKey: spawnKey, kind: spawnRule.kind, actor: agent.label })
    if (filed.error) return failFarmRun(runId, `could not file the ${spawnRule.kind} item it asked for: ${filed.error}`)
    if (!runStillActive(runId)) return { ok: true, stale: true }
  }
  if (spawnKey) {
    const linked = linkSpawned(id, spawnKey)
    if (linked.error) return failFarmRun(runId, `could not wait for the item it filed: ${linked.error}`)
  }

  if (run.step_index === IMPLEMENT_STEP_INDEX) {
    settleFixPass(id, run, artifacts)
    recordFarmCheckPass(item, artifacts, 'implement')
  }

  db.prepare(
    "UPDATE step_run SET status = 'done', output = ?, artifact = ?, provider = ?, command_id = ?, ended_at = datetime('now') WHERE id = ?",
  ).run(text, artifactMd, provider, commandId, runId)
  db.prepare("UPDATE work_item SET cursor = cursor + 1, updated_at = datetime('now') WHERE id = ?").run(id)
  addEvent(id, { who: agent.label, text: `completed “${step.label}” — ${text.slice(0, 300)}`, color: agent.color, initials: agent.initials })
  postStepComment(getItem(id), run.step_index, run.attempt, text, cleanPatch, false, artifactMd)
  notifyChange()
  dispatching.delete(id)
  kick(id)
  emitStepEnded(id)
  return { ok: true }
}

// HZ-184: a check failure's digest (every failing line plus the counts) is
// what the next attempt and a human read to learn what broke. 300 chars kept
// only the head of it — usually passing tests. This matches the /fail route's
// `error` maxLength in app.js, so whatever the route accepts is kept whole.
const FAILED_OUTPUT_MAX_CHARS = 2000

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
  ).run(`FAILED: ${String(error).slice(0, FAILED_OUTPUT_MAX_CHARS)}`, runId)
  // Tell the farm too (same call cancel() makes): a step failed here by
  // either watchdog firing (queue or execution) may still be sitting queued
  // or running on the farm side. Without this, farmd can claim and launch a
  // task file whose run the server has already given up on (HZ-57) — the
  // /started callback double-checks this too, but a run failed before it
  // ever reaches that checkpoint needs the task file removed directly.
  if (FARM_URL) farmFetch('/steps/cancel', { run_id: runId }).catch(() => {})

  const retryable = reason != null && AUTO_RETRY_REASONS.has(reason) && runnable(getItem(id))
  // HZ-373: a check failure's event shows its headline line only; the whole
  // message is kept as the event's detail.
  const { cause, detail } = splitCheckError(error)

  if (retryable && run.auto_retry_count < AUTO_RETRY_CAP) {
    const nextCount = run.auto_retry_count + 1
    addEvent(id, {
      who: 'Horizon',
      text: `transient failure (${reason}): ${cause} — auto-retrying (${nextCount}/${AUTO_RETRY_CAP})`,
      color: '#DFA200',
      initials: 'HZ',
      // Stored, but the UI only shows the pause event's detail.
      detail,
    })
    notifyChange()
    kick(id, { autoRetryCount: nextCount })
    emitStepEnded(id)
    return { ok: true, retried: true }
  }

  db.prepare("UPDATE work_item SET paused = 1, updated_at = datetime('now') WHERE id = ?").run(id)
  // HZ-333: a resume re-queues the item rather than reusing this release.
  if (run.step_index === DEPLOY_STEP_INDEX) deployQueue.endDeployEntry(id, 'failed')
  // Mirrors the `(${reason})` tag already used for the auto-retrying event
  // above — empty when reason is null, so the untagged wording below stays
  // byte-identical to what existing consumers already parse (HZ-94).
  const reasonTag = reason != null ? ` (${reason})` : ''
  addEvent(id, {
    who: 'Horizon',
    text: retryable
      ? `agent step failed${reasonTag}: ${cause} — auto-retry budget (${AUTO_RETRY_CAP}) exhausted; item paused, resume to retry`
      : `agent step failed${reasonTag}: ${cause} — item paused; resume to retry`,
    color: '#9C333E',
    initials: 'HZ',
    detail,
  })
  notifyChange()
  emitStepEnded(id)
  return { ok: true }
}

// HZ-384: a Task's Execute starts only on the run plan a human approved at
// Approve the run. Returns null when the run may go ahead (any other step, or
// a plan that still matches); otherwise fails the run, pausing the item, and
// returns the store's check result. Execute is runsIn none until HZ-378, so
// dispatchToFarm cannot reach this for it yet; the tests call it directly.
export function refuseUnapprovedRun(runId, id, stepIndex) {
  if (stepIndex !== EXECUTE_STEP_INDEX) return null
  const check = approvedPlanCheck(id)
  if (!check.error) return null
  if (check.error === REASON.PLAN_CHANGED_SINCE_APPROVAL) {
    failFarmRun(
      runId,
      'the run plan changed since it was approved — send it back to Run plan and approve it again',
      REASON.PLAN_CHANGED_SINCE_APPROVAL,
    )
  } else {
    failFarmRun(runId, 'the run plan was never approved — approve it at Approve the run first')
  }
  return check
}

// HZ-346: an implement run that stopped on a rule with no code changes. Not
// a failure: the item is not paused, no attempt is used and nothing is
// auto-retried. The block, its step_run row and the owner's one ping are
// written in one transaction; inFlightRunnable then holds dispatch until
// store.js releases the block. A repeat report for the run finds it closed.
export function blockFarmRun(runId, { rule, needs }) {
  const run = db.prepare('SELECT * FROM step_run WHERE id = ?').get(runId)
  if (!run || run.status !== 'active') return { ok: true, stale: true }
  const id = run.item_id
  const item = getItem(id)

  // The stale guard comes first, so a late report from a superseded run is
  // stale rather than failed below.
  if (!item || item.cursor !== run.step_index || !inFlightRunnable(item)) {
    clearTimeout(timers[runId])
    delete timers[runId]
    dispatching.delete(id)
    closeActiveRuns(id, 'superseded')
    return { ok: true, stale: true }
  }
  if (run.step_index !== IMPLEMENT_STEP_INDEX) return failFarmRun(runId, 'blocked report from a non-implement step')

  clearTimeout(timers[runId])
  delete timers[runId]
  dispatching.delete(id)

  const block = { rule: String(rule), needs: String(needs) }
  db.transaction(() => {
    db.prepare(
      "UPDATE step_run SET status = 'cancelled', rule_blocked = 1, output = ?, ended_at = datetime('now') WHERE id = ?",
    ).run(`BLOCKED: stopped by a rule: “${block.rule}” — needs: ${block.needs}`.slice(0, FAILED_OUTPUT_MAX_CHARS), runId)
    // blockedAt in SQLite's own format: store.js compares it as text with
    // work_item_dependency.created_at.
    db.prepare(
      `UPDATE work_item SET rule_block_json = json_object('rule', ?, 'needs', ?, 'runId', ?, 'blockedAt', datetime('now')),
              updated_at = datetime('now') WHERE id = ?`,
    ).run(block.rule, block.needs, runId, id)
    enqueueRuleBlockPing(item, block)
  })()
  addEvent(id, {
    who: 'Horizon',
    text: `stopped by a rule: “${block.rule.slice(0, 300)}” — needs: ${block.needs.slice(0, 600)} — add a dependency on the item that delivers it, resume to retry, or abandon`,
    color: '#9C333E',
    initials: 'HZ',
  })
  notifyChange()
  emitStepEnded(id)
  return { ok: true }
}

// HZ-333: a deploy queue item's step 14 fails outside any farm run (its
// batch's deploy failed, or it could not join). Recorded as a failed step
// run so it pauses exactly like one, untagged so it is never auto-retried.
export function failQueuedDeploy(id, message) {
  deployQueue.endDeployEntry(id, 'failed')
  const item = getItem(id)
  if (!item || item.cursor !== DEPLOY_STEP_INDEX) return
  const attempt = db
    .prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM step_run WHERE item_id = ? AND step_index = ?')
    .get(id, DEPLOY_STEP_INDEX).n
  const runId = db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, ?, ?)')
    .run(id, DEPLOY_STEP_INDEX, attempt, STEPS[DEPLOY_STEP_INDEX].agent).lastInsertRowid
  failFarmRun(runId, message)
}

deployQueue.setDeployQueueHooks({ kick, fail: failQueuedDeploy })

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
  if (!inFlightRunnable(item) || item.cursor !== stepIndex || !runStillActive(runId)) {
    dispatching.delete(id)
    closeActiveRuns(id, 'superseded')
    return
  }

  const step = STEPS[stepIndex]
  const agent = AGENTS[step.agent]
  const behavior = MOCK_STEP_BEHAVIOR[step.label] || (() => ({ summary: `completed ${step.label.toLowerCase()}` }))
  let { summary, patch, verdict, failure, artifact_md: artifactMd } = await behavior(item)
  // HZ-304: a mock step that refused to run (an unready repo) fails the run
  // the way the farm path does — paused for a human, never auto-retried.
  if (failure) {
    if (runStillActive(runId)) return failFarmRun(runId, failure)
    dispatching.delete(id)
    return
  }

  // Deliver any queued human feedback to this "agent" — the mock acknowledges
  // it in its output; a real agent gets it injected into its session.
  const pendingFeedback = db
    .prepare('SELECT id, message FROM feedback WHERE item_id = ? AND delivered_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(id)
  if (pendingFeedback) {
    db.prepare(
      "UPDATE feedback SET delivered_at = datetime('now'), delivered_run_id = ? WHERE item_id = ? AND delivered_at IS NULL",
    ).run(runId, id)
    summary = `addressed your feedback (“${pendingFeedback.message.slice(0, 80)}”) — ${summary}`
  }

  // Re-check after any await (e.g. PR creation): a pause/reject may have landed.
  const after = getItem(id)
  if (!inFlightRunnable(after) || after.cursor !== stepIndex || !runStillActive(runId)) {
    dispatching.delete(id)
    if (runStillActive(runId)) closeActiveRuns(id, 'superseded')
    return
  }

  if (patch) patch = applyCriteriaLock(id, after, stepIndex, patch)
  if (patch) writeWorkItemPatch(id, after, patch)

  if (stepIndex === REVIEW_STEP_INDEX) {
    // finalizeReviewStep releases the busy mutex itself before it calls kick().
    finalizeReviewStep(id, runId, summary, mockReviewArtifactMd(verdict), verdict, patch, true, null)
    return
  }

  // A mock implement is never a scoped fix: its review must be full.
  if (stepIndex === IMPLEMENT_STEP_INDEX) settleFixPass(id, { scope_json: null }, null)
  db.prepare("UPDATE step_run SET status = 'done', output = ?, ended_at = datetime('now') WHERE id = ?").run(
    summary,
    runId,
  )
  if (artifactMd) db.prepare('UPDATE step_run SET artifact = ? WHERE id = ?').run(artifactMd, runId)
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
  stopActiveRuns(id, status)
}

// cancel()'s body. Resolves true once the farm has acknowledged every kill
// (or there was nothing to kill), false if any kill request failed. cancel()
// ignores it; forwardRejectedReview awaits it (HZ-185) before it reads the PR
// head, so a session that was still running cannot push after that check.
function stopActiveRuns(id, status) {
  const activeRuns = takeActiveRuns(id, status)
  if (!FARM_URL) return Promise.resolve(true)
  // HZ-194: a pause still checkpointing is one more push in flight; HZ-185's
  // forward must not read the PR head before it lands either.
  const saving = pausing.get(id) || Promise.resolve()
  return Promise.all([
    saving.then(() => true),
    ...activeRuns.map((run) => farmFetch('/steps/cancel', { run_id: run.id }).then(() => true, () => false)),
  ]).then((acks) => acks.every(Boolean))
}

// Clears the watchdogs of the item's active runs, closes them with `status`
// and returns them — the synchronous half every stop shares.
function takeActiveRuns(id, status) {
  const activeRuns = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND status = 'active'").all(id)
  for (const run of activeRuns) {
    clearTimeout(timers[run.id])
    delete timers[run.id]
  }
  dispatching.delete(id)
  closeActiveRuns(id, status)
  return activeRuns
}

// HZ-194: what each pause outcome farmd reports reads as in the activity log.
// Anything else — no `checkpoint` key (an older farmd), an unknown outcome —
// reads as not saved: claiming a save nobody confirmed would be worse.
function pauseCheckpointText(id, checkpoint) {
  const detail = typeof checkpoint?.detail === 'string' && checkpoint.detail ? `: ${checkpoint.detail}` : ''
  switch (checkpoint?.outcome) {
    case 'saved':
      return `paused — saved work in progress as a WIP checkpoint on horizon/${id.toLowerCase()}`
    case 'nothing':
      return 'paused — no changes since the last commit, nothing to save'
    case 'not_running':
      return null // queued: no agent ever ran, so a pause is exactly what it was before
    case 'failed':
    case 'timed_out':
    case 'skipped':
      return `paused — progress could not be saved${detail}`
    default:
      return 'paused — progress could not be saved: the farm did not say whether the work was saved'
  }
}

// Called by the store when a human pauses an item (HZ-194). Unlike cancel(),
// a running implement attempt is first asked to checkpoint its work, so a
// pause never discards it. The runs close at once — the pause is never held
// up — and the farm call runs in the background, bounded by
// PAUSE_CHECKPOINT_TIMEOUT_S on the farm and a little more here.
export function pause(id) {
  const activeRuns = takeActiveRuns(id, 'cancelled')
  if (!FARM_URL || activeRuns.length === 0) return
  const body = (run) => ({ run_id: run.id, reason: 'pause', checkpoint_timeout_s: PAUSE_CHECKPOINT_TIMEOUT_S })
  const timeoutMs = (PAUSE_CHECKPOINT_TIMEOUT_S + 15) * 1000
  const settled = Promise.all(
    activeRuns.map((run) =>
      farmFetch('/steps/cancel', body(run), { timeoutMs }).then(
        (res) => pauseCheckpointText(id, res?.checkpoint),
        () => 'paused — progress could not be saved: the farm did not answer',
      ),
    ),
  )
    .then((lines) => {
      for (const text of lines) {
        if (text) addEvent(id, { who: 'Horizon', text, color: '#5E4380', initials: 'HZ' })
      }
      if (lines.some(Boolean)) notifyChange()
    })
    .catch(() => {}) // never reject: kick() and stopActiveRuns() chain on this
    .finally(() => {
      if (pausing.get(id) === settled) pausing.delete(id)
    })
  pausing.set(id, settled)
}

// Test seam: the promise a pause of `id` is still settling, or undefined.
export function pendingPause(id) {
  return pausing.get(id)
}

// ---- HZ-321: agent steps a self-deploy stops ----

// The farm call's own bound, inside deploy-drain.mjs's 60s bound on the whole
// interrupt request: the checkpoint wait is capped so farmd's answer (wait +
// 15s slack) always lands first, whatever HZ_PAUSE_CHECKPOINT_TIMEOUT_S says.
export const DEPLOY_CHECKPOINT_TIMEOUT_S = Math.min(PAUSE_CHECKPOINT_TIMEOUT_S, 40)

const DEPLOY_STOP_OUTPUT = 'stopped for a Horizon deploy — redispatched after it at the same attempt'

function deployStopText(id, checkpoint) {
  const detail = typeof checkpoint?.detail === 'string' && checkpoint.detail ? `: ${checkpoint.detail}` : ''
  const tail = 'restarts after the deploy at the same attempt'
  switch (checkpoint?.outcome) {
    case 'saved':
      return `stopped for a Horizon deploy — saved a WIP checkpoint on horizon/${id.toLowerCase()}; ${tail}`
    case 'nothing':
    case 'not_running':
      return `stopped for a Horizon deploy — nothing to save; ${tail}`
    case 'failed':
    case 'timed_out':
    case 'skipped':
      return `stopped for a Horizon deploy — progress could not be saved${detail}; ${tail}`
    default:
      return `stopped for a Horizon deploy — the farm did not say whether the work was saved; ${tail}`
  }
}

// Called by the deploy-drain interrupt route (app.js) for the steps still
// running when the drain's step wait ran out. Each run still active is closed
// first — `cancelled`, deploy_interrupted = 1 — so a late result or /fail from
// its dying agent is ignored as stale and costs no attempt; its feedback is
// handed back undelivered (HZ-184); then farmd checkpoints and stops it
// (reason "deploy": a WIP commit pushed to the item's own branch, never
// forced). Nothing is redispatched here: kick() holds dispatch until the drain
// ends. Never throws. Returns one entry per run id asked about.
export async function interruptStepsForDeploy(runIds) {
  const timeoutMs = (DEPLOY_CHECKPOINT_TIMEOUT_S + 15) * 1000
  return Promise.all(
    runIds.map(async (runId) => {
      const run = db.prepare('SELECT id, item_id, step_index, status FROM step_run WHERE id = ?').get(runId)
      if (!run) return { runId, itemId: null, step: null, interrupted: false }
      const entry = { runId, itemId: run.item_id, step: stepSlug(run.step_index) }
      const moved = db
        .prepare(
          "UPDATE step_run SET status = 'cancelled', deploy_interrupted = 1, output = ?, ended_at = datetime('now') WHERE id = ? AND status = 'active'",
        )
        .run(DEPLOY_STOP_OUTPUT, runId).changes
      if (moved === 0) return { ...entry, interrupted: false }
      clearTimeout(timers[runId])
      delete timers[runId]
      dispatching.delete(run.item_id)
      db.prepare('UPDATE feedback SET delivered_at = NULL, delivered_run_id = NULL WHERE delivered_run_id = ?').run(runId)
      let checkpoint = { outcome: 'not_running', detail: 'no farm' }
      if (FARM_URL) {
        checkpoint = await farmFetch(
          '/steps/cancel',
          { run_id: runId, reason: 'deploy', checkpoint_timeout_s: DEPLOY_CHECKPOINT_TIMEOUT_S },
          { timeoutMs },
        ).then(
          (res) => (res?.checkpoint && typeof res.checkpoint.outcome === 'string' ? res.checkpoint : { outcome: 'failed', detail: 'the farm did not say' }),
          () => ({ outcome: 'failed', detail: 'the farm did not answer' }),
        )
      }
      addEvent(run.item_id, { who: 'Horizon', text: deployStopText(run.item_id, checkpoint), color: '#5E4380', initials: 'HZ' })
      notifyChange()
      return { ...entry, interrupted: true, checkpoint: { outcome: checkpoint.outcome, detail: String(checkpoint.detail ?? '') } }
    }),
  ).catch(() => [])
}

// The drain ended without this process restarting (deploy-horizon.sh's ERR
// trap, or the block's TTL): send out what kick() held, then every other
// runnable item — a deploy-stopped step is among them.
function releaseDeployHeld() {
  const held = [...heldForDeploy]
  heldForDeploy.clear()
  for (const [id, opts] of held) kick(id, opts)
  resumeActiveItems()
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
  registerAgentRunner({ kick, cancel, pause })
  onDrainEnd(releaseDeployHeld)
  // store.js reads this to attach {state, reason} onto activeRun in
  // listItems() — a plain object lookup, never a network call, so
  // snapshot()/listItems() stay synchronous (HZ-54).
  registerRunStateProvider(() => farm.runStates || {})
  // Default the active project to the first one if never chosen.
  if (!getSetting('active_project_id')) {
    const first = db.prepare('SELECT id FROM project ORDER BY id LIMIT 1').get()
    if (first) setSetting('active_project_id', String(first.id))
  }
  // HZ-216: end gate actions whose lease ran out — one a restart orphaned
  // becomes `interrupted` and its gate re-opens — now and every minute.
  sweepGateActions()
  setInterval(() => sweepGateActions(), GATE_ACTION_SWEEP_MS).unref()
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
    // HZ-333: the deploy queue resumes from the database — mid-window,
    // mid-publish or mid-deploy — then ticks on.
    deployQueue.resumeOnBoot().catch((err) => log.warn(`deploy queue: ${err.message}`))
    setInterval(() => deployQueue.tick().catch((err) => log.warn(`deploy queue: ${err.message}`)), deployQueue.TICK_MS).unref()
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
