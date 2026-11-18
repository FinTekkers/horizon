// HO-880 R1: the owner's whole import, over HTTP only — no store call after
// the fixture is seeded. Import, see the copies and the frozen sources on the
// board, get 409 on an edit, disconnect the source repo and still see the
// source items, then re-run and get nothing new.
//
// Metric 2 (rejected edit, listed after disconnect), 3 (re-run creates
// nothing), 4 (one project_event per run) and 5 (2 records for 2 open + 1
// closed). The Tracker port is the real sl adapter, farmd stubbed.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFarmTasksStub } from './helpers/farmTasksStub.mjs'
import { FARM_SECRET, SOURCE_REPO, TARGET_REPO, countWhere, postImport, seedImport } from './helpers/importFixture.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-import-journey-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = FARM_SECRET
for (const key of ['FARM_HOME', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'HORIZON_TEST_HOOKS']) delete process.env[key]

const stub = createFarmTasksStub({ secret: FARM_SECRET })
globalThis.fetch = stub.fetch

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const lifecycle = await import('../../domain/js/lifecycle.js')
const { buildApp } = await import('../src/app.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())

const { owner, source, target, ids } = seedImport({ db, store, auth, config, lifecycle, tag: 'journey' })
const sourceIds = [...ids.open, ids.closed]
const headers = { cookie: owner.cookie, 'x-human-key': owner.pin }
const board = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: owner.cookie } })
  assert.equal(res.statusCode, 200, res.body)
  return res.json().items
}
const projectEvents = () => countWhere(db, 'project_event', "project_id = ? AND kind = 'import'", target)

test('R1: import → copies listed → edit refused → source repo disconnected, sources still listed → re-run creates nothing', async () => {
  // 1. The owner, PIN-verified, imports.
  const first = await postImport(app, owner, { sourceProjectId: source, targetProjectId: target })
  assert.equal(first.statusCode, 200, first.body)
  assert.deepEqual([first.json().open, first.json().closed], [2, 1])
  assert.equal(stub.callsTo('create').length, 2)

  // 2. The board lists three linked copies, and the sources as imported.
  const items = await board()
  const copies = items.filter((item) => item.project_id === target)
  assert.equal(copies.length, 3)
  assert.deepEqual(copies.map((c) => c.sourceItemId).sort(), [...sourceIds].sort())
  for (const id of sourceIds) assert.equal(items.find((item) => item.id === id)?.imported, true, id)

  // 3. An edit to a source item is refused.
  const edit = await app.inject({ method: 'POST', url: `/api/items/${ids.open[0]}/priority`, headers, payload: { priority: 'Low' } })
  assert.equal(edit.statusCode, 409, edit.body)
  assert.deepEqual(edit.json(), { error: 'item_imported' })

  // 4. Disconnecting the source repo keeps its items' history listed.
  const disconnect = await app.inject({ method: 'POST', url: `/api/projects/${source}/repos/disconnect`, headers, payload: { repo: SOURCE_REPO } })
  assert.equal(disconnect.statusCode, 200, disconnect.body)
  const afterDisconnect = await board()
  for (const id of sourceIds) assert.ok(afterDisconnect.some((item) => item.id === id), `${id} is still listed`)

  // 5. A re-run creates no item and no record, and writes one more event.
  const again = await postImport(app, owner, { sourceProjectId: source, targetProjectId: target })
  assert.equal(again.statusCode, 200, again.body)
  assert.deepEqual([again.json().open, again.json().closed, again.json().skipped], [0, 0, 3])
  assert.equal(stub.callsTo('create').length, 2)
  assert.equal((await board()).filter((item) => item.project_id === target).length, 3)
  assert.equal(projectEvents(), 2)
  assert.equal([...stub.tasks.values()].filter((task) => task.repo === TARGET_REPO).length, 2)
})
