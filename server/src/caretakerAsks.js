// Autopilot caretaker, asks (HZ-731).
//
// HZ-729 reviews each ask; HZ-730 lets the owner File it or Dismiss it. With
// Autopilot 'on', this pass acts on the reviewed ones like a gate:
//   - an ask the reviewer accepted is filed with its own draft, one it amended
//     with the amended draft — both through asks.fileAsk, the same call the
//     owner's File it makes (spawnItems and linkSpawned are handed in by
//     server.js, so nothing here imports github or spawn.js);
//   - an ask the reviewer escalated, or whose review failed or was cut short,
//     is never filed: the owner is pinged once instead;
//   - an item parked at a gate Autopilot would act on, with an open blocking
//     ask, pings the owner once per arrival and ask. caretaker.js does not
//     judge such an arrival and caretakerAccept.js waits on it, so nothing
//     approves past the ask.
// In 'shadow' each of these is one "caretaker would …" event and nothing
// else. An 'off' project is never selected, and an item with Autopilot off
// (its `autopilot-off` label) in an 'on' project is skipped outright: the
// owner decides, and its asks stay open.
//
// NEVER DISMISSES: only the owner may, so asks.dismissAsk is not imported.
// A split (kind 'split') is filed at its own gate and never selected here.
//
// One caretaker_ask_action row per (ask, action, mode, gate, arrival) — the
// UNIQUE key is the claim, so a restart or a second tick adds nothing. A
// filing that fails is recorded 'failed', pinged once and never retried; the
// owner can still press File it. Filings count against CARETAKER_HOURLY_LIMIT
// per project, in this table's own window.

import { db } from './db.js'
import * as store from './store.js'
import { STEPS, ACCEPT_GATE_INDEX, isClosed } from '../../domain/js/lifecycle.js'
import { ACTOR, redact } from './caretakerRules.js'
import { ACT_GATES, HOUR_MS } from './caretakerActor.js'
import { fileAsk, openBlockingAsks, stepLabel } from './asks.js'
import { ownerJid } from './waApprovers.js'
import { CARETAKER_HOURLY_LIMIT } from './config.js'

const RESWEEP_MS = 60 * 1000
// The gates Autopilot would otherwise act on; every other gate is a human's.
export const HOLD_GATES = [...ACT_GATES, ACCEPT_GATE_INDEX]

