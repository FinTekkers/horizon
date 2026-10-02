import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reconcileGoogleUsers } from './loginAllowlist.js'
import { gateStepIndexes } from '../../domain/js/lifecycle.js'
import { PRIORITIES } from '../../domain/js/priorities.js'

const DB_PATH =
  process.env.HORIZON_DB || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'horizon.db')
mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// The work_item priority constraint, built from the one declaration rather than
// hand-typed (HZ-135). The emitted clause is byte-identical to the literal it
// replaced — server/test/domain-priority-pins.test.mjs asserts that, because
// this string is the one thing in the change that a reader cannot diff by eye.
// Module-local: that pin reads the constraint back out of the live database's
// sqlite_master rather than importing this binding, so nothing here is exported
// for a test's benefit and the pin covers what SQLite actually stored.
//
// It sits inside CREATE TABLE IF NOT EXISTS below, so on an existing database
// the statement is a no-op and the stored constraint is untouched: no migration,
// no backfill, and every stored value still passes because the vocabulary did not
// move. Interpolating into SQL is safe here because the values are repo-owned AND
// because domain/js/priorities.js rejects anything outside /^[A-Z][A-Za-z]*$/ at
// load time — that rule is what makes this provably safe rather than
// safe-by-convention.
const PRIORITY_CHECK = `CHECK (priority IN (${PRIORITIES.map((value) => `'${value}'`).join(',')}))`

