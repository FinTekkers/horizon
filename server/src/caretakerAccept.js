// Autopilot caretaker, Accept the code (HZ-272).
//
// caretakerActor.js acts on one caretaker_eval decision per arrival at gates
// 5, 10 and 15. Gate 13 is not one decision: it moves from wait to resolve to
// accept as runs finish. So this pass re-derives the gate from the DB on every
// tick — the item's gate_action rows (pre-merge, Resolve conflicts), its
// review result and its own caretaker_accept_action claims — and never from
// memory. caretakerActor.init() runs it on the same change signal and 60s
// timer, and hands in everything it needs (gateActions, actor, owner, clock,
// limit), so this module imports nothing that can act.
//
// Every gate call is app.js's gateActions — the same approve the UI's Accept
// calls, and the same resolveConflicts the Resolve-conflicts button calls.
// The caretaker never merges, rebases or pushes anything itself.
//
// One claim per (item, arrival, action): caretaker_accept_action's UNIQUE key
// is what makes a restart or a second tick add nothing, and what limits Resolve
// conflicts to one run per review result. A stop (a blocked or failed
// pre-merge, an escalated or failed resolve, an Accept that did not complete)
// pings the owner once per arrival and is never retried. Only a new review
// result (a new arrival_run_id) re-arms the caretaker; a human can still act at
// any time.
//
// The advisory g13.* rules in farm/roles/caretaker.md (caretakerRules.js) say
// what the caretaker WOULD do; decideAcceptGate() below is what it DOES. Keep
// the two in step.

