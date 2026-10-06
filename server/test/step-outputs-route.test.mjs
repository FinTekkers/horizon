// HZ-318: the slim board leaves stepOutputs off; GET /api/items/:id/step-outputs
// serves one item's on demand. Same login gate and same items as /api/items,
// and the same data the full snapshot carried — nothing more.
//
// Its own file because config.js reads the environment at import time.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-step-outputs-')), 'test.db')
process.env.FARM_SHARED_SECRET = 'farm-shared-secret-for-tests'
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
await app.ready()
after(() => app.close())

const get = (url, headers = { cookie }) => app.inject({ method: 'GET', url, headers })

const ON = store.createProject('On').id
const OFF = store.createProject('Off').id
store.setProjectEnabled(ON, true)
store.setProjectEnabled(OFF, false)

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, ?, ?, ?, ?)')
const insertRun = db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, ?, 'PM', 'done', ?, ?, datetime('now'))",
)
insertItem.run('SO-OPEN', 'open', 'Medium', 3, ON)
insertItem.run('SO-CLOSED', 'closed', 'Medium', STEPS.length, ON)
insertItem.run('SO-HIDDEN', 'disabled project', 'Medium', 3, OFF)
insertRun.run('SO-OPEN', 1, 1, 'first output', '# first')
insertRun.run('SO-CLOSED', 1, 1, 'old output', '# v1')
insertRun.run('SO-CLOSED', 1, 2, 'newer output', '# v2')
insertRun.run('SO-CLOSED', 2, 1, 'summary only', null)
insertRun.run('SO-HIDDEN', 1, 1, 'must not leak', '# secret')

test('/api/items?v=2 carries no stepOutputs; unversioned /api/items still does', async () => {
  const slim = (await get('/api/items?v=2')).json()
  assert.ok(slim.items.length > 0)
  for (const item of slim.items) assert.ok(!('stepOutputs' in item), `${item.id} carries stepOutputs`)
  const full = (await get('/api/items')).json()
  assert.equal(full.items.find((it) => it.id === 'SO-OPEN').stepOutputs[1].output, 'first output')
})

test('slim and full boards hold the same items, closed ones included, and differ only by stepOutputs', async () => {
  const slim = (await get('/api/items?v=2')).json()
  const full = (await get('/api/items')).json()
  assert.deepEqual(
    slim.items.map((it) => it.id),
    full.items.map((it) => it.id),
  )
  assert.ok(slim.items.some((it) => it.id === 'SO-CLOSED'))
  full.items.forEach((item, i) => {
    const { stepOutputs, ...rest } = item
    assert.ok(stepOutputs, `${item.id} lost stepOutputs on the full board`)
    assert.deepEqual(slim.items[i], rest)
  })
  const { items: slimItems, ...slimTop } = slim
  const { items: fullItems, ...fullTop } = full
  assert.deepEqual(slimTop, fullTop)
})

test("the route returns a visible item's outputs", async () => {
  const res = await get('/api/items/SO-OPEN/step-outputs')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    id: 'SO-OPEN',
    stepOutputs: { 1: { output: 'first output', attempt: 1, artifact: '# first', attemptCount: 1, label: STEPS[1].label } },
  })
})

test("a closed item's outputs equal its field in /api/farm/snapshot — one data source", async () => {
  const res = await get('/api/items/SO-CLOSED/step-outputs')
  assert.equal(res.statusCode, 200)
  const farm = (
    await get('/api/farm/snapshot?scope=enabled', { 'x-farm-secret': 'farm-shared-secret-for-tests' })
  ).json()
  const fromFarm = farm.items.find((it) => it.id === 'SO-CLOSED').stepOutputs
  assert.deepEqual(res.json().stepOutputs, fromFarm)
  assert.equal(fromFarm[1].output, 'newer output')
  assert.equal(fromFarm[1].attemptCount, 2)
})

test("a disabled project's item and an unknown id are the same 404", async () => {
  const hidden = await get('/api/items/SO-HIDDEN/step-outputs')
  const unknown = await get('/api/items/NOPE-1/step-outputs')
  assert.equal(hidden.statusCode, 404)
  assert.equal(unknown.statusCode, 404)
  assert.deepEqual(hidden.json(), { error: 'not_found' })
  assert.equal(hidden.body, unknown.body)
  assert.ok(!hidden.body.includes('must not leak'))
})

test('no session is a 401', async () => {
  const res = await get('/api/items/SO-OPEN/step-outputs', {})
  assert.equal(res.statusCode, 401)
  assert.ok(!res.body.includes('first output'))
})
