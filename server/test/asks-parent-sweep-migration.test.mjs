// HZ-820: the one-time sweep of soft asks left open on items that were
// already closed or abandoned before the close hook existed (db.js
// sweepParentClosedSoftAsks, run once at boot under the
// `soft_ask_parent_sweep` setting). Abandoned wins over closed; only open
// soft asks change, and a second run changes nothing.
//
// The boot cases run db.js in a child process against their own database
// file, so the real module-load path — and its setting guard — is what runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-asks-parent-sweep-')), 'test.db')

const { db, sweepParentClosedSoftAsks, PARENT_CLOSED_REASON, PARENT_ABANDONED_REASON } = await import('../src/db.js')
const { endIndex, requiredStepIndex } = await import('../../domain/js/lifecycle.js')

const ARCH = requiredStepIndex('Architecture review')
const DB_JS = fileURLToPath(new URL('../src/db.js', import.meta.url))

let seq = 0
// One item, closed / abandoned / both / open, and one ask on it.
function seed(database, { closed = false, abandoned = false, kind = 'soft', status = 'open', resolvedBy = null, reason = null } = {}) {
  const id = `SW-${++seq}`
  database
    .prepare('INSERT INTO work_item (id, title, priority, cursor, kind, abandoned_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `sweep ${seq}`, 'Medium', closed ? endIndex('change') : ARCH, 'change', abandoned ? '2026-10-01 00:00:00' : null)
  const runId = database
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'Architect', 'done')")
    .run(id, ARCH).lastInsertRowid
  const askId = Number(
    database
      .prepare(
        `INSERT INTO ask (item_id, step_run_id, step_index, kind, status, draft_json, why, dismiss_reason, resolved_by, updated_at)
         VALUES (?, ?, ?, ?, ?, '{"title":"t"}', 'why', ?, ?, '2026-10-01 00:00:00')`,
      )
      .run(id, runId, ARCH, kind, status, reason, resolvedBy).lastInsertRowid,
  )
  return askId
}

const rowsOf = (database, ids) => ids.map((id) => database.prepare('SELECT * FROM ask WHERE id = ?').get(id))

test('metric 4: today’s 34 open soft asks — the 28 on closed and 3 on abandoned items close with the matching reason, the 3 on open items stay; a second run changes nothing', () => {
  const closed = Array.from({ length: 28 }, () => seed(db, { closed: true }))
  const abandoned = Array.from({ length: 3 }, () => seed(db, { abandoned: true }))
  const open = Array.from({ length: 3 }, () => seed(db))

  assert.deepEqual(sweepParentClosedSoftAsks(db), { closed: 28, abandoned: 3 })
  for (const row of rowsOf(db, closed)) {
    assert.deepEqual([row.status, row.dismiss_reason, row.resolved_by], ['dismissed', PARENT_CLOSED_REASON, 'Horizon'])
    assert.ok(row.resolved_at)
  }
  for (const row of rowsOf(db, abandoned)) assert.deepEqual([row.status, row.dismiss_reason, row.resolved_by], ['dismissed', PARENT_ABANDONED_REASON, 'Horizon'])
  for (const row of rowsOf(db, open)) assert.deepEqual([row.status, row.dismiss_reason, row.resolved_by], ['open', null, null])

  const before = rowsOf(db, [...closed, ...abandoned, ...open])
  assert.deepEqual(sweepParentClosedSoftAsks(db), { closed: 0, abandoned: 0 })
  assert.deepEqual(rowsOf(db, [...closed, ...abandoned, ...open]), before, 'the second run writes nothing, updated_at included')
})

// Runs db.js's module load — the boot — against `file`.
function boot(file) {
  const env = { ...process.env, HORIZON_DB: file }
  delete env.FARM_HOME
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(DB_JS)})`], { env, stdio: 'pipe' })
}

test('boot: the sweep runs once under its setting; abandoned wins over closed, and only open soft asks change', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'horizon-asks-parent-sweep-boot-')), 'boot.db')
  boot(file)
  // A database from before HZ-820: the schema is there, the sweep has not run.
  let raw = new Database(file)
  assert.ok(raw.prepare("SELECT value FROM setting WHERE key = 'soft_ask_parent_sweep'").get(), 'a fresh boot records the sweep')
  raw.prepare("DELETE FROM setting WHERE key = 'soft_ask_parent_sweep'").run()
  const ids = {
    closed: seed(raw, { closed: true }),
    both: seed(raw, { closed: true, abandoned: true }),
    preDismissed: seed(raw, { closed: true, status: 'dismissed', resolvedBy: 'Owner Example', reason: 'Not needed now' }),
    filed: seed(raw, { closed: true, status: 'filed', resolvedBy: 'Owner Example' }),
    blocking: seed(raw, { closed: true, kind: 'blocking' }),
    split: seed(raw, { abandoned: true, kind: 'split' }),
    open: seed(raw),
  }
  const before = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, rowsOf(raw, [id])[0]]))
  raw.close()

  boot(file)
  raw = new Database(file)
  const row = (key) => rowsOf(raw, [ids[key]])[0]
  assert.deepEqual([row('closed').status, row('closed').dismiss_reason, row('closed').resolved_by], ['dismissed', PARENT_CLOSED_REASON, 'Horizon'])
  assert.deepEqual([row('both').status, row('both').dismiss_reason], ['dismissed', PARENT_ABANDONED_REASON])
  for (const key of ['preDismissed', 'filed', 'blocking', 'split', 'open']) assert.deepEqual(row(key), before[key], `${key} untouched`)
  assert.equal(raw.prepare("SELECT value FROM setting WHERE key = 'soft_ask_parent_sweep'").get()?.value, 'done')

  // The guard holds: a later boot sweeps nothing (the close hook owns new ones).
  const late = seed(raw, { closed: true })
  raw.close()
  boot(file)
  raw = new Database(file)
  assert.equal(rowsOf(raw, [late])[0].status, 'open')
  raw.close()
})
