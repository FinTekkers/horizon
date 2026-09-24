import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reconcileGoogleUsers } from './loginAllowlist.js'

const DB_PATH =
  process.env.HORIZON_DB || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'horizon.db')
mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS work_item (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    priority   TEXT NOT NULL CHECK (priority IN ('Critical','High','Medium','Low')),
    desc       TEXT NOT NULL DEFAULT '',
    metric     TEXT NOT NULL DEFAULT '',
    guardrails TEXT NOT NULL DEFAULT '',
    issue      INTEGER,
    cursor     INTEGER NOT NULL DEFAULT 0,
    paused     INTEGER NOT NULL DEFAULT 0,
    rejected   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Append-only activity log; the UI's Activity feed reads this.
  CREATE TABLE IF NOT EXISTS event (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    TEXT NOT NULL REFERENCES work_item(id),
    who        TEXT NOT NULL,
    text       TEXT NOT NULL,
    color      TEXT NOT NULL,
    initials   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Audit trail for human gates (the product's core promise).
  CREATE TABLE IF NOT EXISTS gate_decision (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    TEXT NOT NULL REFERENCES work_item(id),
    step_index INTEGER NOT NULL,
    decision   TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
    notes      TEXT NOT NULL DEFAULT '',
    decided_by TEXT NOT NULL DEFAULT 'You',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Feedback needs delivery state: delivered_at stays NULL until the
  -- orchestrator injects it into the owning agent's session.
  CREATE TABLE IF NOT EXISTS feedback (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id      TEXT NOT NULL REFERENCES work_item(id),
    target       TEXT NOT NULL DEFAULT '',
    message      TEXT NOT NULL DEFAULT '',
    source       TEXT NOT NULL DEFAULT 'ui',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT
  );

  -- Execution history: one row per attempt at an agent step. Restarts and
  -- rejections close open runs and later attempts get attempt+1.
  CREATE TABLE IF NOT EXISTS step_run (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    TEXT NOT NULL REFERENCES work_item(id),
    step_index INTEGER NOT NULL,
    attempt    INTEGER NOT NULL DEFAULT 1,
    agent      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','done','cancelled','rejected','superseded')),
    output     TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_step_run_item ON step_run(item_id, id DESC);

  -- Work-item dependencies (HZ-78): item_id is blocked until depends_on_id
  -- closes (see lifecycle.js isBlocked). Many-to-many so an item can have
  -- more than one blocker. A brand-new table, not a column on work_item, so
  -- this is purely additive — no CHECK constraint on work_item/step_run is
  -- touched and older databases keep opening unchanged.
  CREATE TABLE IF NOT EXISTS work_item_dependency (
    item_id       TEXT NOT NULL REFERENCES work_item(id),
    depends_on_id TEXT NOT NULL REFERENCES work_item(id),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    created_by    TEXT NOT NULL DEFAULT 'You',
    PRIMARY KEY (item_id, depends_on_id),
    CHECK (item_id <> depends_on_id)
  );
  CREATE INDEX IF NOT EXISTS idx_work_item_dependency_depends_on ON work_item_dependency(depends_on_id);

  -- Runtime settings (github repo/token set from the UI; env vars as fallback).
  CREATE TABLE IF NOT EXISTS setting (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- A project is what the board tracks; it spans one or more GitHub repos.
  CREATE TABLE IF NOT EXISTS project (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  -- Each connected repo belongs to a project and owns an item-id prefix
  -- (e.g. FinTekkers/shoreward -> SH -> SH-12).
  CREATE TABLE IF NOT EXISTS project_repo (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES project(id),
    repo       TEXT NOT NULL UNIQUE,
    prefix     TEXT NOT NULL UNIQUE
  );

  -- GitHub sync bookkeeping (ETag for conditional polling).
  CREATE TABLE IF NOT EXISTS sync_cursor (
    key            TEXT PRIMARY KEY,
    etag           TEXT,
    last_synced_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_event_item ON event(item_id, id DESC);

  -- Accounts (HZ-21): password or Google SSO, first login creates the row.
  -- gate_pin_hash is a SEPARATE cryptographic blocker from login — it exists
  -- so an AI agent (which can read this DB) still can't self-approve a gate;
  -- it is generated per-account, never chosen, and unrelated to auth_method.
  CREATE TABLE IF NOT EXISTS user (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    initials      TEXT NOT NULL,
    auth_method   TEXT NOT NULL CHECK (auth_method IN ('password','google')),
    google_sub    TEXT,
    gate_pin_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_google_sub ON user(google_sub) WHERE google_sub IS NOT NULL;

  -- Login sessions: id is sha256(raw token) hex — the raw token only ever
  -- lives in the httpOnly cookie, never at rest.
  CREATE TABLE IF NOT EXISTS session (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES user(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
`)

// Additive migrations for databases created before these columns existed.
// persona: specialist persona id (see personas.js); NULL = fullstack default.
for (const column of ['pr INTEGER', 'pr_url TEXT', 'pr_mergeable INTEGER', 'release_tag TEXT', 'release_url TEXT', 'repo TEXT', 'project_id INTEGER', 'persona TEXT', 'review_cycle_count INTEGER NOT NULL DEFAULT 0', 'abandoned_at TEXT', 'abandoned_reason TEXT', 'abandoned_by TEXT']) {
  try {
    db.exec(`ALTER TABLE work_item ADD COLUMN ${column}`)
  } catch {
    // column already exists
  }
}
try {
  db.exec('ALTER TABLE step_run ADD COLUMN artifact TEXT') // full agent artifact (markdown), separate from the summary
} catch {
  // column already exists
}
try {
  // HZ-57: distinct from started_at (row-insert/dispatch time, set NOT NULL
  // by the CREATE TABLE default). NULL until the farm confirms an agent
  // actually launched — that's when the execution timeout clock starts,
  // separate from the queue-wait watchdog armed at dispatch.
  db.exec('ALTER TABLE step_run ADD COLUMN agent_started_at TEXT')
} catch {
  // column already exists
}
try {
  // GitHub-sourced feedback keeps the comment id so the same comment arriving
  // twice (webhook + poll, or an edit re-surfacing it) is ingested once.
  db.exec('ALTER TABLE feedback ADD COLUMN gh_comment_id INTEGER')
} catch {
  // column already exists
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_gh_comment
    ON feedback(gh_comment_id) WHERE gh_comment_id IS NOT NULL;
`)

// Issue numbers are only unique per repo: two connected repos both have an
// issue #25. The pre-projects index was on issue alone, so replace it. Runs
// after the additive migrations above because `repo` is one of them.
db.exec(`
  DROP INDEX IF EXISTS idx_work_item_issue;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_repo_issue ON work_item(repo, issue);
`)

// Migrate a pre-projects single-repo setup: the old github_repo setting
// becomes the first project (keeping the legacy HZ item-id prefix).
const projectCount = db.prepare('SELECT COUNT(*) AS n FROM project').get().n
const legacyRepo =
  db.prepare("SELECT value FROM setting WHERE key = 'github_repo'").get()?.value || process.env.HORIZON_REPO
if (projectCount === 0 && legacyRepo) {
  const name = legacyRepo.split('/')[1] || legacyRepo
  const projectId = db.prepare('INSERT INTO project (name) VALUES (?)').run(name).lastInsertRowid
  db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(projectId, legacyRepo, 'HZ')
  db.prepare('UPDATE work_item SET repo = ?, project_id = ? WHERE issue IS NOT NULL AND repo IS NULL').run(
    legacyRepo,
    projectId,
  )
}

const SEED_ITEMS = [
  { id: 'BF-145', title: 'Risk-limit breach dashboard', priority: 'Low', cursor: 1, issue: 412, desc: 'Give risk managers a live view of limit utilization across every desk.', metric: 'Limit breaches acknowledged in < 2 min (from 14 min).', guardrails: 'Read-only — no position mutation. No PII in telemetry.' },
  { id: 'BF-128', title: 'Real-time P&L attribution service', priority: 'High', cursor: 3, issue: 398, desc: 'Attribute intraday P&L to factors, trades and fees in real time.', metric: 'Attribution available < 5s after fill; 99.9% coverage.', guardrails: 'No client identifiers in logs. Must reconcile to EOD books.' },
  { id: 'BF-131', title: 'Margin-call alerting v2', priority: 'High', cursor: 5, issue: 401, desc: 'Replace batch margin alerts with streaming, tiered escalation.', metric: 'False-positive rate < 3%; median alert latency < 10s.', guardrails: 'Cannot auto-liquidate. Human in the loop for every call.' },
  { id: 'BF-119', title: 'Order-router latency fix', priority: 'Critical', cursor: 7, issue: 377, desc: 'Cut tail latency in the smart order router under burst load.', metric: 'p99 routing latency < 800µs at 5× peak volume.', guardrails: 'No change to fill-priority logic. Zero-downtime rollout.' },
  { id: 'BF-140', title: 'Backtesting data-lake migration', priority: 'Medium', cursor: 10, issue: 405, desc: 'Move backtest datasets onto the new lakehouse with full lineage.', metric: 'Backtest run cost −40%; lineage on every dataset.', guardrails: 'Dual-write during cutover. No silent schema drift.' },
  { id: 'BF-102', title: 'FIX gateway refactor', priority: 'High', cursor: 12, issue: 366, desc: 'Modularize the FIX gateway and isolate venue adapters.', metric: 'New-venue onboarding < 2 days (from 3 weeks).', guardrails: 'Wire-compatible. Conformance suite stays green.' },
  { id: 'BF-097', title: 'Compliance audit export', priority: 'Medium', cursor: 13, issue: 352, desc: 'One-click immutable export of the full audit trail for regulators.', metric: 'Export any quarter in < 60s; tamper-evident hashes.', guardrails: 'Immutable store only. Every access is logged.' },
  { id: 'BF-090', title: 'Trader-console dark mode', priority: 'Low', cursor: 15, issue: 331, desc: 'Ship an accessible dark theme for the trader console.', metric: 'WCAG AA on all surfaces; opt-in persistence.', guardrails: 'No layout regressions in light mode.' },
]

// One-time migration for the pipeline-v2 insertion of the PM "Summarize
// reviews & recommend" step at index 9: everything at/after the old index 9
// shifts by one.
const shifted = db.prepare("SELECT value FROM setting WHERE key = 'pipeline_v2_shift'").get()
if (!shifted) {
  db.transaction(() => {
    db.prepare('UPDATE work_item SET cursor = cursor + 1 WHERE cursor >= 9').run()
    db.prepare('UPDATE step_run SET step_index = step_index + 1 WHERE step_index >= 9').run()
    db.prepare('UPDATE gate_decision SET step_index = step_index + 1 WHERE step_index >= 9').run()
    db.prepare("INSERT INTO setting (key, value) VALUES ('pipeline_v2_shift', 'done')").run()
  })()
}

// One-time migration for the pipeline-v3 insertion of the automated "Review"
// step at index 12 (HZ-30): everything at/after the old index 12 shifts by
// one. Same shape as pipeline_v2_shift above, including the atomicity trick:
// the 'setting' INSERT is the LAST statement in the transaction, so a second
// boot racing this block fails on the primary-key collision and the whole
// transaction (including the UPDATEs) rolls back — that's what actually
// prevents a double-shift if two server instances start at once.
const shiftedReview = db.prepare("SELECT value FROM setting WHERE key = 'pipeline_v3_review_shift'").get()
if (!shiftedReview) {
  db.transaction(() => {
    db.prepare('UPDATE work_item SET cursor = cursor + 1 WHERE cursor >= 12').run()
    db.prepare('UPDATE step_run SET step_index = step_index + 1 WHERE step_index >= 12').run()
    db.prepare('UPDATE gate_decision SET step_index = step_index + 1 WHERE step_index >= 12').run()
    db.prepare("INSERT INTO setting (key, value) VALUES ('pipeline_v3_review_shift', 'done')").run()
  })()
}

// Enforce the login allowlist immediately, every boot (HZ-36) — unlike the
// one-time-gated shifts above, this must re-run every time the process
// starts: ops can edit ALLOWED_LOGIN_EMAILS while the server is down and
// expect it applied the instant it comes back up, not just on the next
// Google login attempt.
reconcileGoogleUsers(db)

// Demo seed data — only when GitHub sync is not configured.
const count = db.prepare('SELECT COUNT(*) AS n FROM work_item').get().n
const syncConfigured = db.prepare('SELECT COUNT(*) AS n FROM project_repo').get().n > 0
if (count === 0 && !syncConfigured) {
  const insert = db.prepare(`
    INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, cursor)
    VALUES (@id, @title, @priority, @desc, @metric, @guardrails, @issue, @cursor)
  `)
  const seedAll = db.transaction((items) => items.forEach((it) => insert.run(it)))
  seedAll(SEED_ITEMS)
}
