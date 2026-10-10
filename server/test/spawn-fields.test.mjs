// HZ-379 metric line 3: GET /api/items carries both ends of a spawn. The
// parent's `spawned` lists every item it filed, open or closed, and its
// existing `blockedBy` names each open one; each child's `spawnedBy` names
// the parent. Items nothing spawned read `spawned: []` and `spawnedBy: null`.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-spawn-fields-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
delete process.env.FARM_STEP_INDEXES
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'running' }) })

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const spawn = await import('../src/spawn.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { kindStepIndex, endIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
await orchestrator.init({ info: () => {}, warn: () => {} })
await new Promise((r) => setTimeout(r, 50))
const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)

after(() => {
  for (const { item_id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(item_id)
})

const RUN_PLAN = kindStepIndex('Run plan', 'task')

test('the parent lists every spawned item and the child links back to it', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind) VALUES ('T-API', 'Backfill orders', 'Medium', ?, 'task')").run(RUN_PLAN)
  const filed = await spawn.spawnItems(
    store.getItem('T-API'),
    [
      { title: 'Open part', outcome: 'Build it.', metric: '1. Works.' },
      { title: 'Closed part', outcome: 'Build that.', metric: '1. Works too.' },
    ],
    { requestKey: 'plan:api', kind: 'change' },
  )
  const [open, closed] = filed.children
  for (const c of filed.children) orchestrator.cancel(c)
  assert.equal(spawn.linkSpawned('T-API', 'plan:api').ok, true)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(endIndex('change'), closed)

  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  const byId = Object.fromEntries(res.json().items.map((it) => [it.id, it]))

  const parent = byId['T-API']
  assert.deepEqual(parent.spawned, [
    { id: open, title: 'Open part', closed: false, abandoned: false },
    { id: closed, title: 'Closed part', closed: true, abandoned: false },
  ])
  assert.equal(parent.spawnedBy, null)
  assert.deepEqual(
    parent.blockedBy.map((b) => b.id),
    [open],
    'the existing dependency box names the open spawned item',
  )
  for (const id of [open, closed]) {
    assert.deepEqual(byId[id].spawnedBy, { id: 'T-API', title: 'Backfill orders' })
    assert.deepEqual(byId[id].spawned, [])
  }
})
