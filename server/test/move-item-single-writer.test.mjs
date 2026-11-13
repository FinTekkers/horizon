// HZ-710 metric 2: no module other than moveItem.js — the one move, and
// writeStepCompletion beside it — writes an item's step. A scan of every
// UPDATE of work_item in server/src for a `cursor =` in its SET list, with a
// planted positive control so the scan cannot pass by matching nothing, and
// the one dynamic SET builder an agent reaches (writeWorkItemPatch) driven
// with a `cursor` key.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-move-item-writer-')), 'test.db')
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const orchestrator = await import('../src/orchestrator.js')
const { IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

const SRC = join(REPO_ROOT, 'server/src')

// Every `UPDATE work_item SET …` up to its WHERE, across lines and string
// concatenation, whose SET list assigns `cursor` (not substep_cursor, and not
// `x = cursor`, which only reads it).
const UPDATE_WORK_ITEM = /UPDATE\s+work_item\s+SET\s+([\s\S]*?)\bWHERE\b/gi
const ASSIGNS_CURSOR = /(?<![\w.])cursor\s*=(?!=)/
function cursorWrites(text) {
  return [...text.matchAll(UPDATE_WORK_ITEM)].map((m) => m[1]).filter((set) => ASSIGNS_CURSOR.test(set))
}

// db.js's two dated pipeline-shift migrations (pipeline_v2, pipeline_v3) ran
// once, long before this item, and renumber every row at once.
// pipeline_v2_shift, pipeline_v3_review_shift and HO-837's pipeline_v4_preflight_shift.
const DATED_MIGRATIONS = ['cursor = cursor + 1 ', 'cursor = cursor + 1 ', 'cursor = cursor + 1 ']

test('the scan catches a planted write: multiline, cursor second in the SET list, no spaces around =', () => {
  const planted = [
    'db.prepare(',
    '  `UPDATE work_item',
    '     SET paused = 0,',
    '         cursor=?, updated_at = datetime(\'now\')',
    '   WHERE id = ?`,',
    ').run(3, id)',
  ].join('\n')
  assert.equal(cursorWrites(planted).length, 1)
  assert.equal(cursorWrites("db.prepare('UPDATE work_item SET ' + 'title = ?, cursor = ? WHERE id = ?')").length, 1)
  // Not writes: the sub-step column, a read of cursor, and a WHERE on it.
  assert.equal(cursorWrites('UPDATE work_item SET substep_cursor = NULL WHERE id = ?').length, 0)
  assert.equal(cursorWrites('UPDATE work_item SET notified_step = cursor WHERE cursor IN (1)').length, 0)
  assert.equal(cursorWrites('UPDATE work_item SET paused = 1 WHERE cursor = ?').length, 0)
})

test('metric 2: only moveItem.js writes an item’s step (plus the three dated migrations)', () => {
  const writers = {}
  for (const file of readdirSync(SRC, { recursive: true }).filter((f) => /\.m?js$/.test(f))) {
    const writes = cursorWrites(readFileSync(join(SRC, file), 'utf8'))
    if (writes.length > 0) writers[file] = writes
  }
  assert.deepEqual(Object.keys(writers).sort(), ['db.js'], 'moveItem.js builds its SET list, so the scan finds only db.js')
  assert.deepEqual(writers['db.js'], DATED_MIGRATIONS)
  // moveItem.js is where the write lives, as `cursor = ?` in a built list.
  assert.match(readFileSync(join(SRC, 'moveItem.js'), 'utf8'), /const sets = \['cursor = \?'\]/)
})

test('metric 2: step completion and the move are reached only from where they belong', () => {
  const importers = (name) =>
    readdirSync(SRC, { recursive: true })
      .filter((f) => /\.m?js$/.test(f) && f !== 'moveItem.js')
      .filter((f) => new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\./moveItem\\.js'`).test(readFileSync(join(SRC, f), 'utf8')))
      .sort()
  assert.deepEqual(importers('writeStepCompletion'), ['orchestrator.js'])
  assert.deepEqual(importers('moveItem'), ['orchestrator.js', 'store.js'])
})

test('metric 2: an agent patch carrying cursor or substep_cursor never moves the item', () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('W-PATCH', 'patched', 'Medium', ?)").run(IMPLEMENT_STEP_INDEX)
  const item = { id: 'W-PATCH', personas: {} }
  orchestrator.writeWorkItemPatch('W-PATCH', item, { cursor: 0, substep_cursor: 'x', desc: 'new outcome' })
  const row = db.prepare("SELECT cursor, substep_cursor, desc FROM work_item WHERE id = 'W-PATCH'").get()
  assert.deepEqual(row, { cursor: IMPLEMENT_STEP_INDEX, substep_cursor: null, desc: 'new outcome' })
  // A patch of only step columns writes nothing at all.
  orchestrator.writeWorkItemPatch('W-PATCH', item, { cursor: 1 })
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'W-PATCH'").get().cursor, IMPLEMENT_STEP_INDEX)
})
