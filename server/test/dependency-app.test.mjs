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
process.env.MOCK_STEP_LATENCY_MS = '5'

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const orchestrator = await import('../src/orchestrator.js')
const premerge = await import('../src/premerge.js')

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
  assert.deepEqual(dep.blockedBy, [{ id: 'DA-BLOCKER', title: 'Blocker', abandoned: false, merged: false }])
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
  assert.deepEqual(dep.blockedBy, [{ id: 'DA-KEEP-BLOCKER', title: 'Kept blocker', abandoned: true, merged: false }])
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

// ---- HZ-467: a change dependent plans freely; implement waits for the merge ----

test('a planning-stage dependent is not blocked, and still lists its blocker with merged: false', async () => {
  insertItem.run('DA-PLAN-BLOCKER', 'Open blocker', ACCEPT_GATE_INDEX)
  insertItem.run('DA-PLAN-DEP', 'Planning dependent', 3)
  assert.equal((await addDep('DA-PLAN-DEP', 'DA-PLAN-BLOCKER')).statusCode, 200)
  const snapshot = (await inject({ method: 'GET', url: '/api/items' })).json()
  const dep = snapshot.items.find((it) => it.id === 'DA-PLAN-DEP')
  assert.equal(dep.blocked, false)
  assert.equal(dep.blockedByAbandoned, false)
  assert.deepEqual(dep.blockedBy, [{ id: 'DA-PLAN-BLOCKER', title: 'Open blocker', abandoned: false, merged: false }])
})

// Accept the code through the real gate route: GitHub is a fetch stub and
// farm/premerge.py's runner reports green, as in premerge-gate.test.mjs.
const HEAD = 'a'.repeat(40)
let mergeStatus = 200
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname
  const method = options.method || 'GET'
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => '' })
  if (method === 'GET' && /\/pulls\/\d+$/.test(path)) return json(200, { head: { sha: HEAD, ref: 'horizon/x' }, base: { ref: 'main' } })
  if (method === 'GET' && path.endsWith('/git/ref/heads%2Fmain')) return json(200, { object: { sha: 'b'.repeat(40) } })
  if (method === 'PUT' && path.endsWith('/merge')) return json(mergeStatus, mergeStatus === 200 ? { merged: true } : { message: 'nope' })
  return json(404, {})
}
premerge.runner.spawn = async (args) => ({
  code: 0,
  stdout: JSON.stringify({ head_sha: args[4], base_sha: args[6], ok: true, merge_sha: 'd'.repeat(40), note: 'checks passed' }) + '\n',
  stderr: '',
  timedOut: false,
})

const implementRuns = (id) =>
  db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ?').get(id, IMPLEMENT_STEP_INDEX).n
const mergedAt = (id) => db.prepare('SELECT merged_at FROM work_item WHERE id = ?').get(id).merged_at
const acceptPair = async (blocker, pr) => {
  insertItem.run(blocker, 'Blocker at Accept', ACCEPT_GATE_INDEX)
  db.prepare("UPDATE work_item SET repo = 'acme/dep-merge', issue = ?, pr = ? WHERE id = ?").run(pr, pr, blocker)
  const dep = `${blocker}-DEP`
  insertItem.run(dep, 'Waits at implement', IMPLEMENT_STEP_INDEX)
  assert.equal((await addDep(dep, blocker)).statusCode, 200)
  return dep
}
const approveAccept = (id) =>
  inject({ method: 'POST', url: `/api/items/${id}/gates/${ACCEPT_GATE_INDEX}/approve`, payload: {}, headers: { 'x-human-key': pin } })
// Only the dependents are dispatched for real; the merged blocker's own
// Deploy is not part of these tests.
const dispatchDependents = () =>
  store.registerAgentRunner({ kick: (id) => id.endsWith('-DEP') && orchestrator.kick(id), cancel: orchestrator.cancel })

test('Accept in the UI merges the PR, records merged_at and dispatches the dependent at implement', async () => {
  mergeStatus = 200
  dispatchDependents()
  const dep = await acceptPair('DA-MERGE', 9101)
  assert.equal(implementRuns(dep), 0)

  const res = await approveAccept('DA-MERGE')
  assert.equal(res.statusCode, 200, res.body)
  assert.ok(mergedAt('DA-MERGE'))
  assert.equal(implementRuns(dep), 1, 'implement dispatched at the merge')

  const first = mergedAt('DA-MERGE')
  assert.equal(store.markMerged('DA-MERGE'), false, 'a second markMerged is a no-op')
  assert.equal(mergedAt('DA-MERGE'), first)
  assert.equal(implementRuns(dep), 1)
  orchestrator.cancel(dep)
})

test('a failed merge leaves merged_at unset, the gate open and implement held', async () => {
  mergeStatus = 405
  dispatchDependents()
  const dep = await acceptPair('DA-NOMERGE', 9102)

  const res = await approveAccept('DA-NOMERGE')
  assert.equal(res.statusCode, 502)
  assert.equal(mergedAt('DA-NOMERGE'), null)
  assert.equal(store.getItem('DA-NOMERGE').cursor, ACCEPT_GATE_INDEX)
  assert.equal(implementRuns(dep), 0)
  store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
})
