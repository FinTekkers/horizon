// Autopilot caretaker, rulings (HZ-273).
//
// When a PM, architect or QA artifact says `Operator must decide:`, caretaker.js
// records an 'any.operator_decide' decision (still 'ping_human', so shadow mode
// and caretakerActor.js are unchanged). For a project whose Autopilot is 'on',
// this module rules on it: the farm proposes a line-level rewording of the
// item's metric or guardrails, caretakerRulingRules.js checks it in code, and
// only an accepted ruling is written —
//
//   1. to the GitHub issue body, the source of truth, changing only the named
//      lines (github.patchIssueBodyLines);
//   2. to the DB, ONLY through store.upsertFromGithub with the issue GitHub
//      sent back, then checked to match the body;
//   3. as a note to the step that re-runs, through the same send-back the UI
//      calls (app.js's gateActions) — whose one event carries the ruling, its
//      reason and the before/after text.
//
// Anything the checks reject, or that fails, is left for the human with one
// event saying why. Rulings run at gates 5 and 10 only — the gates fed by the
// planning steps. Gate 3 can never be a candidate (ACT_GATES excludes it), and
// a ruling never approves anything. It shares caretakerActor.js's candidate
// filter, stop caps and hourly limit rather than copying them: an applied
// ruling's send-back is a caretaker_action row, so it counts toward both the
// hourly limit and the gate's REVIEW_CYCLE_CAP.

import { db } from './db.js'
import * as store from './store.js'
import * as github from './github.js'
import { farmFetch } from './orchestrator.js'
import { STEPS, requiredStepIndex } from '../../domain/js/lifecycle.js'
import { operatorDecideLines, redact } from './caretakerRules.js'
import { loadPolicy } from './caretaker.js'
import { ACTOR, ACTIONABLE_EVAL_SQL, STALL_TEXT, actionsInWindow, stallReason } from './caretakerActor.js'
import { RULING_FIELDS, validateRuling } from './caretakerRulingRules.js'
import { CARETAKER_HOURLY_LIMIT, FARM_URL } from './config.js'

export const RULING_RULE_ID = 'any.operator_decide'
export const RULING_GATES = ['Approve the high-level design', 'Review before execution'].map((label) => requiredStepIndex(label))
const RESWEEP_MS = 60 * 1000
// One bounded model call on the farm; under farmFetch's header ceiling.
const RULING_FARM_MS = 180_000

const RULING_SQL = `
  SELECT c.id AS eval_id, c.item_id, c.gate_index, c.arrival_run_id, w.project_id, w.review_cycle_count
    FROM caretaker_eval c
    JOIN work_item w ON w.id = c.item_id
    JOIN project p ON p.id = w.project_id
   WHERE ${ACTIONABLE_EVAL_SQL}
     AND c.rule_id = '${RULING_RULE_ID}' AND c.gate_index IN (${RULING_GATES.join(',')})`
