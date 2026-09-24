// HTTP-contract tests for the dependency endpoints (HZ-78), driven through
// the real Fastify app via inject() — same shape as app.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-dep-app-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { STEPS } = await import('../src/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
const inject = (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie } })

const insertItem = db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, 'Medium', ?)",
)
insertItem.run('DA-DEP', 'Dependent', 11)
insertItem.run('DA-BLOCKER', 'Blocker', 11)
insertItem.run('DA-CLOSED', 'Closed', STEPS.length)

const addDep = (id, dependsOnId) => inject({ method: 'POST', url: `/api/items/${id}/dependencies`, payload: { dependsOnId } })
const removeDep = (id, dependsOnId) =>
  inject({ method: 'POST', url: `/api/items/${id}/dependencies/remove`, payload: { dependsOnId } })

test('POST /dependencies with no body field 400s at the schema layer', async () => {
  assert.equal((await inject({ method: 'POST', url: '/api/items/DA-DEP/dependencies', payload: {} })).statusCode, 400)
})

test('adding a dependency on an unknown item is 404', async () => {
  const res = await addDep('NOPE-9', 'DA-BLOCKER')
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'not_found' })
})

test('a self-dependency is rejected 409', async () => {
  const res = await addDep('DA-DEP', 'DA-DEP')
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'self_dependency')
})

test('a cycle is rejected 409 with a message naming the offending items', async () => {
  assert.equal((await addDep('DA-DEP', 'DA-BLOCKER')).statusCode, 200)
  const res = await addDep('DA-BLOCKER', 'DA-DEP')
  assert.equal(res.statusCode, 409)
  const body = res.json()
  assert.equal(body.error, 'cycle')
  assert.match(body.message, /DA-DEP/)
})

test('a blocked item reads as blocked, naming its blocker, in GET /api/items', async () => {
  const snapshot = (await inject({ method: 'GET', url: '/api/items' })).json()
  const dep = snapshot.items.find((it) => it.id === 'DA-DEP')
  assert.equal(dep.blocked, true)
  assert.deepEqual(dep.blockedBy, [{ id: 'DA-BLOCKER', title: 'Blocker', abandoned: false }])
})

test('removing the dependency unblocks it, reflected immediately in GET /api/items', async () => {
  const res = await removeDep('DA-DEP', 'DA-BLOCKER')
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().blocked, false)
  const snapshot = (await inject({ method: 'GET', url: '/api/items' })).json()
  assert.equal(snapshot.items.find((it) => it.id === 'DA-DEP').blocked, false)
})

test('removing a dependency that does not exist is 404', async () => {
  const res = await removeDep('DA-DEP', 'DA-BLOCKER')
  assert.equal(res.statusCode, 404)
})

test('depending on an already-closed item is not blocked', async () => {
  const res = await addDep('DA-DEP', 'DA-CLOSED')
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().blocked, false)
})
