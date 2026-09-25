// Direct-sqlite fixture helpers. Rows written this way bypass store.js
// entirely, so the orchestrator never kicks them (registerAgentRunner only
// fires on mutations that go through store.js) — the row just sits at
// whatever cursor we give it until a test performs a real gate action.
// That's what makes these fixtures deterministic despite the mock agents
// otherwise racing through every runnable item as soon as the server boots.
//
// Column list mirrors the work_item table in server/src/db.js (base columns
// + the additive `pr`/`pr_url`/`pr_mergeable` migration) — keep in sync if
// that schema changes.

import crypto from 'node:crypto'
import Database from 'better-sqlite3'

export function openDb(path) {
  return new Database(path)
}

// `updatedAt` lets a fixture backdate last_activity_at (HZ-80) — the column
// otherwise defaults to datetime('now'), which is useless for exercising the
// 30-day staleness filter without a real 30-day wait.
export function insertItem(
  db,
  {
    id,
    title,
    priority = 'Medium',
    cursor = 0,
    desc = '',
    metric = '',
    guardrails = '',
    pr = null,
    pr_url = null,
    pr_mergeable = null,
    updatedAt = null,
    paused = 0,
  },
) {
  db.prepare(
    `INSERT INTO work_item (id, title, priority, desc, metric, guardrails, cursor, pr, pr_url, pr_mergeable, paused)
     VALUES (@id, @title, @priority, @desc, @metric, @guardrails, @cursor, @pr, @pr_url, @pr_mergeable, @paused)`,
  ).run({ id, title, priority, desc, metric, guardrails, cursor, pr, pr_url, pr_mergeable, paused: paused ? 1 : 0 })
  if (updatedAt) {
    db.prepare('UPDATE work_item SET updated_at = ? WHERE id = ?').run(updatedAt, id)
  }
}

// A Horizon activity-log row, written directly like insertItem above so it
// never goes through addEvent()/store.js. HZ-94's pause-reason.spec uses this
// to reproduce the exact pause-event text failFarmRun() writes (see
// server/src/orchestrator.js), without needing a real farm failure to occur.
export function insertEvent(db, { itemId, who = 'Horizon', text, color = '#9C333E', initials = 'HZ' }) {
  db.prepare(
    'INSERT INTO event (item_id, who, text, color, initials) VALUES (@itemId, @who, @text, @color, @initials)',
  ).run({ itemId, who, text, color, initials })
}

// A retained-but-superseded artifact version (HZ-46): a done step_run row
// with its own attempt number, started_at and ended_at so
// store.listStepAttempts() can order it against sibling attempts and
// time-correlate it with a feedback row. Written directly like insertItem
// above, so it never goes through store.js and never gets kicked.
export function insertStepRun(
  db,
  { itemId, stepIndex, attempt, agent, status = 'done', output = null, artifact = null, startedAt, endedAt = null },
) {
  // Returns lastInsertRowid: HZ-54's queued-work spec needs the run id to
  // attach farm state to a specific run. main's own callers ignore it.
  return db
    .prepare(
      `INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, started_at, ended_at)
       VALUES (@itemId, @stepIndex, @attempt, @agent, @status, @output, @artifact, @startedAt, @endedAt)`,
    )
    .run({ itemId, stepIndex, attempt, agent, status, output, artifact, startedAt, endedAt }).lastInsertRowid
}

// A feedback row with an explicit created_at, so it can be placed inside the
// time window store.js's selectDrivingFeedback uses to attribute it to one
// specific attempt (between the previous attempt's ended_at and this
// attempt's started_at).
export function insertFeedback(db, { itemId, target, message, createdAt }) {
  db.prepare(
    'INSERT INTO feedback (item_id, target, message, created_at) VALUES (@itemId, @target, @message, @createdAt)',
  ).run({ itemId, target, message, createdAt })
}

// A dependency edge (HZ-78/HZ-95): itemId depends on dependsOnId, i.e.
// dependsOnId blocks itemId. Written directly like insertItem above — bypasses
// store.js's cycle check entirely, so fixtures are responsible for only ever
// wiring acyclic edges.
export function insertDependency(db, { itemId, dependsOnId }) {
  db.prepare('INSERT INTO work_item_dependency (item_id, depends_on_id) VALUES (?, ?)').run(itemId, dependsOnId)
}

// Same salted-scrypt scheme as server/src/auth.js's per-account gate PIN.
// Writing the hash directly (instead of through Admin's "Regenerate my PIN")
// keeps the plaintext out of the browser's localStorage, so the next gate
// action genuinely exercises the window.prompt() flow instead of silently
// reusing a cached PIN. Targets the account global-setup.js already logged
// in as (its row is created on that first successful login), by email.
export function setGatePinDirect(db, email, plaintext) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(plaintext, salt, 32)
  const value = `${salt.toString('hex')}:${hash.toString('hex')}`
  const result = db.prepare('UPDATE user SET gate_pin_hash = ? WHERE email = ?').run(value, email)
  if (result.changes === 0) throw new Error(`setGatePinDirect: no user row for ${email} — did global setup log in first?`)
}
