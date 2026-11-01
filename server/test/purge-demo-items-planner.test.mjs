// HZ-651: purgeDemoItems() finds the rows to delete with HZ-641's foreign-key
// planner (accountPurge.planDeletes), not a hand list of child tables. The
// tables to check are read from PRAGMA foreign_key_list here, independently of
// the planner, so a table added later is covered with no edit to this file.
//
// The tests share one database and run in order: the connect-repo case needs
// the demo seed db.js writes on a fresh database, and the cases that alter the
// schema (a new table, a new work_item column) come last.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { schemaSeed } from './helpers/schemaSeed.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-purge-demo-')), 'test.db')
delete process.env.HORIZON_REPO
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')

after(() => rmSync(dirname(process.env.HORIZON_DB), { recursive: true, force: true }))

const s = schemaSeed(db)
const PARENTS = ['project', 'user', 'project_repo']
const itemExists = (id) => Boolean(db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(id))
const rowExists = (table, rowid) => Boolean(db.prepare(`SELECT 1 FROM ${s.quote(table)} WHERE rowid = ?`).get(rowid))

let project = null
// A work item `id` with one row in every table that references work_item.
// `parents` reuses another tree's parent rows, so no new ones are created.
function seedItemTree(id, parents = {}) {
  return s.withChecksOff(() => {
    project ??= s.seedRow('project', { name: 'HZ-651 project' })
    const item = s.seedRow('work_item', { id, title: `item ${id}`, project_id: project.id })
    return s.seedTree('work_item', { project, ...parents, work_item: item })
  })
}
// The rows of `context` that are not under work_item: the parents it seeded.
const parentsOf = (context) =>
  Object.fromEntries(Object.entries(context).filter(([table]) => table !== 'work_item' && !s.referencing('work_item').includes(table)))

test('connecting a repo removes the demo items, even with rows the old hand list missed', () => {
  const demo = db.prepare("SELECT id FROM work_item WHERE id LIKE 'BF-%' ORDER BY id").all().map((r) => r.id)
  assert.ok(demo.length >= 2, 'the fresh database holds the demo seed')
  // work_item_dependency declares no ON DELETE action and was not in the list,
  // so this row made the old purge fail with an FK error.
  db.prepare('INSERT INTO work_item_dependency (item_id, depends_on_id) VALUES (?, ?)').run(demo[0], demo[1])
  const projectId = db.prepare('INSERT INTO project (name) VALUES (?)').run('HZ-651 connect').lastInsertRowid

  const result = store.addRepoToProject(projectId, 'Org/hz651')

  assert.equal(result.ok, true)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_item WHERE id LIKE 'BF-%'").get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_item_dependency').get().n, 0)
  assert.ok(db.prepare('SELECT 1 FROM project_repo WHERE project_id = ? AND repo = ?').get(projectId, 'Org/hz651'))
})

test('every table that references work_item, directly or indirectly, is emptied of the BF-* rows; parents survive', () => {
  const tables = s.referencing('work_item')
  // The no-action, SET NULL and indirect tables the old list did not name.
  for (const t of ['work_item_dependency', 'item_split', 'caretaker_eval', 'caretaker_action', 'plan_draft']) {
    assert.ok(tables.includes(t), `${t} reaches work_item`)
  }
  const setNull = s.foreignKeys().filter((fk) => fk.parent === 'work_item' && fk.onDelete === 'SET NULL')
  assert.ok(setNull.length > 0, 'some table references work_item ON DELETE SET NULL')

  const before = s.snapshot()
  const context = seedItemTree('BF-901')
  for (const t of tables) assert.ok(s.count(t) > JSON.parse(before[t]).length, `${t} got a BF-901 row`)
  for (const fk of setNull) assert.equal(context[fk.table][fk.from], 'BF-901', `${fk.table}.${fk.from} points at BF-901`)
  const parents = parentsOf(context)
  assert.ok(Object.hasOwn(parents, 'project'))
  const parentCounts = Object.fromEntries(PARENTS.map((t) => [t, s.count(t)]))

  store.purgeDemoItems()

  const after = s.snapshot()
  // Rows are deleted, not left behind with a nulled item_id.
  for (const t of tables) assert.equal(after[t], before[t], `${t} is back to its rows before seeding`)
  assert.equal(itemExists('BF-901'), false)
  for (const t of PARENTS) assert.equal(s.count(t), parentCounts[t], `${t} count unchanged`)
  for (const [t, row] of Object.entries(parents)) assert.ok(rowExists(t, row._rowid), `parent ${t} row survives`)
})

