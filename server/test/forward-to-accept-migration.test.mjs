// HZ-185: rows written before the forwarded_* columns existed still read
// correctly. The database is built here with the pre-HZ-185 work_item shape
// and two rows the old code could have left — one at Accept the code from the
// old cap path, one sent back to implement by a rejection — and only then is
// db.js loaded, so its additive migration runs over them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const dbPath = join(mkdtempSync(join(tmpdir(), 'horizon-forward-migration-')), 'test.db')
const { IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

const old = new Database(dbPath)
old.exec(`
  CREATE TABLE work_item (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, priority TEXT NOT NULL,
    desc TEXT NOT NULL DEFAULT '', metric TEXT NOT NULL DEFAULT '', guardrails TEXT NOT NULL DEFAULT '',
    issue INTEGER, cursor INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    review_cycle_count INTEGER NOT NULL DEFAULT 0, last_reviewed_sha TEXT,
    fix_pass INTEGER NOT NULL DEFAULT 0, fix_findings_json TEXT
  );
  -- A database this recent already ran the one-time cursor shifts.
  CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO setting (key, value) VALUES ('pipeline_v2_shift', 'done'), ('pipeline_v3_review_shift', 'done');
`)
old
  .prepare("INSERT INTO work_item (id, title, priority, cursor, review_cycle_count, last_reviewed_sha) VALUES ('OLD-CAP', 'Capped', 'Medium', ?, 3, 'abc')")
  .run(ACCEPT_GATE_INDEX)
old
  .prepare("INSERT INTO work_item (id, title, priority, cursor, review_cycle_count, fix_findings_json) VALUES ('OLD-REJ', 'Rejected', 'Medium', ?, 1, '[]')")
  .run(IMPLEMENT_STEP_INDEX)
old.close()

process.env.HORIZON_DB = dbPath
const { db } = await import('../src/db.js')
const store = await import('../src/store.js')

test('the migration adds the forwarded_* columns as NULL on existing rows', () => {
  const r = db.prepare("SELECT forwarded_review_run_id, forwarded_by, forwarded_sha FROM work_item WHERE id = 'OLD-CAP'").get()
  assert.deepEqual({ ...r }, { forwarded_review_run_id: null, forwarded_by: null, forwarded_sha: null })
})

test('an old row at the gate reads forwardedReview: null, and an old rejection reads reviewRejected: true', () => {
  const items = store.listItems()
  const cap = items.find((i) => i.id === 'OLD-CAP')
  const rej = items.find((i) => i.id === 'OLD-REJ')
  assert.equal(cap.forwardedReview, null)
  assert.equal(cap.reviewRejected, false)
  assert.equal(rej.reviewRejected, true)
  assert.equal(rej.forwardedReview, null)
})