const selectCandidates = db.prepare(
  `${RULING_SQL} AND NOT EXISTS (SELECT 1 FROM caretaker_ruling r WHERE r.eval_id = c.id) ORDER BY c.id`,
)
const selectStillActionable = db.prepare(`${RULING_SQL} AND c.id = ?`)
const selectMode = db.prepare('SELECT autopilot FROM project WHERE id = ?')
const selectRun = db.prepare('SELECT artifact, output FROM step_run WHERE id = ?')
const insertRuling = db.prepare(`
  INSERT OR IGNORE INTO caretaker_ruling (eval_id, project_id, item_id, gate_index, outcome, code, created_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)
const recordProposal = db.prepare('UPDATE caretaker_ruling SET kind = ?, reason = ?, edits = ? WHERE id = ?')
const finishRuling = db.prepare('UPDATE caretaker_ruling SET outcome = ?, code = ? WHERE id = ?')
const insertAction = db.prepare(`
  INSERT INTO caretaker_action (eval_id, project_id, item_id, gate_index, action, outcome, error, acted_at_ms)
  VALUES (?, ?, ?, ?, 'send_back', ?, ?, ?)
`)
const insertEvent = db.prepare(
  "INSERT INTO event (item_id, who, text, color, initials) VALUES (?, 'Caretaker', ?, '#4A6B5D', 'CT')",
)

const multiline = (text) => redact(text, { oneLine: false })
const notRuled = (why) => `caretaker did not rule (${redact(why)}) — left for a human`
const editLines = (edits) => edits.map((e) => `- ${e.field}: "${e.before}" → "${e.after}"`).join('\n')

// The note the re-run step reads, and the text of the send-back event.
export function rulingNote({ kind, reason, edits }) {
  return multiline(`Caretaker ruling: ${redact(reason)}\nEdited in the issue body (${kind}):\n${editLines(edits)}`)
}

// The farm's proposal, never trusted: validateRuling() decides.
export async function proposeRuling({ itemId, request, metric, guardrails }) {
  if (!FARM_URL) throw new Error('no farm is configured')
  return farmFetch('/caretaker/ruling', { item_id: itemId, request, metric, guardrails }, { timeoutMs: RULING_FARM_MS })
}

// Every `Operator must decide:` line of the run that fed the gate.
function operatorRequest(c) {
  const rule = loadPolicy().rules.find((r) => r.id === RULING_RULE_ID)
  const run = selectRun.get(c.arrival_run_id)
  if (!rule || !run) return ''
  return multiline(operatorDecideLines(rule, run.artifact || run.output || '').join('\n'))
}

// Each parsed field the body carries must equal the DB's, and each edited
// field must read exactly as the validator computed it.
function syncedCopyMatches(itemId, issue, verdict) {
  const parsed = store.parseIssueBody(issue?.body)
  const synced = store.getItem(itemId)
  const edited = new Set(verdict.edits.map((e) => e.field))
  return RULING_FIELDS.every(
    (field) =>
      (!parsed[field] || synced?.[field] === parsed[field]) && (!edited.has(field) || parsed[field] === verdict.next[field]),
  )
}

// One candidate, start to finish. Returns the outcome, or null when another
// pass already claimed it.
async function ruleOn(c, { gateActions, log, now, propose }) {
  const nowMs = now()
  let claim = null
  db.transaction(() => {
    if (selectMode.get(c.project_id)?.autopilot !== 'on') {
      if (insertRuling.run(c.eval_id, c.project_id, c.item_id, c.gate_index, 'dropped', 'autopilot_off', nowMs).changes) claim = 'dropped'
      return
    }
    const row = insertRuling.run(c.eval_id, c.project_id, c.item_id, c.gate_index, 'pending', null, nowMs)
    if (row.changes === 1) claim = row.lastInsertRowid
  })()
  if (claim === null || claim === 'dropped') return claim

  // `text` is the whole event; before/after text in it is never cut.
  const leave = (outcome, code, text) => {
    finishRuling.run(outcome, code, claim)
    insertEvent.run(c.item_id, multiline(text))
    log?.warn?.(`caretaker: no ruling on ${c.item_id} at step ${c.gate_index}: ${code}`)
    return outcome
  }
  const stall = stallReason(c)
  if (stall) return leave('rejected', stall, notRuled(STALL_TEXT[stall]))

  const item = store.getItem(c.item_id)
  let current
  let proposal
  try {
    const request = operatorRequest(c)
    if (!request) return leave('rejected', 'no_request', notRuled('no "Operator must decide:" line could be read'))
    current = store.parseIssueBody(await github.getIssueBody(item))
    proposal = await propose({ itemId: c.item_id, request, metric: current.metric, guardrails: current.guardrails })
  } catch (err) {
    return leave('failed', 'proposal_failed', notRuled(`could not get a ruling: ${err?.message || err}`))
  }
  const verdict = validateRuling(proposal, current)
  if (!verdict.ok) return leave('rejected', verdict.code, notRuled(`${verdict.code}: ${verdict.detail}`))

  // The model call took a while: Autopilot may have gone off, or the item
  // moved or was acted on. Either way nothing is written.
  if (selectMode.get(c.project_id)?.autopilot !== 'on' || !selectStillActionable.get(c.eval_id)) {
    finishRuling.run('dropped', 'no_longer_actionable', claim)
    return 'dropped'
  }
  const edits = verdict.edits.map((e) => ({ field: e.field, before: multiline(e.before), after: multiline(e.after) }))
  recordProposal.run(verdict.kind, redact(verdict.reason), JSON.stringify(edits), claim)

  let issue
  try {
    issue = await github.patchIssueBodyLines(item, verdict.edits)
  } catch (err) {
    const code = err?.code === 'stale_body' ? 'stale_body' : 'patch_failed'
    const why = redact(err?.message || err)
    return leave('failed', code, `caretaker could not edit the issue (${why}) — left for a human. The edit was:\n${editLines(edits)}`)
  }
  try {
    store.upsertFromGithub(issue, item.repo)
  } catch (err) {
    log?.error?.(`caretaker: ${c.item_id} ruling sync failed: ${redact(err?.message)}`)
  }
  if (!syncedCopyMatches(c.item_id, issue, verdict)) {
    const text = 'caretaker edited the issue, but the synced copy does not match it — left for a human. The edit was:'
    return leave('failed', 'sync_mismatch', `${text}\n${editLines(edits)}`)
  }

  const note = rulingNote({ kind: verdict.kind, reason: verdict.reason, edits })
  // Re-checked in the same tick the send-back starts, as caretakerActor does:
  // a human may have acted while the issue was being edited.
  const sent = selectMode.get(c.project_id)?.autopilot === 'on' && !!selectStillActionable.get(c.eval_id)
  let result = { error: 'the item moved or Autopilot went off before the send-back' }
  if (sent) {
    try {
      result = await gateActions.sendBack(c.item_id, { target: STEPS[c.gate_index].label, feedback: note }, ACTOR)
    } catch (err) {
      result = { error: err?.message || String(err) }
    }
  }
  const ok = !!result && !result.error
  const error = ok ? null : redact(result?.error ?? 'no result')
  db.transaction(() => {
    finishRuling.run('applied', ok ? null : 'send_back_failed', claim)
    insertAction.run(c.eval_id, c.project_id, c.item_id, c.gate_index, ok ? 'ok' : sent ? 'failed' : 'skipped', error, now())
    // A successful send-back's own event already carries the note.
    if (!ok) insertEvent.run(c.item_id, multiline(`caretaker ruled but could not send back (${error}) — left for a human\n${note}`))
  })()
  log?.info?.(`caretaker: ruled (${verdict.kind}) on ${c.item_id} at step ${c.gate_index}`)
  return 'applied'
}

let ruling = false

// Exported for the tests; init() below is the only production caller. Never
// throws. `propose` is injectable so a test can stand in for the farm.
export async function actOnRulings({
  gateActions,
  log,
  now = Date.now,
  propose = proposeRuling,
  limit = CARETAKER_HOURLY_LIMIT,
} = {}) {
  const counts = { applied: 0, rejected: 0, failed: 0, dropped: 0, limited: 0 }
  if (ruling) return { ...counts, skipped: true }
  ruling = true
  let changed = false
  try {
    for (const c of selectCandidates.all()) {
      try {
        if (actionsInWindow(c.project_id, now()) >= limit) {
          counts.limited++
          continue
        }
        const outcome = await ruleOn(c, { gateActions, log, now, propose })
        if (outcome) {
          counts[outcome]++
          changed = true
        }
      } catch (err) {
        log?.error?.(`caretaker: ${c.item_id} could not be ruled on: ${redact(err?.message)}`)
      }
    }
  } catch (err) {
    log?.error?.(`caretaker ruling pass failed: ${redact(err?.message)}`)
  } finally {
    ruling = false
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

// Boot only. A ruling left 'pending' died mid-way and is never retried. If it
// had got as far as recording its edit, the issue may already hold it, so its
// before/after goes on record now: no silent edits, even across a crash.
export function failInterruptedRulings() {
  const rows = db.prepare("SELECT id, item_id, edits FROM caretaker_ruling WHERE outcome = 'pending'").all()
  db.transaction(() => {
    for (const row of rows) {
      finishRuling.run('failed', 'interrupted', row.id)
      let edits = []
      try {
        edits = JSON.parse(row.edits || '[]')
      } catch {
        edits = []
      }
      if (Array.isArray(edits) && edits.length > 0) {
        insertEvent.run(
          row.item_id,
          multiline(`caretaker ruling interrupted by a restart — the issue may already hold this edit, left for a human:\n${editLines(edits)}`),
        )
      }
    }
  })()
  return rows.length
}

// Same shape as caretakerActor.init: server.js calls it after that one, change
// signals are coalesced onto the next turn, and a 60s re-sweep picks up what a
// signal missed. Returns stop() for the tests.
export function init(log, { gateActions, ...opts } = {}) {
  if (!gateActions) throw new Error('caretakerRuling.init needs the gateActions app.js builds')
  const interrupted = failInterruptedRulings()
  if (interrupted > 0) log?.warn?.(`caretaker: ${interrupted} ruling(s) were mid-way at shutdown — not retried`)
  const run = () => actOnRulings({ gateActions, log, ...opts })
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