db.exec(`
  CREATE TABLE IF NOT EXISTS work_item (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    priority   TEXT NOT NULL ${PRIORITY_CHECK},
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
  -- closes (see domain/js/lifecycle.js isBlocked). Many-to-many so an item can have
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

  -- Personal API tokens (HZ-179). token_hash is sha256(raw) hex, as for
  -- session.id. The raw token is returned once by POST /api/tokens and never
  -- stored; last4 is all that is kept of it, for the Admin list.
  CREATE TABLE IF NOT EXISTS api_token (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES user(id),
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    last4        TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_api_token_user ON api_token(user_id);

  -- Gate-arrival notification outbox (HZ-141). One row per (arrival at a gate,
  -- approver). The body is rendered at ENQUEUE time and stored, so a retry hours
  -- later sends the state the item was in when it reached the gate rather than
  -- whatever has drifted since.
  --
  -- ON DELETE CASCADE, unlike every other child table here: purgeDemoItems()
  -- in store.js deletes work_item rows directly with foreign_keys = ON, and it
  -- hand-enumerates the children to clear first. A table missing from that list
  -- turns demo-item cleanup into an FK constraint error, so this one does not
  -- rely on being remembered there.
  CREATE TABLE IF NOT EXISTS gate_notice (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id         TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
    step_index      INTEGER NOT NULL,
    recipient       TEXT NOT NULL,
    body            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sending','sent','failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gate_notice_due ON gate_notice(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_gate_notice_item ON gate_notice(item_id, id DESC);

  -- Gate-approval poll outbox (HZ-142). One row per (arrival at a gate,
  -- approver) — the same grain as gate_notice, and sent alongside it.
  --
  -- ITS OWN OUTBOX, not a second kind of gate_notice row. Two reasons, and the
  -- second is the load-bearing one:
  --
  --   * a poll that the bridge refuses must not take the text notice down with
  --     it. Separate rows means separate attempts counters, so the human still
  --     gets the message and the deep link, and the concierge's free-text
  --     approval still works;
  --   * "one gate_notice row per arrival per approver" is asserted literally in
  --     four existing test files. Adding a second row per arrival there would
  --     have broken all of them for no gain.
  --
  -- step_index IS the cursor at send time: gateNotifier.js only ever enqueues
  -- while the cursor sits on that gate. So there is no separate cursor column.
  --
  -- decided_at scopes decidedness TO THIS ARRIVAL. A gate_decision lookup
  -- cannot: store.requestChanges() writes a 'rejected' gate_decision row that
  -- is never deleted, so an item that is sent back, reworked and returns to the
  -- same gate would have every later vote refused forever.
  --
  -- superseded_at closes the other end of the same window: arrival #2's poll
  -- being live must not leave arrival #1's poll able to decide it.
  --
  -- ON DELETE CASCADE for the same reason gate_notice has it: purgeDemoItems()
  -- in store.js hand-enumerates the children it clears, and this must not rely
  -- on being remembered there.
  CREATE TABLE IF NOT EXISTS gate_poll (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id         TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
    step_index      INTEGER NOT NULL,
    recipient       TEXT NOT NULL,
    question        TEXT NOT NULL,
    poll_msg_id     TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sending','sent','failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at         TEXT,
    decided_at      TEXT,
    superseded_at   TEXT
  );
  -- A PARTIAL unique index, not a UNIQUE column: poll_msg_id is NULL between
  -- enqueue and a successful send, and many NULLs have to coexist. Unique once
  -- set, because the id is what a vote is looked up by.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_gate_poll_msg ON gate_poll(poll_msg_id) WHERE poll_msg_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_gate_poll_due ON gate_poll(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_gate_poll_item ON gate_poll(item_id, id DESC);

  -- Every vote the server has ever seen, applied or not (HZ-142).
  --
  -- vote_id is the poll-update message id, and the PRIMARY KEY on it IS the
  -- idempotence mechanism: processing the same vote twice collides and inserts
  -- nothing, so there is no separate bookkeeping to keep in step. The bridge
  -- retries, so a double delivery is the normal case rather than an edge one.
  --
  -- poll_id is nullable so a vote naming a poll this server has never heard of
  -- is still recorded rather than silently dropped.
  CREATE TABLE IF NOT EXISTS gate_poll_vote (
    vote_id    TEXT PRIMARY KEY,
    poll_id    INTEGER REFERENCES gate_poll(id) ON DELETE CASCADE,
    voter_jid  TEXT NOT NULL,
    choice     TEXT NOT NULL,
    outcome    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_gate_poll_vote_poll ON gate_poll_vote(poll_id);

  -- HZ-216: the long gate actions — pre-merge checks + merge (HZ-183) and
  -- conflict resolution (HZ-188). One row per (item, kind). It replaces the
  -- memory-only premergeInFlight Set and conflictRuns Map: the same row is the
  -- 409 lock and what the UI shows, so a restart neither forgets a run nor
  -- allows a second one. deadline_at is the lease — the run's own timeout plus
  -- GATE_ACTION_MARGIN_MS; store.sweepGateActions() moves an expired running
  -- row out of running, so a gate is never disabled for good.
  --
  -- run_token: only the run that claimed the row may finish it, so a stale
  -- owner cannot release a newer run's lock. epoch: the item's latest
  -- gate_decision and step_run ids at claim time — a finished row from an
  -- earlier visit to the gate is not shown on a later one.
  --
  -- ON DELETE CASCADE for the same reason gate_notice has it.
  CREATE TABLE IF NOT EXISTS gate_action (
    item_id       TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('premerge','resolve')),
    state         TEXT NOT NULL CHECK (state IN ('running','merged','blocked','failed',
                    'resolved','escalated','timed_out','interrupted')),
    run_token     TEXT NOT NULL,
    epoch         TEXT NOT NULL,
    detail        TEXT,
    reason        TEXT,
    failing_check TEXT,
    started_at    TEXT NOT NULL,
    deadline_at   TEXT NOT NULL,
    finished_at   TEXT,
    PRIMARY KEY (item_id, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_gate_action_running ON gate_action(state, deadline_at);
`)

