// HZ-467: the one-time merged_at backfill. An open item past Accept the code
// (Deploy or the final gate) with a PR has already merged, so its dependents'
// implement may start. Run on a legacy-shaped work_item table, because the
// live table's kind CHECK no longer allows a NULL or blank kind.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-merged-at-')), 'test.db')

const { db, backfillMergedAt } = await import('../src/db.js')
const { ACCEPT_GATE_INDEX, DEPLOY_STEP_INDEX, IMPLEMENT_ITEM_KIND, IMPLEMENT_STEP_INDEX, EXECUTE_STEP_INDEX, STEPS } =
  await import('../../domain/js/lifecycle.js')

test('the live table has a merged_at column', () => {
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('work_item') WHERE name = 'merged_at'").get())
})

test('the backfill marks change items with a PR at Deploy, including a NULL or blank kind, and nothing else', () => {
  const legacy = new Database(':memory:')
  legacy.exec(`CREATE TABLE work_item (id TEXT PRIMARY KEY, cursor INTEGER NOT NULL, kind TEXT, pr INTEGER,
    abandoned_at TEXT, merged_at TEXT)`)
  const insert = legacy.prepare('INSERT INTO work_item (id, cursor, kind, pr, abandoned_at) VALUES (?, ?, ?, ?, ?)')
  const taskKind = STEPS[EXECUTE_STEP_INDEX].itemKind
  assert.ok(DEPLOY_STEP_INDEX > ACCEPT_GATE_INDEX)
  insert.run('NULL-KIND', DEPLOY_STEP_INDEX, null, 1, null)
  insert.run('BLANK-KIND', DEPLOY_STEP_INDEX, '', 2, null)
  insert.run('STORED-KIND', DEPLOY_STEP_INDEX, IMPLEMENT_ITEM_KIND, 3, null)
  insert.run('TASK', DEPLOY_STEP_INDEX, taskKind, 4, null)
  insert.run('AT-IMPLEMENT', IMPLEMENT_STEP_INDEX, null, 5, null)
  insert.run('AT-ACCEPT', ACCEPT_GATE_INDEX, null, 6, null)
  insert.run('NO-PR', DEPLOY_STEP_INDEX, null, null, null)
  insert.run('ABANDONED', DEPLOY_STEP_INDEX, null, 7, '2026-10-01 00:00:00')

  assert.equal(backfillMergedAt(legacy), 3)
  const merged = legacy.prepare('SELECT id FROM work_item WHERE merged_at IS NOT NULL ORDER BY id').all().map((r) => r.id)
  assert.deepEqual(merged, ['BLANK-KIND', 'NULL-KIND', 'STORED-KIND'])
  assert.equal(backfillMergedAt(legacy), 0, 'a second run changes nothing')
  legacy.close()
})
