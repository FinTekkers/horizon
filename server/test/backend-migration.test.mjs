// HO-870: the backend migration on a database from before it existed.
// Additive only: every existing project_repo and work_item row reads
// backend 'github' and the four sl columns NULL; a second boot changes
// nothing; the DB refuses any backend outside github/sl; and an item's backend
// can never be updated — not even after the HZ-446 work_item rebuild, which
// re-creates indexes but drops triggers.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { ITEM_KINDS } from '../../domain/js/lifecycle.js'

const DB_MODULE = fileURLToPath(new URL('../src/db.js', import.meta.url))
const ITEM_COLUMNS = ['backend', 'task_id', 'diff_id', 'landed_hash', 'landed_at']
const TRIGGER = 'work_item_backend_no_update'
const KIND_CHECK = `CHECK (kind IN (${ITEM_KINDS.map((kind) => `'${kind}'`).join(',')}))`

function env(path) {
  const out = { ...process.env, HORIZON_DB: path }
  delete out.HORIZON_REPO
  return out
}

// Each boot is its own process, the way the server opens the DB.
function boot(path) {
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(DB_MODULE)})`], {
    env: env(path),
    timeout: 60_000,
  })
}

const columnNames = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
const hasTrigger = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(TRIGGER)
const workItemSql = (db) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_item'").get().sql

// A database as the previous release left it: the full schema minus what
// HO-870 adds, with two connected repos and items synced from them.
function legacyDb() {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-backend-migration-')), 'test.db')
  boot(path)
  const db = new Database(path)
  db.exec(`DROP TRIGGER ${TRIGGER}`)
  for (const column of ITEM_COLUMNS) db.exec(`ALTER TABLE work_item DROP COLUMN ${column}`)
  db.exec('ALTER TABLE project_repo DROP COLUMN backend')
  assert.ok(!hasTrigger(db))
  const projectId = db.prepare("INSERT INTO project (name) VALUES ('Legacy')").run().lastInsertRowid
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/one', 'ON')").run(projectId)
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/two', 'TW')").run(projectId)
  const item = db.prepare("INSERT INTO work_item (id, title, priority, repo, issue, project_id) VALUES (?, ?, 'Medium', ?, ?, ?)")
  item.run('ON-1', 'One', 'acme/one', 1, projectId)
  item.run('ON-2', 'Two', 'acme/one', 2, projectId)
  item.run('TW-1', 'Three', 'acme/two', 1, projectId)
  db.close()
  return path
}

// Rewrites work_item with an older kind CHECK (every kind but the last), the
// way a release from before that kind stored it, so the next boot runs the
// HZ-446 rebuild. Indexes and triggers are put back as they were.
function withOldKindCheck(path) {
  const db = new Database(path)
  const sql = workItemSql(db)
  assert.ok(sql.includes(KIND_CHECK))
  const oldCheck = `CHECK (kind IN (${ITEM_KINDS.slice(0, -1).map((kind) => `'${kind}'`).join(',')}))`
  const extras = db
    .prepare("SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = 'work_item' AND sql IS NOT NULL")
    .all()
    .map((row) => row.sql)
  db.prepare('DELETE FROM work_item WHERE kind = ?').run(ITEM_KINDS.at(-1))
  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    db.exec(sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?work_item["`]?\s*\(/i, 'CREATE TABLE work_item_old (').replace(KIND_CHECK, oldCheck))
    db.exec('INSERT INTO work_item_old SELECT * FROM work_item; DROP TABLE work_item; ALTER TABLE work_item_old RENAME TO work_item;')
    for (const extra of extras) db.exec(extra)
  })()
  assert.ok(!workItemSql(db).includes(KIND_CHECK))
  db.close()
}

function assertImmutable(db, label) {
  assert.ok(hasTrigger(db), `${label}: ${TRIGGER} exists`)
  assert.throws(() => db.exec("UPDATE work_item SET backend = 'sl'"), /work_item\.backend is immutable/, label)
  assert.deepEqual(
    db.prepare('SELECT DISTINCT backend FROM work_item').all().map((r) => r.backend),
    ['github'],
    `${label}: every backend is still github`,
  )
  // Other updates, and a same-value write, still go through.
  db.exec("UPDATE work_item SET title = title || '!', backend = backend")
}

