// HO-872 metric 4: store.markLanded records an item's landed commit once. A
// second call, with a different hash, changes neither landed_hash nor
// landed_at. landed_at is backdated between the calls so a same-second second
// write could not hide behind datetime('now')'s one-second resolution.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-mark-landed-')), 'test.db')
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')

store.purgeDemoItems()

const AAA = 'a'.repeat(40)
const BBB = 'b'.repeat(40)
const landed = (id) => db.prepare('SELECT landed_hash, landed_at FROM work_item WHERE id = ?').get(id)

function item(id) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES (?, 'Landed', 'Medium', 13)").run(id)
  return id
}

test('metric 4: a second markLanded with another hash keeps the first landed_hash and landed_at', () => {
  const id = item('ML-1')
  assert.deepEqual(landed(id), { landed_hash: null, landed_at: null })
  assert.equal(store.markLanded(id, AAA), true)
  const first = landed(id)
  assert.equal(first.landed_hash, AAA)
  assert.match(first.landed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

  db.prepare("UPDATE work_item SET landed_at = '2020-01-01 00:00:00' WHERE id = ?").run(id)
  assert.equal(store.markLanded(id, BBB), false)
  assert.deepEqual(landed(id), { landed_hash: AAA, landed_at: '2020-01-01 00:00:00' })
})

test('markLanded returns false for an unknown id and throws on an empty hash', () => {
  assert.equal(store.markLanded('ML-NOPE', AAA), false)
  const id = item('ML-2')
  for (const bad of ['', '   ', null, undefined, 42]) assert.throws(() => store.markLanded(id, bad), /non-empty string/)
  assert.deepEqual(landed(id), { landed_hash: null, landed_at: null })
})
