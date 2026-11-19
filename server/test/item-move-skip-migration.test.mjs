// HZ-920: a human's Move to… → Close is logged as an item_move `skip`.
// SQLite cannot widen a CHECK in place, so db.js rebuilds item_move once when
// its stored DDL lacks that action. The database is built with today's
// schema, then item_move is put back to the HZ-710 constraint with two rows
// (the top one deleted, so the AUTOINCREMENT high-water mark matters) — then
// db.js is loaded, so its migration runs over it. The row, the index and the
// next id must survive, a `skip` write must succeed, and a second boot must
// not rebuild.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const dbPath = join(mkdtempSync(join(tmpdir(), 'horizon-item-move-skip-')), 'test.db')

const dbModule = fileURLToPath(new URL('../src/db.js', import.meta.url))
const env = { ...process.env, HORIZON_DB: dbPath }
delete env.FARM_HOME
const boot = () =>
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(dbModule)})`], { env, stdio: 'pipe' })

// Today's schema, then item_move put back to the shape the host has.
boot()
const old = new Database(dbPath)
old.pragma('foreign_keys = OFF')
old.exec(`
  DROP TABLE item_move;
  CREATE TABLE IF NOT EXISTS item_move (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
    who        TEXT NOT NULL,
    from_key   TEXT NOT NULL,
    to_key     TEXT NOT NULL,
    action     TEXT NOT NULL CHECK (action IN ('approve','return','retry','abandon','reopen','close')),
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS item_move_item ON item_move (item_id, id);
  INSERT INTO work_item (id, title, priority, cursor, kind) VALUES ('T-MIG-1', 'Migrated', 'Medium', 0, 'task');
  INSERT INTO item_move (item_id, who, from_key, to_key, action, note, created_at)
    VALUES ('T-MIG-1', 'David', 'task.approve-run', 'task.run-plan', 'return', 'rerun it', '2026-11-01 10:00:00');
  INSERT INTO item_move (item_id, who, from_key, to_key, action, note, created_at)
    VALUES ('T-MIG-1', 'David', 'task.run-plan', 'task.run-plan', 'retry', '', '2026-11-01 11:00:00');
  DELETE FROM item_move WHERE id = 2;
`)
old.close()

process.env.HORIZON_DB = dbPath
const { db } = await import('../src/db.js')

const tableSql = () => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'item_move'").get().sql
const rows = () => db.prepare("SELECT * FROM item_move WHERE item_id = 'T-MIG-1' ORDER BY id").all().map((r) => ({ ...r }))
const EXPECTED_ROW = {
  id: 1,
  item_id: 'T-MIG-1',
  who: 'David',
  from_key: 'task.approve-run',
  to_key: 'task.run-plan',
  action: 'return',
  note: 'rerun it',
  created_at: '2026-11-01 10:00:00',
}

test('the rebuild adds skip and keeps the row and the index', () => {
  assert.ok(tableSql().includes("'reopen','close','skip'))"), tableSql())
  assert.deepEqual(rows(), [EXPECTED_ROW])
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'item_move_item'").get(), 'the index is re-created')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'item_move_v2'").get().n, 0)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys are back on after the rebuild')
})

test('a skip write now succeeds past the old top id, and an unknown action is still refused', () => {
  const insert = db.prepare("INSERT INTO item_move (item_id, who, from_key, to_key, action) VALUES ('T-MIG-1', 'David', ?, ?, ?)")
  const id = Number(insert.run('task.run-plan', 'task.review-close', 'skip').lastInsertRowid)
  assert.equal(id, 3, 'the deleted top id 2 is not reused')
  assert.throws(() => insert.run('task.run-plan', 'task.execute', 'jump'), /CHECK constraint failed/)
})

test('a second boot does not rebuild again and changes nothing', () => {
  const rootpage = () => db.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'item_move'").get().rootpage
  const before = { sql: tableSql(), rootpage: rootpage(), rows: rows() }
  boot()
  assert.equal(tableSql(), before.sql)
  assert.equal(rootpage(), before.rootpage, 'item_move was rebuilt again')
  assert.deepEqual(rows(), before.rows)
  assert.equal(rows().length, 2)
})