test('metric 1: after migrating an old DB, every project_repo.backend and work_item.backend is github and the four sl columns are NULL', () => {
  const path = legacyDb()
  boot(path)
  const db = new Database(path, { readonly: true })
  const repos = db.prepare('SELECT repo, backend FROM project_repo ORDER BY repo').all()
  assert.deepEqual(repos, [
    { repo: 'acme/one', backend: 'github' },
    { repo: 'acme/two', backend: 'github' },
  ])
  const items = db.prepare(`SELECT id, ${ITEM_COLUMNS.join(', ')} FROM work_item`).all()
  assert.ok(items.length >= 3, 'the seeded items are there')
  for (const item of items) {
    assert.deepEqual(item, { id: item.id, backend: 'github', task_id: null, diff_id: null, landed_hash: null, landed_at: null }, item.id)
  }
  assert.ok(hasTrigger(db))
  db.close()
})

test('metric 1 / guardrail 1: a second boot of the migrated DB does not throw, adds no column and leaves every backend alone', () => {
  const path = legacyDb()
  boot(path)
  const read = () => {
    const db = new Database(path, { readonly: true })
    const out = {
      repoColumns: columnNames(db, 'project_repo'),
      itemColumns: columnNames(db, 'work_item'),
      repos: db.prepare('SELECT repo, backend FROM project_repo ORDER BY repo').all(),
      items: db.prepare('SELECT id, backend FROM work_item ORDER BY id').all(),
    }
    db.close()
    return out
  }
  const first = read()
  assert.doesNotThrow(() => boot(path))
  const second = read()
  assert.deepEqual(second, first)
  for (const column of ITEM_COLUMNS) assert.equal(second.itemColumns.filter((c) => c === column).length, 1, column)
  assert.equal(second.repoColumns.filter((c) => c === 'backend').length, 1)
})

test('guardrail 2: the DB refuses a backend outside github/sl on project_repo and on work_item', () => {
  const path = legacyDb()
  boot(path)
  const db = new Database(path)
  const projectId = db.prepare("SELECT id FROM project WHERE name = 'Legacy'").get().id
  assert.throws(
    () => db.prepare("INSERT INTO project_repo (project_id, repo, prefix, backend) VALUES (?, 'acme/bad', 'BA', 'internal')").run(projectId),
    /CHECK constraint failed/,
  )
  assert.throws(
    () => db.prepare("INSERT INTO work_item (id, title, priority, backend) VALUES ('X-1', 'x', 'Medium', 'internal')").run(),
    /CHECK constraint failed/,
  )
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_repo WHERE repo = 'acme/bad'").get().n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_item WHERE id = 'X-1'").get().n, 0)
  // Both real values are accepted.
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix, backend) VALUES (?, 'acme/sl', 'SL', 'sl')").run(projectId)
  db.prepare("INSERT INTO work_item (id, title, priority, backend) VALUES ('SL-1', 'x', 'Medium', 'sl')").run()
  db.close()
})

test('guardrail 2: an item backend stays immutable after the work_item_v2 rebuild — from a legacy DB and from an already-migrated one', () => {
  // Legacy: the rebuild runs, then the columns and trigger are added.
  const legacy = legacyDb()
  withOldKindCheck(legacy)
  boot(legacy)
  // Already migrated: the trigger exists before the boot, and the rebuild's
  // DROP TABLE takes it with it — the boot must put it back.
  const migrated = legacyDb()
  boot(migrated)
  withOldKindCheck(migrated)
  {
    const db = new Database(migrated, { readonly: true })
    assert.ok(hasTrigger(db), 'the fixture carries the trigger into the rebuild')
    db.close()
  }
  boot(migrated)
  for (const [label, path] of [
    ['legacy', legacy],
    ['migrated', migrated],
  ]) {
    const db = new Database(path)
    assert.ok(workItemSql(db).includes(KIND_CHECK), `${label}: the rebuild ran`)
    assertImmutable(db, label)
    db.close()
  }
})
