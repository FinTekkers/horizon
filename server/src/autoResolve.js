// HZ-235: when main moves, start the existing Resolve-conflicts run on every
// open item whose PR no longer merges cleanly — without waiting for a human
// to click the Accept gate's button.
//
// This module only decides WHEN. Every run is orchestrator.resolveConflicts(),
// the button's own function: the same HZ-188 lock (a second run is refused),
// the same farmd resolver and lease rules, the same outcomes (back at the
// Accept gate clean, or escalated to implement with the conflict as feedback).
// Nothing here merges, approves, pushes or moves an item. Only the recorded
// trigger differs: gate_action.started_by = 'main_moved', the actor names the
// merges, and one event line says the run was started automatically.
//
// Triggers, both "main moved" only — the resolver's own pushes go to
// horizon/<id> branches, which neither sees, so a run never starts a scan:
//   - the signed GitHub webhook: a pull_request closed + merged into main
//     (app.js, behind the existing $GITHUB_WEBHOOK_SECRET check);
//   - the poll fallback: main's head sha changed since the last tick
//     (github.js pollOnce → setMainHeadListener).
// Merges inside AUTO_RESOLVE_DEBOUNCE_MS coalesce into one scan per repo, and
// merges that arrive while a scan runs coalesce into one follow-up scan.
//
// Load is bounded: one promise chain serves every repo, so there is only ever
// one scan, and one item, at a time. A resolver call can take up to
// FARM_CONFLICT_RESOLVE_TIMEOUT_MS; anything queued meanwhile waits (logged as
// "queued behind <ID>"), and farmd's check-slot limiter still applies.
//
// v1 acts only on items AT the Accept gate (the operator's ruling) — earlier
// items merge main in their next implement run. Items still in implement or
// review are logged and re-checked when their step ends or on the next poll
// tick, which also catches steps ended by cancel, supersede or a sweep.
//
// State is in memory: a restart loses the debounce and the re-check list, and
// the next main move or poll tick catches up. A resolve lock held across a
// restart is still swept by HZ-216.

import { db } from './db.js'
import * as github from './github.js'
import * as orchestrator from './orchestrator.js'
import { isAutoResolveOnMain } from './settings.js'
import { AUTO_RESOLVE_DEBOUNCE_MS, AUTO_RESOLVE_MERGEABLE_WAIT_MS } from './config.js'
import { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX, isClosed, isAbandoned } from '../../domain/js/lifecycle.js'

const SHA_RE = /^[0-9a-f]{40}$/

let log = null
let started = false

const pendingTriggers = new Map() // repo -> { prs: Set<number>, sha } not yet scanned
const waiting = new Map() // item id -> trigger text of the scan that skipped it, re-checked later
const rechecks = new Set() // waiting item ids queued for a single-item re-check
const lastSeenSha = new Map() // repo -> main's head as last read by the poll
const lastScannedSha = new Map() // repo -> main's head as read by the last scan
const lookups = new Set() // in-flight prsForCommit reads (poll path)

let debounceTimer = null
let debounceFired = null
let drainQueued = false
let running = false
let currentItem = null
let chain = Promise.resolve()

export function startAutoResolve(logger) {
  log = logger
  if (started) return
  started = true
  github.setMainHeadListener(onMainHead)
  orchestrator.onStepEnded(recheckItem)
}

// Queues a scan of `repo`. Called by the webhook and the poll; it never scans
// inline, so the webhook's reply is not held up. A no-op until
// startAutoResolve() runs, so an app built without it (tests) starts nothing.
export function noteMainMoved(repo, { prs = [], sha = null } = {}) {
  if (!started) return
  const validSha = SHA_RE.test(sha || '') ? sha : null
  // A merge whose commit a scan already read as main's head was covered by it.
  if (validSha && lastScannedSha.get(repo) === validSha) return
  const trigger = pendingTriggers.get(repo) || { prs: new Set(), sha: null }
  for (const pr of prs) if (Number.isInteger(pr)) trigger.prs.add(pr)
  if (validSha) trigger.sha = validSha
  pendingTriggers.set(repo, trigger)
  // A fixed window from the first merge, so a steady stream of merges cannot
  // postpone the scan forever.
  if (debounceTimer) return
  let fired
  debounceFired = new Promise((resolve) => (fired = resolve))
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    fired()
    schedule()
  }, AUTO_RESOLVE_DEBOUNCE_MS)
}

