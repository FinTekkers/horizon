// Autopilot caretaker, shadow mode (HZ-270).
//
// When an item in an Autopilot 'shadow' or 'on' project arrives at a gate, the
// caretaker judges it once against farm/roles/caretaker.md and records one
// "caretaker would …" item event. It acts on nothing — 'on' runs exactly the
// shadow path until Autopilot 2–5 add acting.
//
// DERIVED STATE, like gateNotifier.js. No cursor write site is touched: the
// sweep runs from store.onChange, after the write has committed, and looks
// for gate arrivals with no caretaker_eval row yet. An arrival is keyed by
// (item, gate, the done step_run that fed the gate), which caretaker_eval
// holds UNIQUE — so a re-run, an off/on toggle or a restart adds nothing, and
// a send-back re-arrival (a new source run) is judged afresh.
//
// READ-ONLY BY CONSTRUCTION. This module imports no github, orchestrator,
// premerge, autoResolve, waSend or gateNotifier, and writes only its own
// caretaker_eval row and the item event. server.js init() is the only caller.

import { db } from './db.js'
import * as store from './store.js'
import { listTargetStatuses } from './deploy.js'
import { readFarmFile } from './definitions.js'
import { gateStepIndexes, requiredStepIndex, ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'
import { DECISIONS, decide, parsePolicy, redact } from './caretakerRules.js'

// Gate 3 is excluded HERE, in code, before any evaluation in any mode: new
// work never enters without a human.
const APPROVE_AND_PRIORITIZE = requiredStepIndex('Approve & prioritize this work')
export const CARETAKER_GATES = gateStepIndexes().filter((i) => i !== APPROVE_AND_PRIORITIZE)
const RELEASE_GATE = requiredStepIndex('Review the work & close')
// How long gate 15 waits for the webhook deploy to log an outcome before it
// is judged on whatever is on record (which then pings the human).
export const RELEASE_SETTLE_MS = 30 * 60 * 1000
const RESWEEP_MS = 60 * 1000

// The candidate set is only live items in shadow/on projects, parked at a
// caretaker gate (so never closed), whose current arrival has no row yet. An 'off' project's items never
// match, so its behaviour is untouched.
const selectCandidates = db.prepare(`
  SELECT w.*, p.autopilot FROM work_item w JOIN project p ON p.id = w.project_id
   WHERE p.autopilot IN ('shadow','on')
     AND w.cursor IN (${CARETAKER_GATES.map(() => '?').join(',')})
     AND w.abandoned_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM caretaker_eval c
        WHERE c.item_id = w.id AND c.gate_index = w.cursor
          AND c.arrival_run_id = COALESCE((SELECT MAX(s.id) FROM step_run s
                WHERE s.item_id = w.id AND s.step_index = w.cursor - 1 AND s.status = 'done'), 0))
`)
const selectSourceRun = db.prepare(
  "SELECT id, output, artifact, started_at, ended_at FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'done' ORDER BY id DESC LIMIT 1",
)
const insertEval = db.prepare(`
  INSERT OR IGNORE INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, rule_id, reason, comment)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
const insertEvent = db.prepare(
  "INSERT INTO event (item_id, who, text, color, initials) VALUES (?, 'Caretaker', ?, '#4A6B5D', 'CT')",
)
const linkEvent = db.prepare('UPDATE caretaker_eval SET event_id = ? WHERE id = ?')

// What the rules may look at, all read from persisted state.
export function gatherFacts(item, gateIndex, sourceRun) {
  const facts = {
    artifact: sourceRun ? sourceRun.artifact || sourceRun.output || '' : '',
    runningKinds: store.listRunningGateActions().filter((r) => r.itemId === item.id).map((r) => r.kind),
    mergeable: item.pr_mergeable ?? null,
    // A failing review reaches Accept the code only by being forwarded
    // (HZ-185), which records that review's run id; any other arrival passed.
    review: gateIndex === ACCEPT_GATE_INDEX && sourceRun ? (sourceRun.id === item.forwarded_review_run_id ? 'fail' : 'pass') : null,
    releaseTag: item.release_tag ?? null,
    lastGoodTag: null,
  }
  if (gateIndex === RELEASE_GATE) {
    facts.lastGoodTag = bareTag(releaseTarget(item)?.lastTag)
  }
  return facts
}

// deploy-*.sh writes last-good-tag as "refs/tags/<tag>:<commit>".
const bareTag = (ref) => (ref ? ref.replace(/^refs\/tags\//, '') : null)
const releaseTarget = (item) => listTargetStatuses().find((t) => t.repo === item.repo)
// SQLite datetime('now') is UTC without a zone; the deploy log is ISO with Z.
const toMs = (sqlTime) => (sqlTime ? Date.parse(`${sqlTime.replace(' ', 'T')}Z`) : NaN)

// Gate 15 arrives as soon as the release is published; the webhook deploy
// that writes last-good-tag finishes later. Judge the arrival only once the
// deploy has settled: this release is last-good, a deploy outcome was logged
// after the arrival, or RELEASE_SETTLE_MS passed. Until then record nothing,
// so a later sweep (onChange, boot, or the periodic re-sweep) judges it.
export function releaseSettled(item, sourceRun, now = Date.now()) {
  if (!item.release_tag) return true
  const target = releaseTarget(item)
  if (!target) return true
  if (bareTag(target.lastTag) === item.release_tag) return true
  const arrivedAt = toMs(sourceRun?.ended_at ?? sourceRun?.started_at)
  if (Number.isNaN(arrivedAt)) return true
  const loggedAt = Date.parse(target.lastAt ?? '')
  if (!Number.isNaN(loggedAt) && loggedAt >= arrivedAt - 1000) return true
  return now - arrivedAt >= RELEASE_SETTLE_MS
}

// One decision for one arrival, never a throw. null for a non-caretaker gate:
// the second, belt-and-braces gate-3 guard behind the SQL filter.
export function evaluateArrival(item, gateIndex, policyOrError, sourceRun = null, log) {
  if (!CARETAKER_GATES.includes(gateIndex)) return null
  try {
    if (policyOrError instanceof Error) throw policyOrError
    return decide(gateIndex, gatherFacts(item, gateIndex, sourceRun), policyOrError)
  } catch (err) {
    log?.warn?.(`caretaker: ${item.id} at step ${gateIndex} could not be judged: ${redact(err.message)}`)
    return { decision: 'wait', ruleId: null, reason: redact(`caretaker error: ${err.message}`), comment: null }
  }
}

export function loadPolicy() {
  const text = readFarmFile('roles/caretaker.md')
  if (text === null) throw new Error('farm/roles/caretaker.md is missing')
  return parsePolicy(text)
}

// Exported for the tests; init() below is the only production caller.
// `policy` is injectable so a test can drive a mutated or broken policy.
export function sweepCaretaker({ log, policy = loadPolicy } = {}) {
  let recorded = 0
  try {
    const candidates = selectCandidates.all(...CARETAKER_GATES)
    if (candidates.length === 0) return { recorded }
    let loaded
    try {
      loaded = policy()
    } catch (err) {
      log?.warn?.(`caretaker: policy could not be loaded: ${redact(err.message)}`)
      loaded = new Error(`policy unavailable: ${err.message}`)
    }
    for (const item of candidates) {
      try {
        const sourceRun = selectSourceRun.get(item.id, item.cursor - 1) ?? null
        if (item.cursor === RELEASE_GATE && !releaseSettled(item, sourceRun)) continue
        const result = evaluateArrival(item, item.cursor, loaded, sourceRun, log)
        if (!result) continue
        // Several arrivals with no source run share key 0, so at most one of
        // them is judged — fewer events, never a duplicate.
        db.transaction(() => {
          const row = insertEval.run(item.id, item.cursor, sourceRun?.id ?? 0, item.autopilot, result.decision, result.ruleId, result.reason, result.comment)
          if (row.changes !== 1) return
          const text = `caretaker would ${DECISIONS[result.decision]} — ${result.reason}`
          linkEvent.run(insertEvent.run(item.id, text).lastInsertRowid, row.lastInsertRowid)
          recorded++
        })()
      } catch (err) {
        log?.error?.(`caretaker: ${item.id} could not be recorded: ${redact(err.message)}`)
      }
    }
  } catch (err) {
    log?.error?.(`caretaker sweep failed: ${redact(err.message)}`)
  }
  if (recorded > 0) store.notifyChange()
  return { recorded }
}

// Never throws, so a broken caretaker cannot fail a human gate action whose
// onChange it rides on. `opts.policy` is for the tests. The periodic re-sweep
// picks up gate-15 arrivals once their deploy settles, since a deploy writes
// files, not the DB, and so fires no onChange.
export function init(log, { policy = loadPolicy } = {}) {
  store.onChange(() => sweepCaretaker({ log, policy }))
  sweepCaretaker({ log, policy })
  setInterval(() => sweepCaretaker({ log, policy }), RESWEEP_MS).unref()
}
