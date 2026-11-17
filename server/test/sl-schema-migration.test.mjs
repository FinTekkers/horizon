// HO-875 guardrail 2: the schema change is additive. A database from before
// HO-875 (no tracker_sequence table, no feedback.task_comment_id) boots twice:
// every item keeps its id and issue, the row counts do not move, task_id stays
// NULL, the new table starts empty and the new column is NULL on old rows.
// The second boot changes nothing and does not fail.

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
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(DB_MODULE)})`], { env, timeout: 60_000 })
}

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
const hasColumn = (db, table, name) => !!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(name)

// The database as the previous release left it, with GitHub items and feedback.
function previousReleaseDb() {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-sl-schema-migration-')), 'test.db')
  boot(path)
  const db = new Database(path)
  db.exec('DROP INDEX idx_feedback_task_comment')
  db.exec('ALTER TABLE feedback DROP COLUMN task_comment_id')
  db.exec('DROP TABLE tracker_sequence')
  const projectId = db.prepare("INSERT INTO project (name) VALUES ('Before HO-875')").run().lastInsertRowid
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/one', 'ON')").run(projectId)
  const item = db.prepare("INSERT INTO work_item (id, title, priority, repo, issue, project_id) VALUES (?, ?, 'Medium', 'acme/one', ?, ?)")
  item.run('ON-1', 'One', 1, projectId)
  item.run('ON-7', 'Seven', 7, projectId)
  item.run('ON-12', 'Twelve', 12, projectId)
  db.prepare("INSERT INTO feedback (item_id, message, source, gh_comment_id) VALUES ('ON-7', 'from GitHub', 'github', 555)").run()
  db.close()
  return path
}

function snapshot(path) {
  const db = new Database(path, { readonly: true })
  try {
    return {
      items: db.prepare('SELECT id, issue, task_id, backend FROM work_item ORDER BY id').all(),
      feedback: db.prepare('SELECT id, item_id, message, gh_comment_id, task_comment_id FROM feedback ORDER BY id').all(),
      sequences: db.prepare('SELECT * FROM tracker_sequence').all(),
      counts: Object.fromEntries(['work_item', 'feedback', 'project_repo'].map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])),
    }
  } finally {
    db.close()
  }
}

test('guardrail 2: a pre-HO-875 database boots twice; ids, issues and row counts are unchanged and task_id stays NULL', () => {
  const path = previousReleaseDb()
  const before = new Database(path, { readonly: true })
  assert.ok(!hasTable(before, 'tracker_sequence'))
  assert.ok(!hasColumn(before, 'feedback', 'task_comment_id'))
  const items = before.prepare('SELECT id, issue FROM work_item ORDER BY id').all()
  const counts = Object.fromEntries(['work_item', 'feedback', 'project_repo'].map((t) => [t, before.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]))
  before.close()
  assert.ok(items.some((row) => row.id === 'ON-12' && row.issue === 12))

  boot(path)
  const first = snapshot(path)
  assert.deepEqual(
    first.items,
    items.map((row) => ({ ...row, task_id: null, backend: 'github' })),
  )
  assert.deepEqual(first.feedback, [{ id: 1, item_id: 'ON-7', message: 'from GitHub', gh_comment_id: 555, task_comment_id: null }])
  assert.deepEqual(first.sequences, [], 'tracker_sequence starts empty: no prefix is seeded')
  assert.deepEqual(first.counts, counts)

  boot(path)
  assert.deepEqual(snapshot(path), first, 'the second boot changes nothing')
})
