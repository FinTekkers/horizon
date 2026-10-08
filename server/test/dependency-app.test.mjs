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
const { STEPS } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
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

// ---- HZ-354: abandon can drop every link where the item is the blocker ----

const links = () =>
  db
    .prepare('SELECT item_id, depends_on_id FROM work_item_dependency ORDER BY item_id, depends_on_id')
    .all()
    .map((r) => `${r.item_id}->${r.depends_on_id}`)
const removalEvents = (id, blockerId) =>
  db
    .prepare('SELECT text FROM event WHERE item_id = ? AND text LIKE ?')
    .all(id, `removed the dependency on ${blockerId} %`)
const abandonPost = (id, payload, headers = { 'x-human-key': pin }) =>
  inject({ method: 'POST', url: `/api/items/${id}/abandon`, payload, headers })
const dependentState = (id) => db.prepare('SELECT abandoned_at, cursor FROM work_item WHERE id = ?').get(id)

test('abandon with removeDependentLinks but no gate PIN is 401, and every link stays', async () => {
  insertItem.run('DA-PIN-BLOCKER', 'PIN blocker', 11)
  insertItem.run('DA-PIN-DEP', 'PIN dependent', 11)
  assert.equal((await addDep('DA-PIN-DEP', 'DA-PIN-BLOCKER')).statusCode, 200)
  const before = links()
  const res = await abandonPost('DA-PIN-BLOCKER', { reason: 'superseded', removeDependentLinks: true }, {})
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
  assert.deepEqual(links(), before)
  assert.equal(dependentState('DA-PIN-BLOCKER').abandoned_at, null)
})

test('abandon with removeDependentLinks removes every link to it in one request, one event per dependent', async () => {
  insertItem.run('DA-AB-BLOCKER', 'Abandoned blocker', 11)
  insertItem.run('DA-AB-DEP1', 'Live dependent', 11)
  insertItem.run('DA-AB-DEP2', 'Second dependent', 4)
  insertItem.run('DA-AB-DEPGONE', 'Abandoned dependent', 11)
  insertItem.run('DA-AB-UPSTREAM', 'Its own blocker', 11)
  insertItem.run('DA-AB-OTHER-A', 'Unrelated A', 11)
  insertItem.run('DA-AB-OTHER-B', 'Unrelated B', 11)
  for (const dep of ['DA-AB-DEP1', 'DA-AB-DEP2', 'DA-AB-DEPGONE']) {
    assert.equal((await addDep(dep, 'DA-AB-BLOCKER')).statusCode, 200)
  }
  assert.equal((await addDep('DA-AB-BLOCKER', 'DA-AB-UPSTREAM')).statusCode, 200)
  assert.equal((await addDep('DA-AB-OTHER-A', 'DA-AB-OTHER-B')).statusCode, 200)
  // A dependent that is itself abandoned still has its link removed.
  assert.equal((await abandonPost('DA-AB-DEPGONE', { reason: 'not needed' })).statusCode, 200)
  const before = Object.fromEntries(['DA-AB-DEP1', 'DA-AB-DEP2'].map((id) => [id, dependentState(id)]))

  const res = await abandonPost('DA-AB-BLOCKER', { reason: 'superseded', removeDependentLinks: true })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, removedLinks: ['DA-AB-DEP1', 'DA-AB-DEP2', 'DA-AB-DEPGONE'] })

  const after = links()
  assert.equal(after.filter((l) => l.endsWith('->DA-AB-BLOCKER')).length, 0)
  // Only links where it is the blocker go.
  assert.ok(after.includes('DA-AB-BLOCKER->DA-AB-UPSTREAM'))
  assert.ok(after.includes('DA-AB-OTHER-A->DA-AB-OTHER-B'))
  for (const dep of ['DA-AB-DEP1', 'DA-AB-DEP2', 'DA-AB-DEPGONE']) {
    const events = removalEvents(dep, 'DA-AB-BLOCKER')
    assert.equal(events.length, 1, dep)
    assert.equal(events[0].text, 'removed the dependency on DA-AB-BLOCKER (Abandoned blocker): it was abandoned')
  }
  // The dependents themselves are untouched.
  for (const dep of ['DA-AB-DEP1', 'DA-AB-DEP2']) assert.deepEqual(dependentState(dep), before[dep])

  const snapshot = (await inject({ method: 'GET', url: '/api/items' })).json()
  const dep1 = snapshot.items.find((it) => it.id === 'DA-AB-DEP1')
  assert.equal(dep1.blocked, false)
  assert.deepEqual(dep1.blockedBy, [])
  assert.ok(dep1.events.some((e) => e.text.includes('DA-AB-BLOCKER')))
})

test('abandon without removeDependentLinks keeps every link and writes no removal event', async () => {
  insertItem.run('DA-KEEP-BLOCKER', 'Kept blocker', 11)
  insertItem.run('DA-KEEP-DEP', 'Kept dependent', 11)
  assert.equal((await addDep('DA-KEEP-DEP', 'DA-KEEP-BLOCKER')).statusCode, 200)

  const res = await abandonPost('DA-KEEP-BLOCKER', { reason: 'superseded' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true })
  assert.ok(links().includes('DA-KEEP-DEP->DA-KEEP-BLOCKER'))
  assert.equal(removalEvents('DA-KEEP-DEP', 'DA-KEEP-BLOCKER').length, 0)
  const snapshot = (await inject({ method: 'GET', url: '/api/items' })).json()
  const dep = snapshot.items.find((it) => it.id === 'DA-KEEP-DEP')
  assert.equal(dep.blockedByAbandoned, true)
  assert.deepEqual(dep.blockedBy, [{ id: 'DA-KEEP-BLOCKER', title: 'Kept blocker', abandoned: true }])
})

test('abandon with removeDependentLinks: false behaves like the flag absent', async () => {
  insertItem.run('DA-FALSE-BLOCKER', 'False blocker', 11)
  insertItem.run('DA-FALSE-DEP', 'False dependent', 11)
  assert.equal((await addDep('DA-FALSE-DEP', 'DA-FALSE-BLOCKER')).statusCode, 200)
  const res = await abandonPost('DA-FALSE-BLOCKER', { reason: 'superseded', removeDependentLinks: false })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true })
  assert.ok(links().includes('DA-FALSE-DEP->DA-FALSE-BLOCKER'))
  assert.equal(removalEvents('DA-FALSE-DEP', 'DA-FALSE-BLOCKER').length, 0)
})