test('a non-BF item keeps every row; only the link row pointing at a BF-* item goes', () => {
  const kept = seedItemTree('HZ-9901')
  const keptRows = s.snapshot()
  seedItemTree('BF-904', parentsOf(kept))
  const link = db.prepare('INSERT INTO work_item_dependency (item_id, depends_on_id) VALUES (?, ?)').run('HZ-9901', 'BF-904').lastInsertRowid

  store.purgeDemoItems()

  assert.ok(itemExists('HZ-9901'))
  assert.equal(rowExists('work_item_dependency', link), false, 'the HZ-9901 -> BF-904 link is gone')
  assert.deepEqual(s.snapshot(), keptRows, 'every HZ-9901 row and every other row is as it was')
})

test('a failing delete rolls the whole purge back', () => {
  seedItemTree('BF-905')
  const before = s.snapshot()
  db.exec("CREATE TEMP TRIGGER hz651_fail BEFORE DELETE ON step_run BEGIN SELECT RAISE(ABORT, 'forced'); END")
  try {
    assert.throws(() => store.purgeDemoItems(), /forced/)
    assert.deepEqual(s.snapshot(), before, 'every table is unchanged')
  } finally {
    db.exec('DROP TRIGGER IF EXISTS hz651_fail')
  }
  store.purgeDemoItems()
  assert.equal(itemExists('BF-905'), false)
})

test('a table added after the first purge is cleared with no edit to purgeDemoItems', () => {
  // A purge first, so a cached reference list would be stale.
  s.withChecksOff(() => s.seedRow('work_item', { id: 'BF-906', title: 'warm', project_id: project.id }))
  store.purgeDemoItems()

  db.exec('CREATE TABLE hz651_extra (id INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES work_item(id))')
  try {
    s.withChecksOff(() => s.seedRow('work_item', { id: 'BF-902', title: 'new table', project_id: project.id }))
    db.prepare('INSERT INTO hz651_extra (item_id) VALUES (?)').run('BF-902')
    db.prepare('INSERT INTO hz651_extra (item_id) VALUES (?)').run('HZ-9901')

    store.purgeDemoItems()

    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM hz651_extra WHERE item_id = 'BF-902'").get().n, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM hz651_extra WHERE item_id = 'HZ-9901'").get().n, 1)
    assert.equal(itemExists('BF-902'), false)
  } finally {
    db.exec('DROP TABLE IF EXISTS hz651_extra')
  }
})

// Last: SQLite cannot drop a column that carries a foreign key, so the extra
// work_item column stays for the rest of this (throwaway) database.
test('the purge refuses, and deletes nothing, when the walk reaches a non-BF item', () => {
  // A self-reference: no table-level cycle, so the walk runs and reaches
  // HZ-9903 through BF-903.
  db.exec('ALTER TABLE work_item ADD COLUMN hz651_parent TEXT REFERENCES work_item(id)')
  s.withChecksOff(() => {
    s.seedRow('work_item', { id: 'BF-903', title: 'demo parent', project_id: project.id })
    s.seedRow('work_item', { id: 'HZ-9903', title: 'real child', project_id: project.id, hz651_parent: 'BF-903' })
  })
  const before = s.snapshot()

  assert.throws(() => store.purgeDemoItems(), /demo purge: the walk reached a work item that is not BF-\*/)

  assert.deepEqual(s.snapshot(), before, 'every table is unchanged')
  assert.ok(itemExists('BF-903'))
  assert.ok(itemExists('HZ-9903'))
})
