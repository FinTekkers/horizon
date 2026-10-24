// HZ-538 metric 4: the sub-step columns on a database from before they
// existed. Additive only: all three are nullable with no default, and every
// existing work_item and step_run row — cursor and step_index included —
// reads back byte-identical.

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

const NEW_COLUMNS = { work_item: ['substeps_json', 'substep_cursor'], step_run: ['substep_id'] }

// A database as the previous release left it, with rows in it.
function oldSchemaDb() {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-substeps-migration-')), 'test.db')
  boot(path)
  const db = new Database(path)
  for (const [table, columns] of Object.entries(NEW_COLUMNS)) {
    for (const column of columns) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
  }
  db.prepare("INSERT INTO project (name) VALUES ('Acme Capital')").run()
  const insert = db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, repo, project_id) VALUES (?, ?, 'Medium', ?, ?, 'Acme/core', 1)")
  insert.run('AC-1', 'A change mid-flight', 11, 'change')
  insert.run('AC-2', 'A task mid-flight', 24, 'task')
  const run = db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, ?, ?, 'done')")
  run.run('AC-1', 1, 1, 'PM')
  run.run('AC-1', 11, 2, 'Eng')
  run.run('AC-2', 24, 1, 'DevOps')
  db.close()
  return path
}

function snapshot(path) {
  const db = new Database(path, { readonly: true })
  try {
    const original = (table) =>
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name)
        .filter((name) => !NEW_COLUMNS[table].includes(name))
    const rows = (table) => JSON.stringify(db.prepare(`SELECT ${original(table).join(', ')} FROM ${table} ORDER BY rowid`).all())
    return {
      columns: Object.fromEntries(
        Object.entries(NEW_COLUMNS).map(([table, names]) => [
          table,
          db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .filter((c) => names.includes(c.name))
            .map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value })),
        ]),
      ),
      workItems: rows('work_item'),
      stepRuns: rows('step_run'),
      newValues: [
        ...db.prepare('SELECT substeps_json, substep_cursor FROM work_item').all(),
        ...db.prepare('SELECT substep_id FROM step_run').all(),
      ].flatMap(Object.values),
    }
  } catch (err) {
    if (/no such column/.test(err.message)) return { columns: null }
    throw err
  } finally {
    db.close()
  }
}

test('the three columns arrive nullable with no default; existing rows, step_index included, are byte-identical', () => {
  const path = oldSchemaDb()
  const before = snapshot(path)
  assert.equal(before.columns, null, 'the fixture really is the old schema')
  const db = new Database(path, { readonly: true })
  const beforeRows = {
    workItems: JSON.stringify(db.prepare('SELECT * FROM work_item ORDER BY rowid').all()),
    stepRuns: JSON.stringify(db.prepare('SELECT * FROM step_run ORDER BY rowid').all()),
  }
  db.close()

  boot(path)
  const after = snapshot(path)
  assert.deepEqual(after.columns, {
    work_item: [
      { name: 'substeps_json', type: 'TEXT', notnull: 0, dflt_value: null },
      { name: 'substep_cursor', type: 'INTEGER', notnull: 0, dflt_value: null },
    ],
    step_run: [{ name: 'substep_id', type: 'TEXT', notnull: 0, dflt_value: null }],
  })
  assert.equal(after.workItems, beforeRows.workItems)
  assert.equal(after.stepRuns, beforeRows.stepRuns)
  assert.ok(after.newValues.every((v) => v === null), 'existing rows read NULL — no backfill')
  const check = new Database(path, { readonly: true })
  assert.deepEqual(
    check.prepare("SELECT id, cursor FROM work_item WHERE id LIKE 'AC-%' ORDER BY id").all(),
    [
      { id: 'AC-1', cursor: 11 },
      { id: 'AC-2', cursor: 24 },
    ],
  )
  assert.deepEqual(check.prepare("SELECT step_index FROM step_run WHERE item_id LIKE 'AC-%' ORDER BY id").all().map((r) => r.step_index), [1, 11, 24])
  check.close()

  boot(path)
  assert.deepEqual(snapshot(path), after, 'a second boot is a no-op')
})
