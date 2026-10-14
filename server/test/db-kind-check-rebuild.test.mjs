// HZ-446: a database from before the plan kind has work_item's kind CHECK
// pinned to ('change','task'). SQLite cannot widen a CHECK in place, so
// db.js rebuilds work_item once. The database is built here with that old
// constraint, change and task rows, and child rows in event, step_run and a
// cascading table — then db.js is loaded, so its migration runs over them.
// Every row, kind and child must survive, and a second boot must not rebuild.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const dbPath = join(mkdtempSync(join(tmpdir(), 'horizon-kind-rebuild-')), 'test.db')
const OLD_CHECK = "CHECK (kind IN ('change','task'))"

const old = new Database(dbPath)
old.exec(`
  CREATE TABLE work_item (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, priority TEXT NOT NULL,
    desc TEXT NOT NULL DEFAULT '', metric TEXT NOT NULL DEFAULT '', guardrails TEXT NOT NULL DEFAULT '',
    issue INTEGER, cursor INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ALTER TABLE work_item ADD COLUMN repo TEXT;
  ALTER TABLE work_item ADD COLUMN kind TEXT NOT NULL DEFAULT 'change' ${OLD_CHECK};
  CREATE UNIQUE INDEX idx_work_item_repo_issue ON work_item(repo, issue);
  CREATE TABLE event (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES work_item(id),
    who TEXT NOT NULL, text TEXT NOT NULL, color TEXT NOT NULL, initials TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE step_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES work_item(id),
    step_index INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, agent TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','cancelled','rejected','superseded')),
    output TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT
  );
  -- ON DELETE CASCADE: dropping work_item with foreign keys on would empty it.
  CREATE TABLE gate_notice (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
    step_index INTEGER NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT
  );
  -- A database this recent already ran the one-time cursor shifts.
  CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO setting (key, value) VALUES ('pipeline_v2_shift', 'done'), ('pipeline_v3_review_shift', 'done');

  INSERT INTO work_item (id, title, priority, cursor, repo, issue, kind) VALUES
    ('OLD-CHANGE', 'A change', 'Medium', 4, 'acme/app', 11, 'change'),
    ('OLD-TASK', 'A task', 'Medium', 19, 'acme/app', 12, 'task');
  INSERT INTO work_item (id, title, priority) VALUES ('OLD-LEGACY', 'No kind written', 'Medium');
  INSERT INTO event (item_id, who, text, color, initials) VALUES
    ('OLD-CHANGE', 'You', 'created', '#000', 'YOU'), ('OLD-TASK', 'You', 'created', '#000', 'YOU');
  INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES
    ('OLD-CHANGE', 0, 'PM', 'done', 'ok'), ('OLD-TASK', 16, 'PM', 'done', 'ok');
  INSERT INTO gate_notice (item_id, step_index, recipient, body) VALUES ('OLD-CHANGE', 3, 'r', 'b');
`)
old.close()

process.env.HORIZON_DB = dbPath
const { db } = await import('../src/db.js')

const tableSql = () => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_item'").get().sql
const rows = () => db.prepare('SELECT id, title, priority, cursor, repo, issue, kind FROM work_item ORDER BY id').all()
const childCounts = () => ({
  event: db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id LIKE 'OLD-%'").get().n,
  step_run: db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id LIKE 'OLD-%'").get().n,
  gate_notice: db.prepare("SELECT COUNT(*) AS n FROM gate_notice WHERE item_id LIKE 'OLD-%'").get().n,
})
const EXPECTED_ROWS = [
  { id: 'OLD-CHANGE', title: 'A change', priority: 'Medium', cursor: 4, repo: 'acme/app', issue: 11, kind: 'change' },
  { id: 'OLD-LEGACY', title: 'No kind written', priority: 'Medium', cursor: 0, repo: null, issue: null, kind: 'change' },
  { id: 'OLD-TASK', title: 'A task', priority: 'Medium', cursor: 19, repo: 'acme/app', issue: 12, kind: 'task' },
]

test('the rebuild widens the kind CHECK and keeps every row, kind and child row', () => {
  const sql = tableSql()
  assert.ok(sql.includes("CHECK (kind IN ('change','task','plan'))"), sql)
  assert.ok(!sql.includes(OLD_CHECK), sql)
  assert.deepEqual(rows().map((r) => ({ ...r })), EXPECTED_ROWS)
  assert.deepEqual(childCounts(), { event: 2, step_run: 2, gate_notice: 1 })
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys are back on after the rebuild')
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_item_repo_issue'").get())
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'work_item_v2'").get().n, 0)
})

test('a plan now inserts, an unknown kind is still refused, and a cascade still reaches the children', () => {
  db.prepare("INSERT INTO work_item (id, title, priority, kind) VALUES ('NEW-PLAN', 'A plan', 'Medium', 'plan')").run()
  assert.equal(db.prepare("SELECT kind FROM work_item WHERE id = 'NEW-PLAN'").get().kind, 'plan')
  assert.throws(
    () => db.prepare("INSERT INTO work_item (id, title, priority, kind) VALUES ('NEW-BAD', 'Bad', 'Medium', 'banana')").run(),
    /CHECK constraint failed/,
  )
  // The repo/issue uniqueness survived the rebuild.
  assert.throws(
    () => db.prepare("INSERT INTO work_item (id, title, priority, repo, issue) VALUES ('NEW-DUP', 'Dup', 'Medium', 'acme/app', 11)").run(),
    /UNIQUE constraint failed/,
  )
  db.prepare("DELETE FROM work_item WHERE id = 'NEW-PLAN'").run()
})

test('a second boot does not rebuild again and changes nothing', () => {
  const before = {
    sql: tableSql(),
    rootpage: db.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'work_item'").get().rootpage,
    rows: rows(),
    children: childCounts(),
  }
  const dbModule = fileURLToPath(new URL('../src/db.js', import.meta.url))
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(dbModule)})`], {
    env: { ...process.env, HORIZON_DB: dbPath },
    stdio: 'pipe',
  })
  assert.equal(tableSql(), before.sql)
  assert.equal(
    db.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'work_item'").get().rootpage,
    before.rootpage,
    'work_item was rebuilt again',
  )
  assert.deepEqual(rows(), before.rows)
  assert.deepEqual(childCounts(), before.children)
})
