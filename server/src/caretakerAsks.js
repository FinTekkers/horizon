// Autopilot caretaker, asks (HZ-731, HZ-793).
//
// HZ-729 reviews each ask; HZ-730 lets the owner File it or Dismiss it. The
// owner's ruling (HZ-793): every ask waits for the owner. With Autopilot
// 'on', this pass never files an ask, whatever the reviewer's verdict:
//   - an ask the reviewer accepted, amended or escalated, or whose review
//     failed or was cut short, pings the owner once with the verdict (and any
//     contradiction with the parent item the reviewer found) and stays open.
//     Every one uses the 'ask_escalated' ping reason and dedupe key, so an
//     ask escalated before HZ-793 is never pinged twice;
//   - an item parked at a gate Autopilot would act on, with an open blocking
//     ask, pings the owner once per arrival and ask. caretaker.js does not
//     judge such an arrival and caretakerAccept.js waits on it, so nothing
//     approves past the ask until the owner files or dismisses it.
// In 'shadow' each of these is one "caretaker would …" event and nothing
// else. An 'off' project is never selected, and an item with Autopilot off
// (its `autopilot-off` label) in an 'on' project is skipped outright: the
// owner decides, and its asks stay open.
//
// NEVER FILES OR DISMISSES: only the owner may, so neither of asks.js's
// filing and dismissing calls is imported. A split (kind 'split') is filed
// at its own gate and never selected here.
//
// One caretaker_ask_action row per (ask, action, mode, gate, arrival) — the
// UNIQUE key is the claim, so a restart or a second tick adds nothing. A
// ping is claimed as action 'escalate'. A 'file' row is from before HZ-793:
// that ask was filed, or its failure pinged, so it is never selected again.

import { db } from './db.js'
import * as store from './store.js'
import { STEPS, ACCEPT_GATE_INDEX, isClosed } from '../../domain/js/lifecycle.js'
import { redact } from './caretakerRules.js'
import { ACT_GATES } from './caretakerActor.js'
import { openBlockingAsks, stepLabel } from './asks.js'
import { ownerJid } from './waApprovers.js'

const RESWEEP_MS = 60 * 1000
// The gates Autopilot would otherwise act on; every other gate is a human's.
export const HOLD_GATES = [...ACT_GATES, ACCEPT_GATE_INDEX]

// Open blocking and soft asks with a review that has come back, in an enabled
// shadow or 'on' project, not yet acted on in this mode. Each goes to the
// owner, whatever the verdict.
const selectAskCandidates = db.prepare(`
  SELECT a.id AS ask_id, a.item_id, a.kind, a.step_index, a.draft_json, r.status AS review_status, r.verdict,
         r.contradiction_json,
         w.title AS item_title, w.cursor, w.kind AS item_kind, w.project_id, w.autopilot_off, p.autopilot
    FROM ask a
    JOIN ask_review r ON r.ask_id = a.id
    JOIN work_item w ON w.id = a.item_id
    JOIN project p ON p.id = w.project_id
   WHERE a.status = 'open' AND a.kind IN ('blocking','soft')
     AND p.autopilot IN ('shadow','on') AND p.enabled = 1 AND w.abandoned_at IS NULL
     AND ((r.status = 'done' AND r.verdict IN ('accept','amend','escalate')) OR r.status IN ('failed','interrupted'))
     AND NOT EXISTS (SELECT 1 FROM caretaker_ask_action x
                      WHERE x.ask_id = a.id AND x.action IN ('file','escalate') AND x.mode = p.autopilot)
   ORDER BY a.id`)
// Items parked at a hold gate with an open blocking ask, with the arrival
// key caretaker.js and caretakerActor.js use.
const selectHeldItems = db.prepare(`
  SELECT w.id AS item_id, w.title, w.cursor, w.project_id, w.autopilot_off, p.autopilot,
         COALESCE((SELECT MAX(s.id) FROM step_run s WHERE s.item_id = w.id
               AND s.step_index = w.cursor - 1 AND s.substep_id IS NULL AND s.status = 'done'), 0) AS arrival_run_id
    FROM work_item w JOIN project p ON p.id = w.project_id
   WHERE p.autopilot IN ('shadow','on') AND p.enabled = 1 AND w.abandoned_at IS NULL
     AND w.cursor IN (${HOLD_GATES.join(',')})
     AND EXISTS (SELECT 1 FROM ask a WHERE a.item_id = w.id AND a.kind = 'blocking' AND a.status = 'open')
   ORDER BY w.id`)
