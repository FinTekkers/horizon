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

// Same salted-scrypt scheme as server/src/settings.js#setHumanKey. Writing
// the hash directly (instead of through the Admin UI) keeps the plaintext
// out of the browser's localStorage, so the next gate action genuinely
// exercises the window.prompt() flow instead of silently reusing a cached key.
export function setGateKeyDirect(db, plaintext) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(plaintext, salt, 32)
  const value = `${salt.toString('hex')}:${hash.toString('hex')}`
  db.prepare(
    `INSERT INTO setting (key, value) VALUES ('human_key_hash', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(value)
}
