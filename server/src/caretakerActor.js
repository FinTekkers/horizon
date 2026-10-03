// Autopilot caretaker, acting stage (HZ-271).
//
// caretaker.js judges each gate arrival once and records a caretaker_eval row
// (HZ-270). For a project whose Autopilot is 'on', this module acts on those
// rows at gates 5, 10 and 15 only: it approves or sends back through the SAME
// two functions the UI's gate routes call. app.js builds them as one
// `gateActions` object and server.js hands that object in; nothing here
// imports github, the orchestrator or premerge, and the only item writes it
// can make are those two calls. It never creates, abandons or reprioritises
// an item, and gate 3 (and gate 13) can never be in ACT_GATES. Gate 13 is
// caretakerAccept.js's own pass (HZ-272), which init() below runs on the same
// triggers with the same gateActions.
//
// It stops — takes no gate action and pings the owner once on WhatsApp — on
// the hourly action limit, the review-cycle cap, or a step that has failed
// twice. It never raises or bypasses either cap; it only reads them.
//
// Owner pings: the first entry of WA_APPROVER_JIDS (waApprovers.ownerJid),
// that one jid only, through the existing sender. Ping and event text name the
// item and the reason only, and every reason and comment goes through redact().
//
// HZ-274: a 'ping_human' decision at gates 5, 10 and 15 in an 'on' project is
// a help ping — one owner message per arrival naming the item and the gate.

import { db } from './db.js'
import * as store from './store.js'
import { STEPS, requiredStepIndex, ACCEPT_GATE_INDEX } from '../../domain/js/lifecycle.js'
import { redact } from './caretakerRules.js'
import { loadPolicy } from './caretaker.js'
import { actOnAcceptGate, failInterruptedAcceptActions } from './caretakerAccept.js'
import { sendWhatsApp } from './waSend.js'
import { ownerJid } from './waApprovers.js'
import { CARETAKER_HOURLY_LIMIT, REVIEW_CYCLE_CAP, WA_NOTIFY_ENABLED, WA_NOTIFY_MAX_ATTEMPTS } from './config.js'

export const ACT_GATES = ['Approve the high-level design', 'Review before execution', 'Review the work & close'].map(
  (label) => requiredStepIndex(label),
)
const NEVER_ACT = [requiredStepIndex('Approve & prioritize this work'), ACCEPT_GATE_INDEX]
if (ACT_GATES.some((g) => NEVER_ACT.includes(g))) {
  throw new Error(`caretakerActor: ACT_GATES ${JSON.stringify(ACT_GATES)} includes gate 3 or gate 13`)
}

export const ACTOR = 'Caretaker'
export const HOUR_MS = 60 * 60 * 1000
const RESWEEP_MS = 60 * 1000
// The step feeding a gate counts as "failed twice" at this many FAILED runs.
const FAILED_RUNS_STOP = 2

// Decisions for the CURRENT arrival of items still parked at the gate, in an
// enabled 'on' project, judged while 'on' (shadow-era rows are never acted
// on), not yet claimed. The last clause is the off-then-on ruling: a switch
// away from 'on' at or after the evaluation retires that decision for good.
// project_event.created_at has one-second resolution, so a switch in the same
// second as the evaluation also retires it — the safe side of the tie.
// HZ-273: exported as the one WHERE fragment (aliases c, w, p) that
// caretakerRuling.js's query shares, so the safety rules have one copy.
export const ACTIONABLE_EVAL_SQL = `p.autopilot = 'on' AND p.enabled = 1 AND c.mode = 'on'
     AND c.gate_index IN (${ACT_GATES.join(',')}) AND w.cursor = c.gate_index
     AND w.abandoned_at IS NULL
     AND c.arrival_run_id = COALESCE((SELECT MAX(s.id) FROM step_run s WHERE s.item_id = w.id
           AND s.step_index = w.cursor - 1 AND s.status = 'done'), 0)
     AND NOT EXISTS (SELECT 1 FROM caretaker_action a WHERE a.eval_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM project_event pe WHERE pe.project_id = p.id AND pe.kind = 'autopilot'
           AND pe.new_value <> 'on' AND pe.created_at >= c.created_at)`
