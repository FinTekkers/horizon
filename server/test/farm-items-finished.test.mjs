// HZ-604: farmd's hourly clean-up asks POST /api/farm/items/finished which of
// the item ids it holds worktrees for are closed or abandoned, and reaps only
// those. Open and unknown ids must be left out — farmd never reaps an id the
// server does not list — and its lowercased worktree dirs must still match.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-farm-items-finished-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire here
process.env.FARM_STEP_TIMEOUT_MS = '600000'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { FARM_SHARED_SECRET } = await import('../src/config.js')
const store = await import('../src/store.js')
const { IMPLEMENT_STEP_INDEX, endIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const app = buildApp({ logger: false })

function insertItem(id, cursor, { abandoned = false } = {}) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, abandoned_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    `Item ${id}`,
    'Medium',
    cursor,
    abandoned ? '2026-10-27 10:00:00' : null,
  )
}

insertItem('FIN-1', endIndex('change'))
insertItem('FIN-2', IMPLEMENT_STEP_INDEX, { abandoned: true })
insertItem('FIN-3', IMPLEMENT_STEP_INDEX)
insertItem('FIN-4', endIndex('change'), { abandoned: true })

function finished(payload, headers = { 'x-farm-secret': FARM_SHARED_SECRET }) {
  return app.inject({ method: 'POST', url: '/api/farm/items/finished', headers, payload })
}

test('lists only closed and abandoned ids, matching case-insensitively; abandoned wins over closed', async () => {
  const res = await finished({ ids: ['fin-1', 'fin-2', 'fin-3', 'fin-4', 'fin-99'] })

  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), {
    items: [
      { id: 'FIN-1', state: 'closed' },
      { id: 'FIN-2', state: 'abandoned' },
      { id: 'FIN-4', state: 'abandoned' },
    ],
  })
})

test('an open or unknown id alone yields an empty list', async () => {
  const res = await finished({ ids: ['FIN-3', 'nope-1'] })

  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { items: [] })
})

test('without the farm secret the route answers 401', async () => {
  const res = await finished({ ids: ['fin-1'] }, {})

  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'bad farm secret' })
})

test('a bad id, a missing ids list or an empty one is a 400', async () => {
  for (const payload of [{ ids: ['../etc'] }, { ids: ['-x'] }, {}, { ids: [] }]) {
    const res = await finished(payload)
    assert.equal(res.statusCode, 400, JSON.stringify(payload))
  }
})