// Open blocking and soft asks with a review that has come back, in an enabled
// shadow or 'on' project, not yet acted on in this mode. A 'done' review with
// accept or amend is filed; 'escalate', or a review that failed or was cut
// short (both carry 'escalate'), goes to the owner.
const selectAskCandidates = db.prepare(`
  SELECT a.id AS ask_id, a.item_id, a.kind, a.step_index, a.draft_json, r.status AS review_status, r.verdict,
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
const selectAskStatus = db.prepare('SELECT status FROM ask WHERE id = ?')
const insertAction = db.prepare(`
  INSERT OR IGNORE INTO caretaker_ask_action (ask_id, item_id, project_id, action, mode, gate_index, arrival_run_id, outcome, error, acted_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const finishAction = db.prepare('UPDATE caretaker_ask_action SET outcome = ?, error = ? WHERE id = ?')
const countFilings = db.prepare(
  "SELECT COUNT(*) AS n FROM caretaker_ask_action WHERE project_id = ? AND action = 'file' AND mode = 'on' AND outcome <> 'skipped' AND acted_at_ms > ?",
)
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

const WHY_ESCALATED = {
  escalate: 'the reviewer escalated it',
  failed: 'its review failed',
  interrupted: 'its review was cut short',
}

// One escalation: in 'on', one owner ping and one event; in shadow, the event.
function escalate(row, nowMs, owner) {
  const why = WHY_ESCALATED[row.review_status === 'done' ? 'escalate' : row.review_status]
  return db.transaction(() => {
    if (row.autopilot === 'on' && !stillOn(row)) return false
    const mode = row.autopilot
    if (insertAction.run(row.ask_id, row.item_id, row.project_id, 'escalate', mode, -1, 0, mode === 'on' ? 'ok' : 'skipped', null, nowMs).changes !== 1) return false
    if (mode === 'on') {
      const body = line(
        `Autopilot needs you: ${row.item_id} "${row.item_title}" has an ask from "${stepLabel(row.step_index)}" that Autopilot will not file — ${why}: “${titleOf(row)}”. File it or dismiss it.`,
      )
      insertPing.run(row.project_id, row.item_id, 'ask_escalated', `ask_escalated:${row.ask_id}`, owner || '', body, nowMs)
      insertEvent.run(row.item_id, `caretaker did not file the ask ${quote(titleOf(row))} (${why}) — pinged the owner`)
    } else {
      insertEvent.run(row.item_id, `caretaker would ping the owner about the ask ${quote(titleOf(row))} (${why})`)
    }
    return true
  })()
}

// One filing. Shadow records the event only. In 'on' the claim is written
// before fileAsk starts, so a second tick or a restart never files twice.
async function file(row, nowMs, { owner, limit, spawnItems, linkSpawned, log }) {
  const amended = row.verdict === 'amend' ? ' with the reviewer’s amended draft' : ''
  if (row.autopilot !== 'on') {
    if (insertAction.run(row.ask_id, row.item_id, row.project_id, 'file', 'shadow', -1, 0, 'skipped', null, nowMs).changes !== 1) return false
    insertEvent.run(row.item_id, `caretaker would file the ask ${quote(titleOf(row))}${amended}`)
    return true
  }
  if (countFilings.get(row.project_id, nowMs - HOUR_MS).n >= limit) {
    log?.warn?.(`caretaker: hourly limit (${limit}) of ask filings hit on project ${row.project_id}`)
    return false
  }
  const claim = db.transaction(() => {
    if (!stillOn(row) || selectAskStatus.get(row.ask_id)?.status !== 'open') return null
    const inserted = insertAction.run(row.ask_id, row.item_id, row.project_id, 'file', 'on', -1, 0, 'pending', null, nowMs)
    return inserted.changes === 1 ? inserted.lastInsertRowid : null
  })()
  if (claim === null) return false
  let result
  try {
    const item = store.getItem(row.item_id)
    const repos = store
      .listRepos()
      .filter((r) => r.project_id === row.project_id)
      .map((r) => r.repo)
    result = item ? await fileAsk(item, row.ask_id, { repos, actor: ACTOR, spawnItems, linkSpawned }) : { error: 'not_found' }
  } catch (err) {
    result = { error: err?.message || String(err) }
  }
  if (result?.ok) {
    finishAction.run('ok', null, claim)
    insertEvent.run(row.item_id, `Autopilot filed the ask ${quote(titleOf(row))}${amended} as ${result.itemId}`)
    log?.info?.(`caretaker: filed ask ${row.ask_id} on ${row.item_id} as ${result.itemId}`)
    return true
  }
  const error = redact(result?.message || result?.error || 'no result')
  db.transaction(() => {
    finishAction.run('failed', error, claim)
    insertEvent.run(row.item_id, `caretaker could not file the ask ${quote(titleOf(row))} (${error}) — pinged the owner`)
    const body = line(
      `Autopilot could not file an ask on ${row.item_id} "${row.item_title}": “${titleOf(row)}” — ${error}. File it or dismiss it yourself.`,
    )
    insertPing.run(row.project_id, row.item_id, 'ask_escalated', `ask_file_failed:${row.ask_id}`, owner || '', body, nowMs)
  })()
  log?.warn?.(`caretaker: could not file ask ${row.ask_id} on ${row.item_id}: ${error}`)
  return true
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
// throws. `spawnItems` and `linkSpawned` are spawn.js's, handed in.
export async function sweepAsks({ log, now = Date.now, owner = ownerJid, limit = CARETAKER_HOURLY_LIMIT, spawnItems, linkSpawned } = {}) {
  const counts = { filed: 0, escalated: 0, held: 0 }
  if (sweeping) return { ...counts, skipped: true }
  sweeping = true
  let changed = false
  try {
    for (const row of selectAskCandidates.all()) {
      try {
        if (itemOff(row) || isClosed({ cursor: row.cursor, kind: row.item_kind })) continue
        const fileable = row.review_status === 'done' && (row.verdict === 'accept' || row.verdict === 'amend')
        if (fileable) {
          if (await file(row, now(), { owner: owner(), limit, spawnItems, linkSpawned, log })) {
            counts.filed++
            changed = true
          }
        } else if (escalate(row, now(), owner())) {
          counts.escalated++
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
// for the tests; `opts` (now, owner, limit) are for the tests too.
export function init(log, { spawnItems, linkSpawned, ...opts } = {}) {
  if (!spawnItems || !linkSpawned) throw new Error('caretakerAsks.init needs spawnItems and linkSpawned')
  const run = () => sweepAsks({ log, spawnItems, linkSpawned, ...opts })
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
