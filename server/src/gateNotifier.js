// Gate-arrival WhatsApp notification (HZ-141).
//
// Nothing tells you when an item is waiting on you. The concierge only answers
// messages you send. This module initiates one: when an item's cursor lands on
// a gate, one templated message goes to each configured approver.
//
// DERIVED STATE, NOT A TRANSITION HOOK. The cursor is written from 13 places
// across store.js and orchestrator.js and none of them is touched here. Instead
// work_item.notified_step records which gate an item was last notified about,
// and the sweep below reconciles it against the cursor. Three consequences fall
// straight out of that, which a hook at each call site would each have needed
// their own mechanism for:
//
//   * a restart while parked at a gate re-sends nothing — notified_step is
//     persisted, so the sweep sees agreement and does no work;
//   * a send-back notifies again on re-arrival — requestChanges() always lands
//     the cursor on an AGENT step (store.js), the sweep observes that non-gate
//     cursor and clears notified_step, so the return trip is a fresh arrival;
//   * a cursor write added later is covered with no edit here.
//
// GUARDRAIL 2 IS STRUCTURAL, NOT CAREFUL. No lifecycle path imports this
// module: server.js calls init() and that is the only production caller. The
// sweep runs from store.onChange, which fires AFTER the cursor write has
// committed, and its whole body is wrapped in try/catch — notify() is a plain
// synchronous forEach, so a throw in here would otherwise surface as a 500 on
// an approval that had already succeeded.
//
// GUARDRAIL 1: there is no model on this path. This module imports store, db,
// config, waApprovers and waSend — no orchestrator, no personas, no farm. The
// message is a template; rendering it cannot call an agent because there is
// nothing to call.

import { db } from './db.js'
import * as store from './store.js'
import { STEPS, gateStepIndexes, requiredStepIndex, isAbandoned, isClosed } from '../../domain/js/lifecycle.js'
import { approverJids } from './waApprovers.js'
import { sendWhatsApp } from './waSend.js'
import { UI_URL, WA_NOTIFY_ENABLED, WA_NOTIFY_SWEEP_MS, WA_NOTIFY_MAX_ATTEMPTS } from './config.js'

const GATE_INDEXES = gateStepIndexes()

// What the human is actually being asked, one line per gate. Keyed by
// requiredStepIndex so a label rename throws at import rather than silently
// dropping a gate to a vague fallback — there is deliberately NO generic
// default, because a fallback and the coverage test below would contradict each
// other and the fallback would win in production.
//
// These lines are presentation, so they stay here rather than in
// domain/steps.json: five strings of wording are not part of the step model,
// and putting them there would pull the schema, the validator and the Python
// binding along for the ride.
const GATE_ASKS = {
  [requiredStepIndex('Approve & prioritize this work')]: 'Approve this work and set its priority, or send it back.',
  [requiredStepIndex('Approve the high-level design')]: 'Approve the chosen approach, or send it back for another option.',
  [requiredStepIndex('Review before execution')]: 'Approve the implementation plan before any code is written, or send it back.',
  [requiredStepIndex('Accept the code')]: 'Accept the code as built, or send it back to Eng with changes.',
  [requiredStepIndex('Review the work & close')]: 'Review the shipped work and close the item, or send it back.',
}

// The gate whose notification carries a recommendation, and where that
// recommendation comes from. Only this one: the PM's summarize step feeds this
// gate and no other, so quoting it anywhere else would be attaching a
// recommendation to a decision it was not written about.
const RECOMMENDATION_GATE = requiredStepIndex('Review before execution')
const RECOMMENDATION_SOURCE = requiredStepIndex('Summarize reviews & recommend')

const RECOMMENDATION_MAX = 300
const BODY_MAX = 1200

export function isGateIndex(cursor) {
  return GATE_INDEXES.includes(cursor)
}

