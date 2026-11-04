// HZ-709 guardrail 1: the step_key columns are additive. A database from
// before them (built here by dropping the columns from a fresh one) is opened
// by the real db.js twice in real node processes: no error either time, the
// three columns exist, the old rows read NULL, and the item record —
// work_item.cursor, step_run, gate_decision — is byte-identical.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const DB_FILE = join(mkdtempSync(join(tmpdir(), 'horizon-step-key-migration-')), 'test.db')
const TABLES = ['gate_poll', 'gate_notice', 'feedback']

function openWithDbJs() {
  const env = { ...process.env, HORIZON_DB: DB_FILE }
  for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete env[key]
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(join(REPO_ROOT, 'server/src/db.js'))})`], {
    env,
    stdio: 'pipe',
  })
}
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
const record = (db) =>
  JSON.stringify({
    items: db.prepare("SELECT id, cursor FROM work_item WHERE id = 'MIG-1'").all(),
    runs: db.prepare("SELECT * FROM step_run WHERE item_id = 'MIG-1' ORDER BY id").all(),
    decisions: db.prepare("SELECT * FROM gate_decision WHERE item_id = 'MIG-1' ORDER BY id").all(),
  })

test('the step_key columns are added to a pre-key database, idempotently, and touch nothing in the record', () => {
  openWithDbJs()
  let db = new Database(DB_FILE)
  for (const table of TABLES) {
    assert.ok(columns(db, table).includes('step_key'), `positive control: a fresh ${table} has no step_key`)
    db.exec(`ALTER TABLE ${table} DROP COLUMN step_key`)
  }
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('MIG-1', 'migration', 'Medium', 13)").run()
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES ('MIG-1', 11, 1, 'Eng', 'done')").run()
  db.prepare("INSERT INTO gate_decision (item_id, step_index, decision, notes, decided_by) VALUES ('MIG-1', 10, 'approved', '', 'You')").run()
  db.prepare("INSERT INTO gate_poll (item_id, step_index, recipient, question) VALUES ('MIG-1', 13, 'x@s.whatsapp.net', 'MIG-1 — q')").run()
  db.prepare("INSERT INTO gate_notice (item_id, step_index, recipient, body) VALUES ('MIG-1', 13, 'x@s.whatsapp.net', 'b')").run()
  db.prepare("INSERT INTO feedback (item_id, target, message) VALUES ('MIG-1', 'Eng', 'm')").run()
  const before = record(db)
  db.close()

  openWithDbJs()
  openWithDbJs()

  db = new Database(DB_FILE, { readonly: true })
  for (const table of TABLES) {
    assert.ok(columns(db, table).includes('step_key'), `${table} has no step_key`)
    assert.deepEqual(
      db.prepare(`SELECT step_key FROM ${table} WHERE item_id = 'MIG-1'`).all(),
      [{ step_key: null }],
      `${table}'s old row was backfilled`,
    )
  }
  for (const table of ['work_item', 'step_run', 'gate_decision']) {
    assert.ok(!columns(db, table).includes('step_key'), `${table} — the record — gained a step_key column`)
  }
  assert.equal(record(db), before, 'the item record changed')
  db.close()
})