// Additive migrations for databases created before these columns existed.
// persona: the pre-HZ-125 flat specialist persona id. Read-only since HZ-125 —
// never written again, kept so rows that predate personas_json still carry the
// value personasFromRow (personas.js) translates into an eng-slot persona.
// personas_json (HZ-125): the item's { agent: persona id } map, one slot per
// composing agent. NULL/absent = every agent's default (see DEFAULT_PERSONAS).
// A JSON column rather than a child table because nothing queries across items
// by persona, and one column keeps reads a single-row operation.
// notified_step (HZ-141): the gate index this item was last notified about, or
// NULL when it is not parked at a notified gate. Derived state, not a log — the
// sweep clears it the moment the cursor leaves a gate, which is what makes a
// send-back-then-re-approve notify twice and a restart notify zero more times.
// last_reviewed_sha (HZ-182): the PR head the last automated review read, as
// reported by the farm. NULL = no review yet, so the next review is full.
// fix_pass / fix_findings_json (HZ-182): set when a review rejects under the
// cap — the next implement run is fix-only and the review after it is a delta
// review over these findings. 0 / NULL = full mode, so existing rows migrate
// to today's behaviour untouched.
// forwarded_review_run_id / forwarded_by / forwarded_sha (HZ-185): set when a
// failing review is forwarded to Accept the code (the review cap, or a human
// with the gate PIN) — which review run the gate shows, who forwarded it, and
// the commit that review read. NULL = not forwarded, so existing rows render
// the gate exactly as before.
for (const column of ['pr INTEGER', 'pr_url TEXT', 'pr_mergeable INTEGER', 'release_tag TEXT', 'release_url TEXT', 'repo TEXT', 'project_id INTEGER', 'persona TEXT', 'personas_json TEXT', 'review_cycle_count INTEGER NOT NULL DEFAULT 0', 'abandoned_at TEXT', 'abandoned_reason TEXT', 'abandoned_by TEXT', 'notified_step INTEGER', 'last_reviewed_sha TEXT', 'fix_pass INTEGER NOT NULL DEFAULT 0', 'fix_findings_json TEXT', 'forwarded_review_run_id INTEGER', 'forwarded_by TEXT', 'forwarded_sha TEXT']) {
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
try {
  // HZ-76: consecutive AUTOMATIC retries that produced this row, carried
  // forward from the run being retried. Reset to 0 by any non-automatic
  // dispatch (resume, review send-back, normal advance) since kick()'s
  // opts.autoRetryCount defaults to 0 everywhere except the retry path
  // itself. The hard cap check in failFarmRun reads this column — never a
  // prompt or agent decision.
  db.exec('ALTER TABLE step_run ADD COLUMN auto_retry_count INTEGER NOT NULL DEFAULT 0')
} catch {
  // column already exists
}
try {
  // HZ-102: which agent_runner provider actually executed this step
  // (e.g. 'claude', 'muse') and, when the provider exposes one, its
  // run-level id (Muse's command_id from run.terminal.completed — never a
  // session handle, see farm/providers/muse.py). Both NULL for every row
  // written before this landed and for any step whose provider never
  // reported provenance — no backfill, no fabricated history.
  db.exec('ALTER TABLE step_run ADD COLUMN provider TEXT')
} catch {
  // column already exists
}
try {
  db.exec('ALTER TABLE step_run ADD COLUMN command_id TEXT')
} catch {
  // column already exists
}
try {
  // HZ-182: the scope an implement or review run was dispatched with
  // ({mode: 'fix'|'delta'|'full', ...}). Completion reads it back rather than
  // recomputing from the item, which may have changed mid-run. NULL = full.
  db.exec('ALTER TABLE step_run ADD COLUMN scope_json TEXT')
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

// HZ-207: each project has an enabled flag; the farm dispatches every enabled
// project's items. Additive and once-only: Horizon is on, and so is the
// project the board shows today, so nothing that runs now stops running.
// With neither, the first project is on. farm_project_id pins the project
// farmd was started for (the concierge's) to the one it runs now, so the
// deploy never restarts farmd. One transaction: a crash after the ALTER
// can't leave every project disabled with nothing to re-run the UPDATE.
if (!db.prepare('PRAGMA table_info(project)').all().some((column) => column.name === 'enabled')) {
  db.transaction(() => {
    db.exec('ALTER TABLE project ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0')
    db.exec(`
      UPDATE project SET enabled = 1
      WHERE name = 'Horizon' COLLATE NOCASE
         OR id = (SELECT CAST(value AS INTEGER) FROM setting WHERE key = 'active_project_id');
      UPDATE project SET enabled = 1
      WHERE id = (SELECT MIN(id) FROM project) AND NOT EXISTS (SELECT 1 FROM project WHERE enabled = 1);
      INSERT OR IGNORE INTO setting (key, value)
        SELECT 'farm_project_id', CAST(id AS TEXT) FROM project
        WHERE enabled = 1
        ORDER BY id = (SELECT CAST(value AS INTEGER) FROM setting WHERE key = 'active_project_id') DESC,
                 name = 'Horizon' COLLATE NOCASE DESC, id
        LIMIT 1;
    `)
  })()
}

// HZ-235: who started a gate action — 'human' (a click) or 'main_moved'
// (autoResolve.js, after a merge into main). Additive and nullable: NULL is a
// row from before this column, which only a human could have started.
if (!db.prepare('PRAGMA table_info(gate_action)').all().some((column) => column.name === 'started_by')) {
  db.exec('ALTER TABLE gate_action ADD COLUMN started_by TEXT')
}

// HZ-245: per-repo check commands, set by a human in Admin. Additive and
// nullable: NULL in all four is "not configured", so the farm auto-detects
// exactly as before. Deliberately no seed — not for FinTekkers/horizon, not
// for anything else; a human enters them after deploy.
const projectRepoColumns = new Set(db.prepare('PRAGMA table_info(project_repo)').all().map((column) => column.name))
for (const column of ['check_install', 'check_test', 'check_lint', 'check_e2e']) {
  if (!projectRepoColumns.has(column)) db.exec(`ALTER TABLE project_repo ADD COLUMN ${column} TEXT`)
}

// HZ-270: per-project Autopilot. Additive: every existing and new project is
// 'off', and an 'off' project's items are never read by the caretaker.
if (!db.prepare('PRAGMA table_info(project)').all().some((column) => column.name === 'autopilot')) {
  db.exec("ALTER TABLE project ADD COLUMN autopilot TEXT NOT NULL DEFAULT 'off' CHECK (autopilot IN ('off','shadow','on'))")
}

// HZ-270: project_event is the project-level audit trail (event.item_id is
// NOT NULL, so an Autopilot change cannot live there). caretaker_eval holds one
// row per gate arrival the caretaker judged; its UNIQUE key is the persisted
// "once per arrival" rule, so a re-run or a restart can never add a second.
// arrival_run_id is the done step_run that fed the gate (0 when there is none).
db.exec(`
  CREATE TABLE IF NOT EXISTS project_event (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES project(id),
    kind       TEXT NOT NULL,
    old_value  TEXT,
    new_value  TEXT,
    who        TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_project_event_project ON project_event(project_id, id DESC);

  CREATE TABLE IF NOT EXISTS caretaker_eval (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id        TEXT NOT NULL REFERENCES work_item(id),
    gate_index     INTEGER NOT NULL,
    arrival_run_id INTEGER NOT NULL,
    mode           TEXT NOT NULL CHECK (mode IN ('shadow','on')),
    decision       TEXT NOT NULL CHECK (decision IN ('approve','send_back','resolve_conflicts','wait','ping_human')),
    rule_id        TEXT,
    reason         TEXT NOT NULL,
    comment        TEXT,
    event_id       INTEGER REFERENCES event(id),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (item_id, gate_index, arrival_run_id)
  );
`)

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

// HZ-141: re-baseline notified_step against the cursors as they stand right
// now — every item currently parked at a gate is treated as ALREADY notified,
// every item that is not is cleared.
//
// ANY FUTURE CURSOR-SHIFT MIGRATION MUST CALL THIS. The pipeline-v2 and -v3
// shifts above are the precedent: shifting `cursor` without re-baselining
// leaves notified_step pointing at a step index that has moved, so the sweep
// reads the shift as five fresh arrivals and messages a human five times. This
// is exported (and covered by gate-notifier-baseline.test.mjs) so the next
// shift author gets a function to call and a red test, not a comment to notice.
export function baselineNotifiedStep(database = db) {
  const gates = gateStepIndexes()
  const placeholders = gates.map(() => '?').join(',')
  return database.transaction(() => {
    database.prepare(`UPDATE work_item SET notified_step = cursor WHERE cursor IN (${placeholders})`).run(...gates)
    database.prepare(`UPDATE work_item SET notified_step = NULL WHERE cursor NOT IN (${placeholders})`).run(...gates)
  })
}

// One-time on first boot after HZ-141 ships, and placed LAST on purpose: it
// reads final cursors, so it must run after both cursor-shift migrations AND
// after the demo seed (whose SEED_ITEMS park items on all five gates — without
// this, a fresh dev box with WA_NOTIFY_ENABLED=1 fires five demo notifications
// on the first sweep). Same double-boot guard as the shifts above: the setting
// INSERT is the last statement, so a racing second boot rolls the whole
// transaction back on the primary-key collision.
if (!db.prepare("SELECT value FROM setting WHERE key = 'gate_notice_baseline'").get()) {
  db.transaction(() => {
    baselineNotifiedStep(db)()
    db.prepare("INSERT INTO setting (key, value) VALUES ('gate_notice_baseline', 'done')").run()
  })()
}
