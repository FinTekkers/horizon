// HO-875 metric 2: an sl item's id is <prefix>-<n> from its prefix's own
// sequence, never the Task number. With -1 to -3 stored, the next three are
// -4, -5 and -6; a second prefix keeps its own sequence; an id whose suffix is
// not all digits (SLX-9) never feeds SL; ids order as numbers (SL-9, SL-10 →
// SL-11). A farm refusal writes no row and burns no number.
//
// Through the real POST /api/items route; farmd is the stub
// (helpers/farmTasksStub.mjs), which also refuses any other URL.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loginFixtureUser } from './helpers/session.mjs'
import { createFarmTasksStub } from './helpers/farmTasksStub.mjs'

const SECRET = 'sl-ids-farm-secret'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-sl-tracker-ids-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = SECRET
for (const key of ['FARM_HOME', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN']) delete process.env[key]

const farm = createFarmTasksStub({ secret: SECRET })
const realFetch = globalThis.fetch
globalThis.fetch = farm.fetch

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { buildApp } = await import('../src/app.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
await app.ready()
const { cookie } = loginFixtureUser(auth, config)

after(async () => {
  globalThis.fetch = realFetch
  await app.close()
})

const project = store.createProject('sl ids').id
// Each repo with a fixed prefix, so the ids read as the metric states them.
function connect(repo, prefix) {
  assert.equal(store.addRepoToProject(project, repo, 'sl').ok, true)
  db.prepare('UPDATE project_repo SET prefix = ? WHERE repo = ?').run(prefix, repo)
}
connect('acme/sl-app', 'SL')
connect('acme/other', 'OT')
connect('acme/slx', 'SLX')

const insertItem = db.prepare("INSERT INTO work_item (id, title, priority, repo, project_id, backend) VALUES (?, 'seeded', 'Medium', ?, ?, 'sl')")
for (const n of [1, 2, 3]) insertItem.run(`SL-${n}`, 'acme/sl-app', project)
insertItem.run('SLX-9', 'acme/slx', project)

const rowCount = () => db.prepare('SELECT COUNT(*) AS n FROM work_item').get().n
const create = (repo, title = 'An sl item') =>
  app.inject({ method: 'POST', url: '/api/items', headers: { cookie }, payload: { title, outcome: 'It is filed.', metric: 'One Task.', repo } })

test('a farm refusal answers 502 "Task create failed: task_driver_not_configured", writes no row and burns no number', async () => {
  const before = rowCount()
  farm.failNext('create', 503, { error: 'task_driver_not_configured' })
  const res = await create('acme/sl-app')
  assert.equal(res.statusCode, 502, res.body)
  assert.deepEqual(res.json(), { error: 'Task create failed: task_driver_not_configured' })
  assert.equal(rowCount(), before)
  assert.equal(db.prepare("SELECT next FROM tracker_sequence WHERE prefix = 'SL'").get(), undefined)
})

test('with SL-1 to SL-3 stored, the next three sl items are SL-4, SL-5 and SL-6, each with its Task in task_id', async () => {
  const ids = []
  for (const title of ['four', 'five', 'six']) {
    const res = await create('acme/sl-app', title)
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json()
    ids.push(body.id)
    const row = db.prepare('SELECT task_id, issue, title FROM work_item WHERE id = ?').get(body.id)
    assert.equal(row.title, title)
    assert.equal(row.issue, null, 'an sl item has no issue')
    assert.equal(Number(row.task_id), body.task_id)
    assert.equal(farm.tasks.get(body.task_id)?.title, title)
  }
  assert.deepEqual(ids, ['SL-4', 'SL-5', 'SL-6'])
})

test('a second prefix keeps its own sequence, and SLX-9 never feeds SL', async () => {
  const other = await create('acme/other')
  assert.equal(other.json().id, 'OT-1')
  const slx = await create('acme/slx')
  assert.equal(slx.json().id, 'SLX-10')
  const sl = await create('acme/sl-app')
  assert.equal(sl.json().id, 'SL-7')
})

test('ids order as numbers: with SL-9 and SL-10 stored, the next is SL-11', async () => {
  insertItem.run('SL-9', 'acme/sl-app', project)
  insertItem.run('SL-10', 'acme/sl-app', project)
  const res = await create('acme/sl-app')
  assert.equal(res.json().id, 'SL-11')
})

test('the sequence never reuses a number, even after the highest item is gone', async () => {
  for (const table of ['event', 'item_move']) db.prepare(`DELETE FROM ${table} WHERE item_id = 'SL-11'`).run()
  db.prepare("DELETE FROM work_item WHERE id = 'SL-11'").run()
  const res = await create('acme/sl-app')
  assert.equal(res.json().id, 'SL-12')
})

test('no request left for anything but farmd’s Task routes, each with the farm secret', () => {
  assert.deepEqual(farm.strays, [])
  assert.ok(farm.calls.length > 0)
  assert.ok(farm.calls.every((c) => c.secretOk))
})