const selectMode = db.prepare('SELECT autopilot FROM project WHERE id = ?')
const selectItemOff = db.prepare('SELECT autopilot_off FROM work_item WHERE id = ?')
const insertAction = db.prepare(`
  INSERT OR IGNORE INTO caretaker_ask_action (ask_id, item_id, project_id, action, mode, gate_index, arrival_run_id, outcome, error, acted_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const insertEvent = db.prepare("INSERT INTO event (item_id, who, text, color, initials) VALUES (?, 'Caretaker', ?, '#4A6B5D', 'CT')")
const insertPing = db.prepare(`
  INSERT OR IGNORE INTO caretaker_ping (project_id, item_id, reason, dedupe_key, recipient, body, created_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?)`)

const titleOf = (row) => {
  try {
    const title = JSON.parse(row.draft_json)?.title
    return typeof title === 'string' ? title : ''
  } catch {
    return ''
  }
}
// Secrets out and one line, uncapped: redact()'s default cap could cut the
// ask's title out of a ping.
const line = (text) => redact(text, { oneLine: false }).replace(/\s+/g, ' ').trim()
const quote = (text) => `“${line(text)}”`
// An item in an 'on' project with its `autopilot-off` label: the owner's.
const itemOff = (row) => row.autopilot === 'on' && row.autopilot_off === 1
// The mode and label re-read at claim time, as caretakerActor.js does.
const stillOn = (row) => selectMode.get(row.project_id)?.autopilot === 'on' && selectItemOff.get(row.item_id)?.autopilot_off !== 1

const VERDICT_TEXT = {
  accept: 'the reviewer accepted it',
  amend: 'the reviewer amended it',
  escalate: 'the reviewer escalated it',
  failed: 'its review failed',
  interrupted: 'its review was cut short',
}
// A 'done' review by its verdict; a failed or interrupted one (both carry
// 'escalate') by its status.
const verdictText = (row) => VERDICT_TEXT[row.review_status === 'done' ? row.verdict : row.review_status]

// The reviewer's finding that the ask contradicts the parent item, or ''.
function contradictionOf(row) {
  try {
    const c = JSON.parse(row.contradiction_json || 'null')
    return c?.contradicts === true && typeof c.detail === 'string' ? line(c.detail).replace(/[.\s]+$/, '') : ''
  } catch {
    return ''
  }
}

// One ask to the owner: in 'on', one ping and one event; in shadow, the
// event. The ask stays open either way.
function notifyOwner(row, nowMs, owner) {
  const verdict = verdictText(row)
  return db.transaction(() => {
    if (row.autopilot === 'on' && !stillOn(row)) return false
    const mode = row.autopilot
    if (insertAction.run(row.ask_id, row.item_id, row.project_id, 'escalate', mode, -1, 0, mode === 'on' ? 'ok' : 'skipped', null, nowMs).changes !== 1) return false
    if (mode === 'on') {
      const contradiction = contradictionOf(row)
      const contradicts = contradiction ? ` It may contradict ${row.item_id}'s description: ${contradiction}.` : ''
      const body = line(
        `Autopilot needs you: ${row.item_id} "${row.item_title}" has an ask from "${stepLabel(row.step_index)}": “${titleOf(row)}”. ${verdict[0].toUpperCase()}${verdict.slice(1)}.${contradicts} File it or dismiss it.`,
      )
      insertPing.run(row.project_id, row.item_id, 'ask_escalated', `ask_escalated:${row.ask_id}`, owner || '', body, nowMs)
      insertEvent.run(row.item_id, `caretaker pinged the owner about the ask ${quote(titleOf(row))} (${verdict})`)
    } else {
      insertEvent.run(row.item_id, `caretaker would ping the owner about the ask ${quote(titleOf(row))} (${verdict})`)
    }
    return true
  })()
}

// One hold per (open blocking ask, gate, arrival): in 'on', one owner ping
// and one event; in shadow, the event.
function holdGate(row, ask, nowMs, owner) {
  const gate = STEPS[row.cursor].label
  return db.transaction(() => {
    const mode = row.autopilot
    if (insertAction.run(ask.id, row.item_id, row.project_id, 'gate_hold', mode, row.cursor, row.arrival_run_id, mode === 'on' ? 'ok' : 'skipped', null, nowMs).changes !== 1) {
      return false
    }
    if (mode === 'on') {
      const body = line(
        `Autopilot needs you: ${row.item_id} "${row.title}" is waiting at "${gate}" — the blocking ask “${ask.title}” is open. File it or dismiss it.`,
      )
      insertPing.run(row.project_id, row.item_id, 'blocking_ask', `ask_hold:${ask.id}:${row.cursor}:${row.arrival_run_id}`, owner || '', body, nowMs)
      insertEvent.run(row.item_id, `Autopilot did not approve “${gate}”: the blocking ask ${quote(ask.title)} is open — pinged the owner`)
    } else {
      insertEvent.run(row.item_id, `caretaker would hold “${gate}” for the blocking ask ${quote(ask.title)} and ping the owner`)
    }
    return true
  })()
}

let sweeping = false

// Exported for the tests; init() below is the only production caller. Never
// throws.
export async function sweepAsks({ log, now = Date.now, owner = ownerJid } = {}) {
  const counts = { notified: 0, held: 0 }
  if (sweeping) return { ...counts, skipped: true }
  sweeping = true
  let changed = false
  try {
    for (const row of selectAskCandidates.all()) {
      try {
        if (itemOff(row) || isClosed({ cursor: row.cursor, kind: row.item_kind })) continue
        if (notifyOwner(row, now(), owner())) {
          counts.notified++
          changed = true
        }
      } catch (err) {
        log?.error?.(`caretaker: ask ${row.ask_id} on ${row.item_id} could not be acted on: ${redact(err?.message)}`)
      }
    }
    for (const row of selectHeldItems.all()) {
      try {
        if (itemOff(row)) continue
        for (const ask of openBlockingAsks(row.item_id)) {
          if (holdGate(row, ask, now(), owner())) {
            counts.held++
            changed = true
          }
        }
      } catch (err) {
        log?.error?.(`caretaker: ${row.item_id} ask hold could not be recorded: ${redact(err?.message)}`)
      }
    }
  } catch (err) {
    log?.error?.(`caretaker ask pass failed: ${redact(err?.message)}`)
  } finally {
    sweeping = false
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

// Registered beside caretakerActor.init in server.js; its pings are sent by
// caretakerActor's drain on the change signal this pass raises. Change
// signals are coalesced onto the next turn of the event loop. Returns stop()
// for the tests; `opts` (now, owner) are for the tests too.
export function init(log, { spawnItems, linkSpawned, ...opts } = {}) {
  // Unused since HZ-793 (nothing here files); kept so server.js is unchanged.
  if (!spawnItems || !linkSpawned) throw new Error('caretakerAsks.init needs spawnItems and linkSpawned')
  const run = () => sweepAsks({ log, ...opts })
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
