// HZ-661: "Set up your first project". A non-owner's POST /api/projects makes
// them a member of the new project and sets their own user.active_project_id
// to it, and their board shows that project with no items. Every member's
// board reads their own active project, never the global one, so one user's
// switch never changes another's board. The server sets active_project_id only
// to a project the user belongs to: a duplicate name writes nothing, and
// Activate on someone else's project is a 404. A member with no projects and a
// stale active id gets empty results, never every project.
//
// Through the real app (app.inject). globalThis.fetch throws, so no path
// reaches GitHub.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-first-project-')), 'test.db')
for (const key of ['FARM_HOME', 'FARM_URL', 'GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const realFetch = globalThis.fetch
globalThis.fetch = () => {
  throw new Error('test reached the network: stub this dependency')
}
after(() => {
  globalThis.fetch = realFetch
})

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const appModule = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const access = await import('../src/access.js')
const { getSetting, setSetting } = await import('../src/settings.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

const app = appModule.buildApp({ logger: false })
await app.ready()
after(() => app.close())

const owner = loginFixtureUser(auth, config)
const newcomer = loginFixtureUser(auth, config, { email: 'newcomer@example.com', name: 'New Comer', role: 'member' })
const userA = loginFixtureUser(auth, config, { email: 'a@example.com', name: 'Member A', role: 'member' })
const userB = loginFixtureUser(auth, config, { email: 'b@example.com', name: 'Member B', role: 'member' })
const stale = loginFixtureUser(auth, config, { email: 'stale@example.com', name: 'Stale Member', role: 'member' })

// The owner's project holds the global active setting throughout.
const FARM = store.createProject('Farm home').id
setSetting('active_project_id', String(FARM))
const addMember = db.prepare('INSERT INTO project_member (project_id, user_id) VALUES (?, ?)')
const P1 = store.createProject('Alpha').id
const P2 = store.createProject('Beta').id
const OTHER = store.createProject('Other').id
for (const p of [P1, P2]) {
  addMember.run(p, userA.user.id)
  addMember.run(p, userB.user.id)
}
store.setUserActiveProject(userB.user.id, P1)

const send = (who, { method = 'GET', url, payload }) =>
  app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload === undefined ? {} : { payload }) })
const memberRows = (userId) =>
  db
    .prepare('SELECT project_id FROM project_member WHERE user_id = ? ORDER BY project_id')
    .all(userId)
    .map((r) => r.project_id)
const boardOf = (who) => appModule.snapshot({ scope: 'enabled', stepOutputs: false, viewer: access.viewerForUser(who.user.id), userId: who.user.id })

test("metric 2: a non-owner's create adds their member row, sets their active project to it, and their board shows it with no items", async () => {
  assert.deepEqual(memberRows(newcomer.user.id), [])
  const res = await send(newcomer, { method: 'POST', url: '/api/projects', payload: { name: 'Newcomer Co' } })
  assert.equal(res.statusCode, 200, res.body)
  const { id } = res.json()
  assert.deepEqual(memberRows(newcomer.user.id), [id])
  assert.equal(store.getUserActiveProject(newcomer.user.id), id)
  assert.equal(getSetting('active_project_id'), String(FARM), 'the global active project moved')

  const board = (await send(newcomer, { url: '/api/items?v=2' })).json()
  assert.equal(board.activeProjectId, id)
  assert.deepEqual(board.items, [])
  assert.deepEqual(
    board.projects.map((p) => [p.id, p.name]),
    [[id, 'Newcomer Co']],
  )
})

test("the owner's create writes no member row and no per-user active project", async () => {
  const res = await send(owner, { method: 'POST', url: '/api/projects', payload: { name: 'Owner Co' } })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(memberRows(owner.user.id), [])
  assert.equal(store.getUserActiveProject(owner.user.id), null)
})

test('guardrail 4: a duplicate-name create is 409 and adds no member row and no active project', async () => {
  const rowsBefore = memberRows(userA.user.id)
  const activeBefore = store.getUserActiveProject(userA.user.id)
  const res = await send(userA, { method: 'POST', url: '/api/projects', payload: { name: 'Other' } })
  assert.equal(res.statusCode, 409, res.body)
  assert.deepEqual(res.json(), { error: 'A project with that name already exists' })
  assert.deepEqual(memberRows(userA.user.id), rowsBefore)
  assert.equal(store.getUserActiveProject(userA.user.id), activeBefore)
})

test("guardrail 4: Activate on a project the member is not in is 404 and leaves their active project as it was", async () => {
  store.setUserActiveProject(userA.user.id, P1)
  const res = await send(userA, { method: 'POST', url: `/api/projects/${OTHER}/activate` })
  assert.equal(res.statusCode, 404, res.body)
  assert.equal(store.getUserActiveProject(userA.user.id), P1)
})

test("metric 4: when A switches to P1 then P2, B's active project and board stay the same", async () => {
  store.setUserActiveProject(userA.user.id, null)
  const bActive = store.getUserActiveProject(userB.user.id)
  const bBoard = boardOf(userB)
  assert.equal(bBoard.activeProjectId, P1)
  for (const p of [P1, P2]) {
    const res = await send(userA, { method: 'POST', url: `/api/projects/${p}/activate` })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(store.getUserActiveProject(userA.user.id), p)
    assert.equal(boardOf(userA).activeProjectId, p)
    assert.equal((await send(userA, { url: '/api/items?v=2' })).json().activeProjectId, p)
    assert.equal(store.getUserActiveProject(userB.user.id), bActive)
    assert.deepEqual(boardOf(userB), bBoard)
    assert.equal((await send(userB, { url: '/api/items?v=2' })).json().activeProjectId, P1)
  }
  assert.equal(getSetting('active_project_id'), String(FARM))
})

test('guardrail 2: a member with no projects and a stale active project id gets empty results, never every project', async () => {
  store.setUserActiveProject(stale.user.id, OTHER)
  assert.deepEqual(memberRows(stale.user.id), [])
  const board = (await send(stale, { url: '/api/items?v=2' })).json()
  assert.deepEqual(board.projects, [])
  assert.deepEqual(board.items, [])
  assert.equal(board.activeProjectId, null)
  assert.equal(board.repoUrl, null)
  assert.deepEqual((await send(stale, { url: '/api/projects' })).json(), { projects: [] })
  // So does a member whose last membership was just removed.
  addMember.run(P1, stale.user.id)
  store.setUserActiveProject(stale.user.id, P1)
  assert.equal((await send(stale, { url: '/api/items?v=2' })).json().activeProjectId, P1)
  db.prepare('DELETE FROM project_member WHERE user_id = ?').run(stale.user.id)
  const after = (await send(stale, { url: '/api/items?v=2' })).json()
  assert.deepEqual([after.projects, after.items, after.activeProjectId], [[], [], null])
})