// A step ended on `id`: re-check it if a scan skipped it while that step ran.
export function recheckItem(id) {
  if (!started || !waiting.has(id)) return
  rechecks.add(id)
  schedule()
}

// The poll's per-repo hook: main's current head. The first sha seen only
// seeds; a new one is a main move. Each tick also re-checks every waiting item
// of the repo that can now be decided — this is what catches a step that ended
// by cancel, supersede or a sweep, which tell no listener.
function onMainHead(repo, sha) {
  const previous = lastSeenSha.get(repo)
  lastSeenSha.set(repo, sha)
  if (previous && previous !== sha && lastScannedSha.get(repo) !== sha) {
    const lookup = github
      .prsForCommit(repo, sha)
      .catch(() => [])
      .then((prs) => noteMainMoved(repo, { prs, sha }))
      .finally(() => lookups.delete(lookup))
    lookups.add(lookup)
  }
  for (const id of waiting.keys()) {
    const row = itemRow(id)
    if (!row) waiting.delete(id)
    else if (row.repo === repo && decidableNow(row)) rechecks.add(id)
  }
  if (rechecks.size > 0) schedule()
}

// Whether a waiting item's re-check can reach a decision other than "still
// waiting" — so a poll tick logs nothing for an item still mid-step.
function decidableNow(row) {
  if (isClosed(row) || isAbandoned(row) || row.paused) return true
  if (row.cursor !== ACCEPT_GATE_INDEX) return row.cursor < IMPLEMENT_STEP_INDEX || row.cursor > ACCEPT_GATE_INDEX
  return !stepRunning(row.id)
}

function schedule() {
  if (drainQueued) return
  drainQueued = true
  if (running && currentItem) log?.info(`auto-resolve: scan queued behind ${currentItem}`)
  chain = chain.then(drain).catch((err) => log?.warn(`auto-resolve: scan stopped (${err?.name || 'error'})`))
}

// One pass over everything queued so far. Triggers and re-checks that arrive
// while it runs queue exactly one follow-up pass. Within a pass each item is
// decided at most once.
async function drain() {
  drainQueued = false
  running = true
  const triggers = new Map(pendingTriggers)
  pendingTriggers.clear()
  const ids = [...rechecks]
  rechecks.clear()
  try {
    if (!isAutoResolveOnMain()) {
      for (const [repo, trigger] of triggers) {
        if (trigger.sha) lastScannedSha.set(repo, trigger.sha)
        log?.info(`auto-resolve off — ignored main move on ${repo}`)
      }
      return
    }
    const decided = new Set()
    for (const [repo, trigger] of triggers) await scanRepo(repo, trigger, decided)
    for (const id of ids) {
      if (decided.has(id) || !waiting.has(id)) continue
      decided.add(id)
      await consider(id, waiting.get(id))
    }
  } finally {
    running = false
    currentItem = null
  }
}

function triggerText({ prs, sha }) {
  if (prs.size > 0) return `merged PR ${[...prs].sort((a, b) => a - b).map((n) => `#${n}`).join(', ')}`
  return sha ? `main now at ${sha.slice(0, 7)}` : 'main moved'
}

async function scanRepo(repo, trigger, decided) {
  const head = await github.getBranchSha(repo, 'main').catch(() => null)
  const sha = head || trigger.sha
  if (sha) {
    lastScannedSha.set(repo, sha)
    lastSeenSha.set(repo, sha)
  }
  const text = triggerText(trigger)
  const ids = db
    .prepare('SELECT id FROM work_item WHERE repo = ? AND cursor BETWEEN ? AND ? ORDER BY id')
    .all(repo, IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX)
    .map((row) => row.id)
  // Items a previous scan left waiting may have moved out of that window
  // (closed, sent back) — they still get their one decision line.
  for (const id of waiting.keys()) if (!ids.includes(id) && itemRow(id)?.repo === repo) ids.push(id)
  for (const id of ids) {
    if (decided.has(id)) continue
    decided.add(id)
    await consider(id, text)
  }
}