// The one quotable line of an artifact, capped. Returns '' when there is
// nothing to quote — the caller then omits the line entirely rather than
// shipping an empty or invented recommendation.
//
// Markdown HEADINGS ARE SKIPPED, not stripped, and that is the whole reason
// this is not a one-liner. Every real "Summarize reviews & recommend" artifact
// opens with `## Recommendation` followed by a blank line, so a plain
// first-non-empty-line rule quotes the word "Recommendation" — true, useless,
// and indistinguishable from working. The first non-heading line is the verdict.
// A heading-only artifact falls back to the heading text rather than omitting,
// so a differently-shaped artifact degrades instead of vanishing.
function quotableLine(text) {
  if (typeof text !== 'string') return ''
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  const line = lines.find((l) => !l.startsWith('#')) || lines[0]?.replace(/^#+\s*/, '').trim() || ''
  return line.length > RECOMMENDATION_MAX ? line.slice(0, RECOMMENDATION_MAX - 1) + '…' : line
}

// Pure: no I/O, no clock, no marker. The BOT_MARKER prefix belongs to
// waSend.js — prepending it here too would double it, and the bridge's inbound
// filter only strips one.
//
// The link matches app.js's own deep-link format (`${UI_URL}/${id.toLowerCase()}`)
// so there is no second link config to keep in step with it. It is rendered
// FIRST into the cap below so a long title or recommendation can never push the
// link — the only actionable part of the message — out of the body.
export function renderNotice(item, recommendation = null) {
  const gateIndex = item.cursor
  const ask = GATE_ASKS[gateIndex]
  if (!ask) throw new Error(`gateNotifier: step ${gateIndex} has no ask line — is it a gate?`)
  const link = `${UI_URL}/${String(item.id).toLowerCase()}`
  const quoted = quotableLine(recommendation)
  const lines = [
    `${item.id} — ${item.title}`,
    `Gate: ${STEPS[gateIndex].label}`,
    `Asking: ${ask}`,
    ...(quoted ? [`PM recommendation: ${quoted}`] : []),
  ]
  const body = lines.join('\n')
  const room = BODY_MAX - link.length - 1
  return `${body.length > room ? body.slice(0, room - 1) + '…' : body}\n${link}`
}

// Reconciles notified_step against the cursor for every item where the two
// disagree. That WHERE clause is the entire predicate — no scan of the board —
// which matters because this runs on EVERY store.onChange, i.e. per step_run
// update and per event, not on a timer.
//
// `IS NOT` rather than `!=`: notified_step is NULL for most rows and SQL `!=`
// against NULL is NULL, i.e. never true, so with `!=` an arrival would never be
// seen at all. The second clause narrows it further — a row with NULL
// notified_step and a non-gate cursor is the steady state for most of the board
// (including every closed item), already agrees with reality, and would
// otherwise be selected on every single mutation forever.
const selectStale = db.prepare(`
  SELECT * FROM work_item
   WHERE notified_step IS NOT cursor
     AND (notified_step IS NOT NULL OR cursor IN (${GATE_INDEXES.map(() => '?').join(',')}))
`)

export function sweepGates() {
  const candidates = selectStale.all(...GATE_INDEXES)
  const recipients = approverJids()
  const insert = db.prepare(
    'INSERT INTO gate_notice (item_id, step_index, recipient, body) VALUES (?, ?, ?, ?)',
  )
  const setNotified = db.prepare('UPDATE work_item SET notified_step = ? WHERE id = ?')
  let enqueued = 0
  let cleared = 0
  for (const item of candidates) {
    // Paused is NOT skipped: a paused item parked at a gate is still waiting on
    // a human, which is the whole thing this notifies about. Closed and
    // abandoned are, because neither is waiting on anyone.
    const atGate = !isClosed(item) && !isAbandoned(item) && isGateIndex(item.cursor)
    if (!atGate) {
      if (item.notified_step !== null) {
        setNotified.run(null, item.id)
        cleared++
      }
      continue
    }
    // Read through store.latestArtifact, not a second raw query onto step_run:
    // "latest done attempt wins" is already decided there, once.
    const recommendation =
      item.cursor === RECOMMENDATION_GATE ? store.latestArtifact(item.id, RECOMMENDATION_SOURCE) : null
    const body = renderNotice(item, recommendation)
    // notified_step is set in the SAME transaction as the rows, so a crash
    // between them cannot leave an arrival marked notified with nothing queued.
    // With no approvers configured the row set is empty and notified_step still
    // advances: HZ-140's deny-all means notify-nobody, not notify-later.
    db.transaction(() => {
      for (const recipient of recipients) insert.run(item.id, item.cursor, recipient, body)
      setNotified.run(item.cursor, item.id)
    })()
    enqueued += recipients.length
  }
  return { enqueued, cleared }
}

// Claims one row at a time with a CONDITIONAL update and requires it to have
// won: `WHERE status = 'pending'` plus changes === 1 is what makes two
// overlapping drains send once rather than twice. notify() fires from ~20 sites
// in orchestrator.js alone and the interval ticks alongside them, so overlap is
// the normal case, not an edge one.
const claim = () =>
  db
    .prepare(
      "SELECT id, recipient, body, attempts FROM gate_notice WHERE status = 'pending' AND next_attempt_at <= datetime('now') ORDER BY id LIMIT 1",
    )
    .get()

let draining = false

// Never throws. Returns counts so a caller (and the tests) can see what
// happened without reading the log.
export async function drainOutbox({ send = sendWhatsApp } = {}) {
  if (draining) return { sent: 0, failed: 0, skipped: true }
  draining = true
  let sent = 0
  let failed = 0
  try {
    for (;;) {
      const row = claim()
      if (!row) break
      const won = db
        .prepare("UPDATE gate_notice SET status = 'sending' WHERE id = ? AND status = 'pending'")
        .run(row.id)
      if (won.changes !== 1) continue // another drain got there first
      try {
        await send(row.recipient, row.body)
        db.prepare("UPDATE gate_notice SET status = 'sent', sent_at = datetime('now'), last_error = NULL WHERE id = ?").run(row.id)
        sent++
      } catch (err) {
        failed++
        const attempts = row.attempts + 1
        const give_up = attempts >= WA_NOTIFY_MAX_ATTEMPTS
        // 60s doubling, capped at an hour. Backoff is why a failed send is
        // retried rather than hammered: next_attempt_at in the future means the
        // very next drain skips this row instead of burning the whole attempt
        // budget inside one tick.
        const delay = Math.min(60 * 2 ** (attempts - 1), 3600)
        db.prepare(
          `UPDATE gate_notice SET status = ?, attempts = ?, last_error = ?, next_attempt_at = datetime('now', ?) WHERE id = ?`,
        ).run(give_up ? 'failed' : 'pending', attempts, String(err?.message || err).slice(0, 500), `+${delay} seconds`, row.id)
      }
    }
  } finally {
    draining = false
  }
  return { sent, failed }
}

// A row left 'sending' when the process died is genuinely ambiguous: the POST
// may have reached the bridge. DECISION: at-most-once for that one window. Two
// pings about the same arrival is worse for the human than one logged miss, and
// guardrail 3 forbids a second notification per arrival outright.
export function failInterruptedSends() {
  return db
    .prepare(
      "UPDATE gate_notice SET status = 'failed', last_error = 'interrupted — process exited mid-send, not resent' WHERE status = 'sending'",
    )
    .run().changes
}

// Exported for the tests; init() below is the only production caller.
export async function tick(log) {
  try {
    sweepGates()
  } catch (err) {
    // Reached from store.onChange, i.e. inside an approval request that has
    // already committed. Swallowing is the point: a broken notifier must not
    // turn a successful approval into a 500.
    log?.error?.(`gate notifier sweep failed: ${err.message}`)
  }
  try {
    const { sent, failed } = await drainOutbox()
    if (failed > 0) log?.warn?.(`gate notifier: ${sent} notification(s) sent, ${failed} failed and will be retried`)
  } catch (err) {
    log?.error?.(`gate notifier drain failed: ${err.message}`)
  }
}

export function init(log) {
  if (!WA_NOTIFY_ENABLED) {
    log?.info?.('Gate notifier disabled (WA_NOTIFY_ENABLED is not "1")')
    return
  }
  const recipients = approverJids()
  if (recipients.length === 0) {
    // Enabled but with nobody to tell. Said out loud rather than silently
    // enqueueing nothing forever, because the two look identical in the DB.
    log?.warn?.('Gate notifier enabled but WA_APPROVER_JIDS is empty — no gate notification can be delivered')
  }
  const interrupted = failInterruptedSends()
  if (interrupted > 0) log?.warn?.(`Gate notifier: ${interrupted} notification(s) were mid-send at shutdown — not resent`)
  store.onChange(() => {
    void tick(log)
  })
  // Backstop for the one thing onChange cannot catch: a send that failed and is
  // now waiting on its backoff, with no further board mutation to wake it.
  // .unref() so this never holds the process open, matching orchestrator.js.
  setInterval(() => void tick(log), WA_NOTIFY_SWEEP_MS).unref()
  void tick(log)
}
