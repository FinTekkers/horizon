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

export function insertItem(
  db,
  { id, title, priority = 'Medium', cursor = 0, desc = '', metric = '', guardrails = '', pr = null, pr_url = null, pr_mergeable = null },
) {
  db.prepare(
    `INSERT INTO work_item (id, title, priority, desc, metric, guardrails, cursor, pr, pr_url, pr_mergeable)
     VALUES (@id, @title, @priority, @desc, @metric, @guardrails, @cursor, @pr, @pr_url, @pr_mergeable)`,
  ).run({ id, title, priority, desc, metric, guardrails, cursor, pr, pr_url, pr_mergeable })
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
  db.prepare(
    `INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, started_at, ended_at)
     VALUES (@itemId, @stepIndex, @attempt, @agent, @status, @output, @artifact, @startedAt, @endedAt)`,
  ).run({ itemId, stepIndex, attempt, agent, status, output, artifact, startedAt, endedAt })
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