const CANDIDATE_SQL = `
  SELECT c.id AS eval_id, c.item_id, c.gate_index, c.arrival_run_id, c.decision, c.rule_id, c.reason, c.comment,
         w.project_id, w.review_cycle_count, p.name AS project_name
    FROM caretaker_eval c
    JOIN work_item w ON w.id = c.item_id
    JOIN project p ON p.id = w.project_id
   WHERE ${ACTIONABLE_EVAL_SQL}
     AND c.decision IN ('approve','send_back')`
const selectCandidates = db.prepare(`${CANDIDATE_SQL} ORDER BY c.id`)
const selectStillActionable = db.prepare(`${CANDIDATE_SQL} AND c.id = ?`)
const selectMode = db.prepare('SELECT autopilot FROM project WHERE id = ?')
const selectRun = db.prepare('SELECT artifact, output FROM step_run WHERE id = ?')

// Every claimed action holds its slot except 'dropped' (Autopilot went off
// first) and 'skipped' (nothing was sent): a crash mid-action still counts.
const countWindow = db.prepare(
  "SELECT COUNT(*) AS n FROM caretaker_action WHERE project_id = ? AND acted_at_ms > ? AND outcome NOT IN ('dropped','skipped')",
)
const countCaretakerSendBacks = db.prepare(
  "SELECT COUNT(*) AS n FROM caretaker_action WHERE item_id = ? AND gate_index = ? AND action = 'send_back' AND outcome = 'ok'",
)
// failFarmRun() records a failure as cancelled + "FAILED: …". Lifetime count
// for the step that feeds this gate (gate − 1) only.
const countFailedRuns = db.prepare(
  "SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'cancelled' AND output LIKE 'FAILED:%'",
)
const insertAction = db.prepare(`
  INSERT INTO caretaker_action (eval_id, project_id, item_id, gate_index, action, outcome, error, acted_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
const finishAction = db.prepare('UPDATE caretaker_action SET outcome = ?, error = ? WHERE id = ?')
const insertEvent = db.prepare(
  "INSERT INTO event (item_id, who, text, color, initials) VALUES (?, 'Caretaker', ?, '#4A6B5D', 'CT')",
)
const insertPing = db.prepare(`
  INSERT OR IGNORE INTO caretaker_ping (project_id, item_id, reason, dedupe_key, recipient, body, created_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)
const selectRecentLimitPing = db.prepare(
  "SELECT 1 FROM caretaker_ping WHERE project_id = ? AND reason = 'hourly_limit' AND created_at_ms > ? LIMIT 1",
)

// HZ-274: 'ping_human' decisions for the CURRENT arrival of items still parked
// at an act gate, in an enabled 'on' project, judged while 'on'. Same arrival
// rule as CANDIDATE_SQL; gate 13 stops ping from caretakerAccept.js instead.
const selectHelpCandidates = db.prepare(`
  SELECT c.id AS eval_id, c.item_id, c.gate_index, w.project_id, w.title
    FROM caretaker_eval c
    JOIN work_item w ON w.id = c.item_id
    JOIN project p ON p.id = w.project_id
   WHERE p.autopilot = 'on' AND p.enabled = 1 AND c.mode = 'on' AND c.decision = 'ping_human'
     AND c.gate_index IN (${ACT_GATES.join(',')}) AND w.cursor = c.gate_index AND w.abandoned_at IS NULL
     AND c.arrival_run_id = COALESCE((SELECT MAX(s.id) FROM step_run s WHERE s.item_id = w.id
           AND s.step_index = w.cursor - 1 AND s.status = 'done'), 0)
   ORDER BY c.id`)

// One 'needs_human' ping per caretaker_eval row, i.e. per gate arrival: the
// dedupe key is the eval id, held UNIQUE in SQLite, so a repeat tick, a
// restart or a deploy adds nothing and only a new arrival (a new eval) pings
// again. The body names the item, its title and the gate — never the eval's
// free-text reason. Returns how many were queued.
export function queueHelpPings({ now = Date.now, owner = ownerJid } = {}) {
  let queued = 0
  for (const c of selectHelpCandidates.all()) {
    const body = redact(
      `Autopilot needs you: ${c.item_id} "${c.title}" is waiting at step ${c.gate_index} (${STEPS[c.gate_index].label}).`,
    )
    queued += insertPing.run(c.project_id, c.item_id, 'needs_human', `help:${c.eval_id}`, owner() || '', body, now()).changes
  }
  return queued
}

export const STALL_TEXT = {
  review_cycle_cap: 'review-cycle cap reached',
  step_failed_twice: 'the step before this gate has failed twice',
}

// Persisted, so a restart does not reset it.
export function actionsInWindow(projectId, nowMs) {
  return countWindow.get(projectId, nowMs - HOUR_MS).n
}

// `c` needs item_id, gate_index and review_cycle_count. HZ-273's rulings stop
// on the same caps through this.
export function stallReason(c) {
  if (c.review_cycle_count >= REVIEW_CYCLE_CAP) return 'review_cycle_cap'
  // The caretaker's own send-backs reset the item's review cycles, so they
  // are counted too — an endless caretaker send-back loop stops at the cap.
  if (countCaretakerSendBacks.get(c.item_id, c.gate_index).n >= REVIEW_CYCLE_CAP) return 'review_cycle_cap'
  if (countFailedRuns.get(c.item_id, c.gate_index - 1).n >= FAILED_RUNS_STOP) return 'step_failed_twice'
  return null
}

// One ping and one event per (arrival, reason); a repeat tick adds nothing.
function recordStall(c, reason, nowMs, owner) {
  const label = STEPS[c.gate_index].label
  const body = redact(`Horizon caretaker stopped on ${c.item_id} at ${label}: ${STALL_TEXT[reason]}. Waiting for you.`)
  return db.transaction(() => {
    const key = `stall:${c.item_id}:${c.gate_index}:${c.arrival_run_id}:${reason}`
    const row = insertPing.run(c.project_id, c.item_id, reason, key, owner || '', body, nowMs)
    if (row.changes !== 1) return false
    insertEvent.run(c.item_id, `caretaker stopped (${STALL_TEXT[reason]}) — pinged the owner`)
    return true
  })()
}

// One ping per project per hour of limit hits: the only dedupe rule. The key
// just has to be unique; nothing reads meaning into it.
function recordLimitHit(c, nowMs, owner, limit) {
  if (selectRecentLimitPing.get(c.project_id, nowMs - HOUR_MS)) return false
  const body = redact(
    `Horizon caretaker hit ${limit} gate actions/hour on project ${c.project_name}. Actions resume when the hour window allows.`,
  )
  insertPing.run(c.project_id, null, 'hourly_limit', `limit:${c.project_id}:${nowMs}`, owner || '', body, nowMs)
  return true
}

const FENCE = /^\s*(```|~~~)/
const headingLevel = (line) => (/^#+\s/.test(line.trim()) ? line.trim().match(/^#+/)[0].length : 0)

// One `## Heading` section of a markdown artifact, VERBATIM: every byte of
// its lines up to the next heading of the same or higher level, trailing
// spaces, blank lines and fenced code (a `# line` inside a fence is not a
// heading) kept; only blank lines before and after it are dropped. '' when
// the section is absent.
export function sectionVerbatim(text, heading) {
  const lines = String(text ?? '').split('\n')
  const level = headingLevel(heading)
  let fenced = false
  let start = -1
  for (let i = 0; i < lines.length && start === -1; i++) {
    if (FENCE.test(lines[i])) fenced = !fenced
    else if (!fenced && (lines[i].trim() === heading || lines[i].trim().startsWith(`${heading} `))) start = i
  }
  if (start === -1) return ''
  let end = lines.length
  fenced = false
  for (let i = start + 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fenced = !fenced
    else if (!fenced && headingLevel(lines[i]) > 0 && headingLevel(lines[i]) <= level) {
      end = i
      break
    }
  }
  const body = lines.slice(start + 1, end)
  while (body.length && !body[0].trim()) body.shift()
  while (body.length && !body[body.length - 1].trim()) body.pop()
  return body.join('\n')
}

// The send-back comment. When the deciding rule names a commentSection (gate
// 10: the PM's ## Actions), that section is re-read from the source run
// verbatim — the decision row holds HZ-270's tidied copy. Otherwise, or when
// it cannot be read, the stored comment. Either way redact() has replaced any
// secret (operator ruling: redaction wins over verbatim).
function sendBackComment(c, log) {
  try {
    const rule = c.rule_id ? loadPolicy().rules.find((r) => r.id === c.rule_id) : null
    if (rule?.commentSection) {
      const run = selectRun.get(c.arrival_run_id)
      const raw = sectionVerbatim(run ? run.artifact || run.output || '' : '', rule.commentSection)
      if (raw.trim()) return redact(raw, { oneLine: false })
    }
  } catch (err) {
    log?.warn?.(`caretaker: ${c.item_id} send-back comment fell back to the stored one: ${redact(err?.message)}`)
  }
  return c.comment
}

let acting = false

// Exported for the tests; init() below is the only production caller. Never
// throws. `gateActions` is app.js's object, read at call time.
export async function actOnDecisions({
  gateActions,
  log,
  now = Date.now,
  send = sendWhatsApp,
  owner = ownerJid,
  limit = CARETAKER_HOURLY_LIMIT,
} = {}) {
  const counts = { acted: 0, dropped: 0, stalled: 0, limited: 0 }
  // An approval's own notify() lands here while acting; it is dropped, and
  // the 60s interval in init() picks up anything it would have found.
  if (acting) return { ...counts, skipped: true }
  acting = true
  let changed = false
  try {
    // Inside the acting guard, so two passes cannot race on the same arrival;
    // the drain below sends what this queued.
    try {
      const queued = queueHelpPings({ now, owner })
      if (queued > 0) log?.info?.(`caretaker: ${queued} item(s) need a human — pinged the owner`)
    } catch (err) {
      log?.error?.(`caretaker: help pings could not be queued: ${redact(err?.message)}`)
    }
    for (const c of selectCandidates.all()) {
      try {
        const nowMs = now()
        // Once Autopilot is off, not even a ping: straight to the claim below,
        // which records the decision as dropped.
        const stillOn = selectMode.get(c.project_id)?.autopilot === 'on'
        const stall = stillOn ? stallReason(c) : null
        if (stall) {
          if (recordStall(c, stall, nowMs, owner())) {
            counts.stalled++
            changed = true
            log?.warn?.(`caretaker: stopped on ${c.item_id} at step ${c.gate_index}: ${STALL_TEXT[stall]}`)
          }
          continue
        }
        if (stillOn && actionsInWindow(c.project_id, nowMs) >= limit) {
          counts.limited++
          if (recordLimitHit(c, nowMs, owner(), limit)) log?.warn?.(`caretaker: hourly limit (${limit}) hit on project ${c.project_id}`)
          continue
        }
        // Claim, after re-reading the mode, in one transaction. The gate call
        // below then STARTS in the same synchronous tick, so no Autopilot
        // switch can land between the re-read and the call. A switch to 'off'
        // while an approval is already awaiting (premerge, GitHub) cannot
        // cancel that one call; every later candidate is dropped here.
        const comment = c.decision === 'send_back' ? sendBackComment(c, log) : null
        let claim = null
        db.transaction(() => {
          if (selectMode.get(c.project_id)?.autopilot !== 'on') {
            insertAction.run(c.eval_id, c.project_id, c.item_id, c.gate_index, c.decision, 'dropped', 'Autopilot is no longer on', nowMs)
            claim = 'dropped'
            return
          }
          // The item moved, a human acted, or the mode went off and back on.
          if (!selectStillActionable.get(c.eval_id)) return
          if (c.decision === 'send_back' && !comment?.trim()) {
            insertAction.run(c.eval_id, c.project_id, c.item_id, c.gate_index, c.decision, 'skipped', 'no comment to send back with', nowMs)
            insertEvent.run(c.item_id, 'caretaker could not act (the send-back has no comment) — left for a human')
            claim = 'skipped'
            return
          }
          claim = insertAction.run(c.eval_id, c.project_id, c.item_id, c.gate_index, c.decision, 'pending', null, nowMs).lastInsertRowid
        })()
        if (claim === 'dropped') {
          counts.dropped++
          continue
        }
        if (claim === 'skipped') {
          changed = true
          continue
        }
        if (claim === null) continue

        let result
        try {
          // Empty approval notes: the reason is never queued as agent feedback.
          result =
            c.decision === 'approve'
              ? await gateActions.approve(c.item_id, c.gate_index, '', ACTOR)
              : await gateActions.sendBack(c.item_id, { target: STEPS[c.gate_index].label, feedback: comment }, ACTOR)
        } catch (err) {
          result = { error: err?.message || String(err) }
        }
        changed = true
        const reason = redact(c.reason)
        if (result && !result.error) {
          finishAction.run('ok', null, claim)
          insertEvent.run(c.item_id, c.decision === 'approve' ? `auto-approved by caretaker (${reason})` : `sent back by caretaker (${reason})`)
          counts.acted++
          log?.info?.(`caretaker: ${c.decision} on ${c.item_id} at step ${c.gate_index}`)
        } else {
          const error = redact(result?.error ?? 'no result')
          finishAction.run('failed', error, claim)
          insertEvent.run(c.item_id, `caretaker could not act (${error}) — left for a human`)
          log?.warn?.(`caretaker: could not ${c.decision} ${c.item_id} at step ${c.gate_index}: ${error}`)
        }
      } catch (err) {
        log?.error?.(`caretaker: ${c.item_id} could not be acted on: ${redact(err?.message)}`)
      }
    }
  } catch (err) {
    log?.error?.(`caretaker act pass failed: ${redact(err?.message)}`)
  } finally {
    acting = false
  }
  if (changed) {
    try {
      store.notifyChange()
    } catch (err) {
      log?.error?.(`caretaker: change notification failed: ${redact(err?.message)}`)
    }
  }
  try {
    const { failed } = await drainPings({ send, now })
    if (failed > 0) log?.warn?.(`caretaker: ${failed} owner ping(s) failed and will be retried`)
  } catch (err) {
    log?.error?.(`caretaker ping drain failed: ${redact(err?.message)}`)
  }
  return counts
}

let drainingPings = false

// Delivers pending owner pings. A no-op unless WA_NOTIFY_ENABLED, like the
// gate notifier; the rows wait. Same backoff and give-up rule as its outbox.
export async function drainPings({ send = sendWhatsApp, now = Date.now } = {}) {
  if (!WA_NOTIFY_ENABLED || drainingPings) return { sent: 0, failed: 0, skipped: true }
  drainingPings = true
  let sent = 0
  let failed = 0
  try {
    for (;;) {
      const row = db
        .prepare(
          `SELECT g.id, g.recipient, g.body, g.attempts, g.reason, p.autopilot
             FROM caretaker_ping g JOIN project p ON p.id = g.project_id
            WHERE g.status = 'pending' AND g.next_attempt_at_ms <= ? ORDER BY g.id LIMIT 1`,
        )
        .get(now())
      if (!row) break
      // HZ-274: a help ping still waiting when Autopilot left 'on' is not sent
      // — the owner switched the caretaker off, so it no longer asks for help.
      if (row.reason === 'needs_human' && row.autopilot !== 'on') {
        db.prepare("UPDATE caretaker_ping SET status = 'failed', last_error = 'Autopilot is no longer on — not sent' WHERE id = ?").run(row.id)
        continue
      }
      if (!row.recipient) {
        db.prepare("UPDATE caretaker_ping SET status = 'failed', last_error = 'no owner: WA_APPROVER_JIDS is empty' WHERE id = ?").run(row.id)
        failed++
        continue
      }
      const won = db.prepare("UPDATE caretaker_ping SET status = 'sending' WHERE id = ? AND status = 'pending'").run(row.id)
      if (won.changes !== 1) continue
      try {
        await send(row.recipient, row.body)
        db.prepare("UPDATE caretaker_ping SET status = 'sent', sent_at = datetime('now'), last_error = NULL WHERE id = ?").run(row.id)
        sent++
      } catch (err) {
        failed++
        const attempts = row.attempts + 1
        const delayS = Math.min(60 * 2 ** (attempts - 1), 3600)
        db.prepare(
          'UPDATE caretaker_ping SET status = ?, attempts = ?, last_error = ?, next_attempt_at_ms = ? WHERE id = ?',
        ).run(attempts >= WA_NOTIFY_MAX_ATTEMPTS ? 'failed' : 'pending', attempts, redact(err?.message || err), now() + delayS * 1000, row.id)
      }
    }
  } finally {
    drainingPings = false
  }
  return { sent, failed }
}

// Boot only. An action left 'pending' died mid-call: it is never retried and
// keeps its slot in the hourly window. A ping left 'sending' may have gone
// out, so it is not resent (at most one ping).
export function failInterruptedActions() {
  db.prepare(
    "UPDATE caretaker_ping SET status = 'failed', last_error = 'interrupted — process exited mid-send, not resent' WHERE status = 'sending'",
  ).run()
  return db
    .prepare("UPDATE caretaker_action SET outcome = 'interrupted', error = 'server restarted mid-action — not retried' WHERE outcome = 'pending'")
    .run().changes
}

// server.js calls this AFTER caretaker.init(), so on any one change the
// caretaker's listener has recorded its decision before this one looks.
// Change signals are coalesced onto the next turn of the event loop, so an
// action never runs inside another mutation's notify(). Returns stop() for
// the tests. `opts` (now, send, owner, limit) are for the tests too.
export function init(log, { gateActions, ...opts } = {}) {
  if (!gateActions) throw new Error('caretakerActor.init needs the gateActions app.js builds')
  const interrupted = failInterruptedActions() + failInterruptedAcceptActions()
  if (interrupted > 0) log?.warn?.(`caretaker: ${interrupted} gate action(s) were mid-call at shutdown — not retried`)
  // Gate 13 first: it is synchronous and never waits on a runner, so a slow
  // gate-15 approval in actOnDecisions cannot hold it up, and the pings it
  // records are drained by the actOnDecisions that follows.
  const run = () => {
    actOnAcceptGate({
      gateActions,
      actor: ACTOR,
      log,
      now: opts.now ?? Date.now,
      owner: opts.owner ?? ownerJid,
      limit: opts.limit ?? CARETAKER_HOURLY_LIMIT,
    })
    return actOnDecisions({ gateActions, log, ...opts })
  }
  let scheduled = false
  const unsubscribe = store.onChange(() => {
    if (scheduled) return
    scheduled = true
    setImmediate(() => {
      scheduled = false
      run()
    })
  })
  run()
  const timer = setInterval(run, RESWEEP_MS)
  timer.unref?.()
  return {
    stop() {
      unsubscribe()
      clearInterval(timer)
    },
  }
}