import { db } from './db.js'
import * as store from './store.js'
import { STEPS, ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'
import { redact } from './caretakerRules.js'
import { isDeployBlocked } from './deployDrain.js'

const HOUR_MS = 60 * 60 * 1000
const GATE_LABEL = STEPS[ACCEPT_GATE_INDEX].label

// One line per stop reason; the same text goes in the event and the ping.
export const ACCEPT_STOP_TEXT = {
  premerge_blocked: 'the pre-merge checks blocked the merge',
  premerge_failed: 'the pre-merge run failed or was cut short (a restart ends even a human-started run this way)',
  resolve_escalated: 'Resolve conflicts escalated the item back to implement',
  resolve_failed: 'Resolve conflicts did not finish',
  accept_failed: 'the Accept it pressed did not complete',
}

// Items parked at Accept the code with a PR, in an enabled 'on' project. The
// arrival is the done review run that fed the gate (0 when there is none),
// the same key caretaker.js judges an arrival by. Oldest arrival first, so
// items are accepted in the order they reached the gate.
const selectCandidates = db.prepare(`
  SELECT w.id AS item_id, w.project_id, w.pr, w.pr_mergeable, w.forwarded_review_run_id, p.name AS project_name,
         COALESCE((SELECT MAX(s.id) FROM step_run s WHERE s.item_id = w.id
               AND s.step_index = w.cursor - 1 AND s.status = 'done'), 0) AS arrival_run_id
    FROM work_item w JOIN project p ON p.id = w.project_id
   WHERE p.autopilot = 'on' AND p.enabled = 1 AND w.cursor = ${ACCEPT_GATE_INDEX}
     AND w.abandoned_at IS NULL AND w.pr IS NOT NULL AND w.repo IS NOT NULL
   ORDER BY arrival_run_id, w.id`)
// An escalated resolve sends the item back to implement, so it is no longer a
// candidate above; it is still pinged, whoever started the run.
const selectEscalated = db.prepare(`
  SELECT g.item_id, g.epoch, w.project_id, w.forwarded_review_run_id,
         COALESCE((SELECT MAX(s.id) FROM step_run s WHERE s.item_id = w.id
               AND s.step_index = ${ACCEPT_GATE_INDEX - 1} AND s.status = 'done'), 0) AS arrival_run_id
    FROM gate_action g JOIN work_item w ON w.id = g.item_id JOIN project p ON p.id = w.project_id
   WHERE g.kind = 'resolve' AND g.state = 'escalated' AND p.autopilot = 'on' AND p.enabled = 1
     AND w.abandoned_at IS NULL AND w.cursor <> ${ACCEPT_GATE_INDEX}`)
const selectGateActions = db.prepare('SELECT kind, state, epoch FROM gate_action WHERE item_id = ?')
const selectClaims = db.prepare('SELECT action, outcome FROM caretaker_accept_action WHERE item_id = ? AND arrival_run_id = ?')
const selectMode = db.prepare('SELECT autopilot FROM project WHERE id = ?')
// One caretaker Accept in flight per project: its own pending claim, or any
// running pre-merge in the project, human-started included.
const selectAcceptInFlight = db.prepare(`
  SELECT 1 FROM caretaker_accept_action WHERE project_id = ? AND action = 'accept' AND outcome = 'pending'
  UNION ALL
  SELECT 1 FROM gate_action g JOIN work_item w ON w.id = g.item_id
   WHERE w.project_id = ? AND g.kind = 'premerge' AND g.state = 'running'
  LIMIT 1`)
// Gate 13's own hourly budget (no operator ruling to share it with gates 5,
// 10 and 15, so caretakerActor's window does not count these rows).
const countWindow = db.prepare('SELECT COUNT(*) AS n FROM caretaker_accept_action WHERE project_id = ? AND acted_at_ms > ?')
const insertClaim = db.prepare(`
  INSERT INTO caretaker_accept_action (project_id, item_id, arrival_run_id, action, outcome, acted_at_ms)
  VALUES (?, ?, ?, ?, 'pending', ?)`)
const finishClaim = db.prepare('UPDATE caretaker_accept_action SET outcome = ?, result = ?, error = ? WHERE id = ?')
const selectRowState = db.prepare('SELECT state FROM gate_action WHERE item_id = ? AND kind = ?')
const insertEvent = db.prepare(
  "INSERT INTO event (item_id, who, text, color, initials) VALUES (?, 'Caretaker', ?, '#4A6B5D', 'CT')",
)
const insertPing = db.prepare(`
  INSERT OR IGNORE INTO caretaker_ping (project_id, item_id, reason, dedupe_key, recipient, body, created_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?)`)
const selectRecentLimitPing = db.prepare(
  "SELECT 1 FROM caretaker_ping WHERE project_id = ? AND reason = 'hourly_limit' AND created_at_ms > ? LIMIT 1",
)

// gate_action.epoch is "<gate_decision id>:<step_run id>" at claim time. A
// row claimed during this arrival has a step_run id at or past the arrival
// run; anything lower is from an earlier visit to the gate.
const epochRun = (epoch) => Number(String(epoch ?? '').split(':')[1]) || 0
const reviewPassed = (row) => row.arrival_run_id !== 0 && row.arrival_run_id !== row.forwarded_review_run_id

// What decideAcceptGate() looks at, all read from the DB.
export function gatherAcceptFacts(row) {
  const rows = selectGateActions.all(row.item_id)
  const current = (kind) => rows.find((r) => r.kind === kind && epochRun(r.epoch) >= row.arrival_run_id) ?? null
  const claims = selectClaims.all(row.item_id, row.arrival_run_id)
  const claim = (action) => claims.find((c) => c.action === action)?.outcome ?? null
  return {
    reviewPassed: reviewPassed(row),
    mergeable: row.pr_mergeable ?? null,
    running: rows.some((r) => r.state === 'running'),
    premerge: current('premerge')?.state ?? null,
    resolve: current('resolve')?.state ?? null,
    acceptClaim: claim('accept'),
    resolveClaim: claim('resolve'),
  }
}

// Pure. First match wins. { kind: 'accept' | 'resolve' | 'wait' | 'stop', reason }
export function decideAcceptGate(f) {
  if (f.running) return { kind: 'wait', reason: 'a pre-merge or Resolve-conflicts run is in progress' }
  // A forwarded failing review (or none on record) is a human's call.
  if (!f.reviewPassed) return { kind: 'wait', reason: 'the automated review did not pass' }
  if (f.premerge === 'blocked') return { kind: 'stop', reason: 'premerge_blocked' }
  if (['failed', 'timed_out', 'interrupted'].includes(f.premerge)) return { kind: 'stop', reason: 'premerge_failed' }
  if (f.premerge === 'merged') return { kind: 'wait', reason: 'the PR is already merged' }
  if (f.resolve === 'escalated') return { kind: 'stop', reason: 'resolve_escalated' }
  if (f.acceptClaim === 'failed' || f.acceptClaim === 'interrupted') return { kind: 'stop', reason: 'accept_failed' }
  if (f.acceptClaim) return { kind: 'wait', reason: 'Accept already pressed for this review' }
  if (['failed', 'timed_out', 'interrupted'].includes(f.resolve) || f.resolveClaim === 'failed' || f.resolveClaim === 'interrupted') {
    return { kind: 'stop', reason: 'resolve_failed' }
  }
  if (f.mergeable === 0) {
    // One run per review result, whoever started it (autoResolve.js included).
    if (!f.resolve && !f.resolveClaim) return { kind: 'resolve', reason: 'the PR has conflicts' }
    return { kind: 'wait', reason: 'waiting for GitHub to recompute the PR after the resolve' }
  }
  if (f.mergeable === 1) return { kind: 'accept', reason: 'automated review passed, PR merges cleanly' }
  return { kind: 'wait', reason: 'GitHub has not reported whether the PR merges' }
}

// One ping and one event per arrival; a repeat tick or a restart adds nothing.
function recordStop(row, reason, nowMs, owner) {
  const text = ACCEPT_STOP_TEXT[reason]
  const body = redact(`Horizon caretaker stopped on ${row.item_id} at ${GATE_LABEL}: ${text}. Waiting for you.`)
  return db.transaction(() => {
    const key = `g13:${row.item_id}:${row.arrival_run_id}:stop`
    if (insertPing.run(row.project_id, row.item_id, reason, key, owner || '', body, nowMs).changes !== 1) return false
    insertEvent.run(row.item_id, `caretaker stopped (${text}) — pinged the owner`)
    return true
  })()
}

function recordLimitHit(row, nowMs, owner, limit) {
  if (selectRecentLimitPing.get(row.project_id, nowMs - HOUR_MS)) return false
  const body = redact(
    `Horizon caretaker hit ${limit} ${GATE_LABEL} actions/hour on project ${row.project_name}. Actions resume when the hour window allows.`,
  )
  insertPing.run(row.project_id, null, 'hourly_limit', `limit13:${row.project_id}:${nowMs}`, owner || '', body, nowMs)
  return true
}

// Claim, after re-reading the mode, in one transaction with its event.
function claim(row, action, eventText, nowMs) {
  return db.transaction(() => {
    if (selectMode.get(row.project_id)?.autopilot !== 'on') return null
    if (action === 'accept' && selectAcceptInFlight.get(row.project_id, row.project_id)) return null
    const id = insertClaim.run(row.project_id, row.item_id, row.arrival_run_id, action, nowMs).lastInsertRowid
    insertEvent.run(row.item_id, eventText)
    return id
  })()
}

// The gate call runs on; its result lands on the claim row. A stop it leads to
// is the next pass's job, so it is pinged once, from the DB.
function settle(claimId, row, action, call, log) {
  let pending
  try {
    pending = Promise.resolve(call())
  } catch (err) {
    pending = Promise.reject(err)
  }
  pending
    .then(
      (result) => result,
      (err) => ({ error: err?.message || String(err) }),
    )
    .then((result) => {
      try {
        const kind = action === 'accept' ? 'premerge' : 'resolve'
        const state =
          action === 'resolve' && result && !result.error
            ? result.escalated
              ? 'escalated'
              : result.resolved
                ? 'resolved'
                : null
            : selectRowState.get(row.item_id, kind)?.state ?? null
        const error = result && !result.error ? null : redact(result?.error ?? 'no result')
        finishClaim.run(error ? 'failed' : 'ok', state, error, claimId)
        if (error) log?.warn?.(`caretaker: ${action} on ${row.item_id} did not complete: ${error}`)
        store.notifyChange()
      } catch (err) {
        log?.error?.(`caretaker: ${row.item_id} ${action} result could not be recorded: ${redact(err?.message)}`)
      }
    })
}

// Exported for the tests; caretakerActor.init() is the only production caller.
// Never throws.
//
// SYNCHRONOUS from the candidate read to the last gate call, on purpose: both
// runners claim their gate_action row before their first await, so the next
// candidate in this loop already sees the pre-merge it just started, and no
// second pass (a change signal while caretakerActor is busy, the 60s timer)
// can interleave between a read and a claim. Do not add an await here.
export function actOnAcceptGate({ gateActions, actor, log, now = Date.now, owner = () => null, limit } = {}) {
  const counts = { accepted: 0, resolving: 0, stopped: 0, waited: 0 }
  let changed = false
  try {
    for (const row of selectCandidates.all()) {
      try {
        const nowMs = now()
        const decision = decideAcceptGate(gatherAcceptFacts(row))
        if (decision.kind === 'stop') {
          if (recordStop(row, decision.reason, nowMs, owner())) {
            counts.stopped++
            changed = true
            log?.warn?.(`caretaker: stopped on ${row.item_id} at step ${ACCEPT_GATE_INDEX}: ${ACCEPT_STOP_TEXT[decision.reason]}`)
          }
          continue
        }
        if (decision.kind === 'wait') {
          counts.waited++
          continue
        }
        // A self-deploy refuses new runs; wait it out rather than spend the claim.
        if (isDeployBlocked()) continue
        if (countWindow.get(row.project_id, nowMs - HOUR_MS).n >= limit) {
          if (recordLimitHit(row, nowMs, owner(), limit)) log?.warn?.(`caretaker: hourly limit (${limit}) hit at step ${ACCEPT_GATE_INDEX} on project ${row.project_id}`)
          continue
        }
        if (decision.kind === 'accept') {
          const claimId = claim(row, 'accept', `caretaker pressed Accept (${decision.reason})`, nowMs)
          if (claimId === null) continue
          changed = true
          counts.accepted++
          log?.info?.(`caretaker: Accept on ${row.item_id}`)
          settle(claimId, row, 'accept', () => gateActions.approve(row.item_id, ACCEPT_GATE_INDEX, '', actor), log)
        } else {
          const claimId = claim(row, 'resolve', `caretaker started Resolve conflicts on PR #${row.pr} (one run for this review)`, nowMs)
          if (claimId === null) continue
          changed = true
          counts.resolving++
          log?.info?.(`caretaker: Resolve conflicts on ${row.item_id}`)
          settle(claimId, row, 'resolve', () => gateActions.resolveConflicts(row.item_id, actor, { startedBy: 'caretaker' }), log)
        }
      } catch (err) {
        log?.error?.(`caretaker: ${row.item_id} could not be acted on at step ${ACCEPT_GATE_INDEX}: ${redact(err?.message)}`)
      }
    }
    for (const row of selectEscalated.all()) {
      try {
        if (!reviewPassed(row) || epochRun(row.epoch) < row.arrival_run_id) continue
        if (recordStop(row, 'resolve_escalated', now(), owner())) {
          counts.stopped++
          changed = true
          log?.warn?.(`caretaker: stopped on ${row.item_id}: ${ACCEPT_STOP_TEXT.resolve_escalated}`)
        }
      } catch (err) {
        log?.error?.(`caretaker: ${row.item_id} escalation could not be recorded: ${redact(err?.message)}`)
      }
    }
  } catch (err) {
    log?.error?.(`caretaker Accept pass failed: ${redact(err?.message)}`)
  }
  if (changed) {
    try {
      store.notifyChange()
    } catch (err) {
      log?.error?.(`caretaker: change notification failed: ${redact(err?.message)}`)
    }
  }
  return counts
}

// Boot only. A claim left 'pending' died mid-call: it is never retried, keeps
// its slot in the hourly window, and the next pass stops and pings on it.
export function failInterruptedAcceptActions() {
  return db
    .prepare("UPDATE caretaker_accept_action SET outcome = 'interrupted', error = 'server restarted mid-action — not retried' WHERE outcome = 'pending'")
    .run().changes
}