// Decides one item and logs exactly one line for it. The line carries the
// repo, item id, PR number and decision only — never a URL, token or command.
async function consider(id, text) {
  currentItem = id
  const row = itemRow(id)
  if (!row) {
    waiting.delete(id)
    return
  }
  const decision = await decide(row, text)
  log?.info(`auto-resolve ${row.repo} [main moved: ${text}] ${id}${row.pr != null ? ` PR #${row.pr}` : ''}: ${decision}`)
}

// The rules, first match wins. "Keep" leaves the item waiting for a re-check;
// every other decision is final for this main move.
async function decide(item, text) {
  const id = item.id
  const keep = (decision) => {
    waiting.set(id, text)
    return decision
  }
  const done = (decision) => {
    waiting.delete(id)
    return decision
  }
  if (isClosed(item)) return done('skipped (closed)')
  if (isAbandoned(item)) return done('skipped (abandoned)')
  if (item.paused) return done('skipped (paused)')
  if (projectDisabled(item)) return done('skipped (project disabled)')
  if (stepRunning(id)) return keep('skipped (step running)')
  if (item.cursor < IMPLEMENT_STEP_INDEX || item.cursor > ACCEPT_GATE_INDEX) return done('skipped (not in implement through accept gate)')
  if (item.cursor !== ACCEPT_GATE_INDEX) return keep('skipped (not at accept gate)')
  if (item.pr == null) return done('skipped (no PR)')
  if (gateActionRunning(id, 'premerge')) return done('skipped (merge in progress)')
  if (gateActionRunning(id, 'resolve')) return done('skipped (lock held)')

  let flag
  try {
    flag = await waitForMergeable(item)
  } catch {
    return keep('checked (GitHub read failed — re-check queued)')
  }
  if (flag === 1) return done('clean')
  if (flag == null) return keep('checked (mergeability unknown — re-check queued)')

  waiting.delete(id)
  const result = await orchestrator.resolveConflicts(id, `Horizon (main moved: ${text})`, {
    startedBy: 'main_moved',
    detail: `resolving conflicts on PR #${item.pr} (main moved: ${text})`,
    startedEvent: `main moved (${text}) — PR #${item.pr} no longer merges cleanly; started Resolve conflicts automatically`,
  })
  if (result?.error === 'resolve_in_progress') return 'skipped (lock held)'
  if (result?.error) return `skipped (${result.error.replace(/_/g, ' ')})`
  if (result?.resolved) {
    // Read-only: so the gate shows the resolved PR's new state at once.
    await github.refreshPrMergeable(id, item.repo, item.pr).catch(() => null)
    return 'started — resolved'
  }
  return 'started — escalated'
}

// GitHub computes mergeability lazily after main moves (null meanwhile):
// re-read with a 2s, 4s, 8s… backoff, for at most AUTO_RESOLVE_MERGEABLE_WAIT_MS.
async function waitForMergeable(item) {
  const deadline = Date.now() + AUTO_RESOLVE_MERGEABLE_WAIT_MS
  let delay = 2000
  for (;;) {
    const flag = await github.refreshPrMergeable(item.id, item.repo, item.pr)
    if (flag != null) return flag
    const left = deadline - Date.now()
    if (left <= 0) return null
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, left)))
    delay *= 2
  }
}

const itemRow = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)

const stepRunning = (id) => !!db.prepare("SELECT 1 FROM step_run WHERE item_id = ? AND status = 'active' LIMIT 1").get(id)

const gateActionRunning = (id, kind) =>
  !!db.prepare("SELECT 1 FROM gate_action WHERE item_id = ? AND kind = ? AND state = 'running'").get(id, kind)

function projectDisabled(item) {
  if (item.project_id == null) return false
  return db.prepare('SELECT enabled FROM project WHERE id = ?').get(item.project_id)?.enabled === 0
}

// ---- test-only ----

// Resolves once nothing is debounced, queued or running.
export async function whenIdleForTest() {
  while (debounceTimer || lookups.size > 0 || drainQueued || running) {
    if (lookups.size > 0) await Promise.all(lookups)
    else if (debounceTimer) await debounceFired
    else await chain
  }
}

// Clears every piece of in-memory state, so one test's leftovers never reach
// the next. Call only while idle.
export function resetForTest() {
  clearTimeout(debounceTimer)
  debounceTimer = null
  pendingTriggers.clear()
  waiting.clear()
  rechecks.clear()
  lastSeenSha.clear()
  lastScannedSha.clear()
}

export function waitingForTest() {
  return [...waiting.keys()]
}
