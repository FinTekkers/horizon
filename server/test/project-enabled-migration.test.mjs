// HZ-207: the enabled-flag migration on a database from before it existed.
// Additive and once-only: Horizon (and the project the board shows today) is
// on, every other project is off, and no item or event row is touched.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const DB_MODULE = fileURLToPath(new URL('../src/db.js', import.meta.url))

// Each boot is its own process, the way the server opens the DB.
function boot(path) {
  const env = { ...process.env, HORIZON_DB: path }
  delete env.HORIZON_REPO
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(DB_MODULE)})`], { env })
}

// A database as the previous release left it: no enabled column, no farm pin.
function oldSchemaDb(activeName) {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-enabled-migration-')), 'test.db')
  boot(path)
  const db = new Database(path)
  db.exec('ALTER TABLE project DROP COLUMN enabled')
  db.exec("DELETE FROM setting WHERE key = 'farm_project_id'")
  for (const name of ['Horizon', 'FinTekkers', 'Ledger']) db.prepare('INSERT INTO project (name) VALUES (?)').run(name)
  const id = (name) => db.prepare('SELECT id FROM project WHERE name = ?').get(name).id
  db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES ('active_project_id', ?)").run(String(id(activeName)))
  const insert = db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo, project_id) VALUES (?, ?, 'Medium', 3, ?, ?)")
  insert.run('HZ-1', 'Horizon item', 'FinTekkers/horizon', id('Horizon'))
  insert.run('US-1', 'FinTekkers item', 'FinTekkers/ui-service', id('FinTekkers'))
  db.prepare("INSERT INTO event (item_id, who, text, color, initials) VALUES ('US-1', 'You', 'history', '#000', 'YO')").run()
  db.close()
  return path
}

function snapshot(path) {
  const db = new Database(path, { readonly: true })
  try {
    return {
      enabled: db.prepare('PRAGMA table_info(project)').all().some((c) => c.name === 'enabled')
        ? Object.fromEntries(db.prepare('SELECT name, enabled FROM project').all().map((p) => [p.name, p.enabled]))
        : null,
      farmProject: db.prepare("SELECT p.name FROM setting s JOIN project p ON p.id = CAST(s.value AS INTEGER) WHERE s.key = 'farm_project_id'").get()?.name ?? null,
      items: JSON.stringify(db.prepare('SELECT * FROM work_item ORDER BY id').all()),
      events: JSON.stringify(db.prepare('SELECT * FROM event ORDER BY id').all()),
    }
  } finally {
    db.close()
  }
}

test('Horizon is enabled and every other project disabled; items and events are byte-identical; a rerun is a no-op', () => {
  const path = oldSchemaDb('Horizon')
  const before = snapshot(path)
  assert.equal(before.enabled, null, 'the fixture really is the old schema')
  boot(path)
  const after = snapshot(path)
  assert.deepEqual(after.enabled, { Horizon: 1, FinTekkers: 0, Ledger: 0 })
  assert.equal(after.farmProject, 'Horizon')
  assert.equal(after.items, before.items)
  assert.equal(after.events, before.events)

  boot(path)
  assert.deepEqual(snapshot(path), after)
})

test('when the board shows FinTekkers, FinTekkers stays enabled alongside Horizon and keeps the farm pinned', () => {
  const path = oldSchemaDb('FinTekkers')
  const before = snapshot(path)
  boot(path)
  const after = snapshot(path)
  assert.deepEqual(after.enabled, { Horizon: 1, FinTekkers: 1, Ledger: 0 })
  assert.equal(after.farmProject, 'FinTekkers', 'farmd keeps running the project it runs today: no restart at deploy')
  assert.equal(after.items, before.items)
  assert.equal(after.events, before.events)
})
