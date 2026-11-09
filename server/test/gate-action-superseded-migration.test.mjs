// HZ-822: a pre-merge run stopped because its PR merged on GitHub ends as
// `superseded`. SQLite cannot widen a CHECK in place, so db.js rebuilds
// gate_action once when its stored DDL lacks that state. The database is
// built with today's schema, then gate_action is put back to the old
// constraint (started_by added later by ALTER, as on the host) with one row —
// then db.js is loaded, so its migration runs over it. The row, started_by and
// the index must survive, a `superseded` write must succeed, and a second boot
// must not rebuild.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const dbPath = join(mkdtempSync(join(tmpdir(), 'horizon-gate-action-superseded-')), 'test.db')

const dbModule = fileURLToPath(new URL('../src/db.js', import.meta.url))
const boot = () =>
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(dbModule)})`], {
    env: { ...process.env, HORIZON_DB: dbPath },
    stdio: 'pipe',
  })

// Today's schema, then gate_action put back to the shape the host has.
boot()
const old = new Database(dbPath)
old.pragma('foreign_keys = OFF')
old.exec(`
  DROP TABLE gate_action;
  CREATE TABLE gate_action (
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
  CREATE INDEX idx_gate_action_running ON gate_action(state, deadline_at);
  ALTER TABLE gate_action ADD COLUMN started_by TEXT;
  INSERT INTO work_item (id, title, priority, cursor) VALUES ('T-MIG-1', 'Migrated', 'Medium', 0);
  INSERT INTO gate_action (item_id, kind, state, run_token, epoch, detail, reason, failing_check, started_at, deadline_at, finished_at, started_by)
    VALUES ('T-MIG-1', 'premerge', 'blocked', 'tok-1', '1:2', 'npm test', 'pre-merge checks failed: unit', 'unit',
            '2026-11-01T10:00:00.000Z', '2026-11-01T11:00:00.000Z', '2026-11-01T10:30:00.000Z', 'main_moved');
`)
old.close()

process.env.HORIZON_DB = dbPath
const { db } = await import('../src/db.js')

const tableSql = () => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gate_action'").get().sql
const rows = () => db.prepare("SELECT * FROM gate_action WHERE item_id = 'T-MIG-1'").all().map((r) => ({ ...r }))
const EXPECTED_ROW = {
  item_id: 'T-MIG-1',
  kind: 'premerge',
  state: 'blocked',
  run_token: 'tok-1',
  epoch: '1:2',
  detail: 'npm test',
  reason: 'pre-merge checks failed: unit',
  failing_check: 'unit',
  started_at: '2026-11-01T10:00:00.000Z',
  deadline_at: '2026-11-01T11:00:00.000Z',
  finished_at: '2026-11-01T10:30:00.000Z',
  started_by: 'main_moved',
}

test('the rebuild adds superseded and keeps the row, started_by and the index', () => {
  assert.ok(tableSql().includes("'timed_out','interrupted','superseded'))"), tableSql())
  assert.deepEqual(rows(), [EXPECTED_ROW])
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_gate_action_running'").get(), 'the index is re-created')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'gate_action_v2'").get().n, 0)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys are back on after the rebuild')
})

test('a superseded write now succeeds, and an unknown state is still refused', () => {
  db.prepare("UPDATE gate_action SET state = 'superseded' WHERE item_id = 'T-MIG-1'").run()
  assert.equal(db.prepare("SELECT state FROM gate_action WHERE item_id = 'T-MIG-1'").get().state, 'superseded')
  assert.throws(() => db.prepare("UPDATE gate_action SET state = 'bogus' WHERE item_id = 'T-MIG-1'").run(), /CHECK constraint failed/)
  db.prepare("UPDATE gate_action SET state = 'blocked' WHERE item_id = 'T-MIG-1'").run()
})

test('a second boot does not rebuild again and changes nothing', () => {
  const rootpage = () => db.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'gate_action'").get().rootpage
  const before = { sql: tableSql(), rootpage: rootpage(), rows: rows() }
  boot()
  assert.equal(tableSql(), before.sql)
  assert.equal(rootpage(), before.rootpage, 'gate_action was rebuilt again')
  assert.deepEqual(rows(), before.rows)
  assert.deepEqual(rows(), [EXPECTED_ROW])
})
