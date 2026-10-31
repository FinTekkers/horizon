// HZ-655: access.js resolves each member:* scope to a project and admits only
// that project's members; `filtered` and `self` pass with what their handlers
// need; store.listItems({ viewer }) hides NULL-project and `Unlinked items`
// rows, and everything while no project is active, from a non-owner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-access-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const settings = await import('../src/settings.js')
const access = await import('../src/access.js')
const { ensureUnlinkedProject } = await import('../src/membership.js')

function addProject(name) {
  return Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)').run(name).lastInsertRowid)
}
function addItem(id, projectId) {
  db.prepare(
    `INSERT INTO work_item (id, title, priority, desc, metric, guardrails, cursor, project_id)
     VALUES (?, ?, 'Medium', '', '', '', 0, ?)`,
  ).run(id, `Item ${id}`, projectId)
}
function addRun(itemId) {
  return Number(db.prepare("INSERT INTO step_run (item_id, step_index, agent) VALUES (?, 0, 'pm')").run(itemId).lastInsertRowid)
}
function addMember(userId, projectId) {
  db.prepare('INSERT INTO project_member (project_id, user_id) VALUES (?, ?)').run(projectId, userId)
}

const alpha = addProject('Alpha Access')
const beta = addProject('Beta Access')
const unlinked = ensureUnlinkedProject(db)
db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(alpha, 'acme/alpha', 'ALA')
db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(beta, 'acme/beta', 'BTA')
addItem('ALA-1', alpha)
addItem('BTA-1', beta)
addItem('UNL-1', unlinked)
addItem('NUL-1', null)
const alphaRun = addRun('ALA-1')
const betaRun = addRun('BTA-1')

const member = auth.createUser({ email: 'access-member@example.com', name: 'Access Member', authMethod: 'password' }).user
const owner = auth.createUser({ email: 'access-owner@example.com', name: 'Access Owner', authMethod: 'password', role: 'owner' }).user
addMember(member.id, alpha)

// Runs the guard as a preHandler would and reports what the client gets:
// { passed: true, viewer } or { status, body }.
async function run(scope, { user = member, params = {}, query = {}, body = undefined, guard = access.guard } = {}) {
  const request = { user: user ?? undefined, params, query, body, routeOptions: { config: { scope } }, log: { warn() {} } }
  const reply = {
    sent: null,
    code(status) {
      this.sent = { status }
      return this
    },
    send(payload) {
      this.sent.body = payload
      return this
    },
  }
  await guard(request, reply)
  return reply.sent ?? { passed: true, viewer: request.viewer }
}

const NOT_FOUND = { status: 404, body: { error: 'not_found' } }

test('member:item admits a member of the item’s project and 404s everything else', async () => {
  assert.equal((await run('member:item', { params: { id: 'ALA-1' } })).passed, true)
  assert.deepEqual(await run('member:item', { params: { id: 'BTA-1' } }), NOT_FOUND)
  assert.deepEqual(await run('member:item', { params: { id: 'NOPE-404' } }), NOT_FOUND)
  assert.equal(access.projectForScope('member:item', { params: { id: 'ALA-1' } }), alpha)
})

test('member:run resolves the run’s item to its project', async () => {
  assert.equal((await run('member:run', { params: { runId: String(alphaRun) } })).passed, true)
  assert.deepEqual(await run('member:run', { params: { runId: String(betaRun) } }), NOT_FOUND)
  assert.deepEqual(await run('member:run', { params: { runId: '999999' } }), NOT_FOUND)
  assert.deepEqual(await run('member:run', { params: { runId: 'abc' } }), NOT_FOUND)
})

test('member:project admits a member of that project id only', async () => {
  assert.equal((await run('member:project', { params: { id: String(alpha) } })).passed, true)
  assert.deepEqual(await run('member:project', { params: { id: String(beta) } }), NOT_FOUND)
  assert.deepEqual(await run('member:project', { params: { id: '987654' } }), NOT_FOUND)
})

test('member:slug resolves the project slug', async () => {
  assert.equal((await run('member:slug', { params: { slug: 'alpha-access' } })).passed, true)
  assert.deepEqual(await run('member:slug', { params: { slug: 'beta-access' } }), NOT_FOUND)
  assert.deepEqual(await run('member:slug', { params: { slug: 'no-such-project' } }), NOT_FOUND)
})

test('member:repo resolves body.repo, then query.repo', async () => {
  assert.equal((await run('member:repo', { body: { repo: 'acme/alpha' } })).passed, true)
  assert.equal((await run('member:repo', { query: { repo: 'acme/alpha' } })).passed, true)
  assert.deepEqual(await run('member:repo', { body: { repo: 'acme/beta' } }), NOT_FOUND)
  assert.deepEqual(await run('member:repo', { body: { repo: 'acme/unknown' } }), NOT_FOUND)
  assert.deepEqual(await run('member:repo', {}), NOT_FOUND)
})

test('member:rule resolves a project or repo rules key; any other rule scope resolves to nothing (HZ-660)', async () => {
  const rule = (scope, key) => ({ params: { scope, key } })
  assert.equal(access.projectForScope('member:rule', rule('project', 'alpha-access')), alpha)
  assert.equal(access.projectForScope('member:rule', rule('repo', 'acme__alpha')), alpha)
  assert.equal((await run('member:rule', rule('repo', 'acme__alpha'))).passed, true)
  assert.deepEqual(await run('member:rule', rule('project', 'beta-access')), NOT_FOUND)
  assert.deepEqual(await run('member:rule', rule('repo', 'acme__beta')), NOT_FOUND)
  for (const scope of ['role', 'persona', 'global', 'nope']) {
    for (const key of ['alpha-access', 'acme__alpha', 'eng_implement']) {
      assert.equal(access.projectForScope('member:rule', rule(scope, key)), null, `${scope}/${key}`)
      assert.deepEqual(await run('member:rule', rule(scope, key)), NOT_FOUND, `${scope}/${key}`)
    }
  }
  assert.deepEqual(await run('member:rule', { params: {} }), NOT_FOUND)
  // A repo name holding `__` resolves forward through rulesKey, not by reversing it.
  db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(alpha, 'acme/a__b', 'AAB')
  assert.equal(access.projectForScope('member:rule', rule('repo', 'acme__a__b')), alpha)
})

test('member:effective needs ?project and ?repo to name one of the member’s projects (HZ-660)', async () => {
  assert.equal((await run('member:effective', { query: { project: 'Alpha Access' } })).passed, true)
  assert.equal((await run('member:effective', { query: { project: 'Alpha Access', repo: 'acme/alpha' } })).passed, true)
  assert.equal((await run('member:effective', { query: { repo: 'acme/alpha' } })).passed, true)
  for (const query of [{}, { role: 'eng_implement' }, { project: 'Beta Access' }, { project: 'Alpha Access', repo: 'acme/beta' }, { project: 'Nope' }]) {
    assert.deepEqual(await run('member:effective', { query }), NOT_FOUND, JSON.stringify(query))
  }
})

test('an item with no real project (NULL or `Unlinked items`) resolves to no project, so a non-owner gets 404', async () => {
  addMember(member.id, unlinked)
  try {
    assert.equal(access.projectForScope('member:item', { params: { id: 'UNL-1' } }), null)
    assert.deepEqual(await run('member:item', { params: { id: 'UNL-1' } }), NOT_FOUND)
    assert.deepEqual(await run('member:item', { params: { id: 'NUL-1' } }), NOT_FOUND)
  } finally {
    db.prepare('DELETE FROM project_member WHERE project_id = ? AND user_id = ?').run(unlinked, member.id)
  }
})

test('filtered passes a non-owner with their project ids, and the owner with no viewer', async () => {
  const asMember = await run('filtered')
  assert.equal(asMember.passed, true)
  assert.deepEqual([...asMember.viewer.projectIds], [alpha])
  const asOwner = await run('filtered', { user: owner })
  assert.deepEqual(asOwner, { passed: true, viewer: undefined })
  assert.equal(access.viewerFor({ user: owner }), null)
})

test('self passes any signed-in user; owner and test pass only the owner', async () => {
  assert.equal((await run('self')).passed, true)
  assert.deepEqual(await run('owner'), NOT_FOUND)
  assert.deepEqual(await run('test'), NOT_FOUND)
  assert.equal((await run('owner', { user: owner })).passed, true)
  assert.equal((await run('member:item', { user: owner, params: { id: 'BTA-1' } })).passed, true)
})

test('the guard fails closed: a missing or unknown scope, no user, or a resolver throw is 404', async () => {
  assert.deepEqual(await run(undefined), NOT_FOUND)
  assert.deepEqual(await run('admin'), NOT_FOUND)
  assert.deepEqual(await run('member:item', { user: null, params: { id: 'ALA-1' } }), NOT_FOUND)
  const throwing = access.createGuard({
    resolveProject() {
      throw new Error('boom')
    },
  })
  assert.deepEqual(await run('member:item', { params: { id: 'ALA-1' }, guard: throwing }), NOT_FOUND)
})

test('exempt scopes pass without a user', async () => {
  for (const scope of access.EXEMPT_SCOPES) {
    assert.equal((await run(scope, { user: null })).passed, true, scope)
  }
})

test('listItems({ viewer }) hides NULL-project and `Unlinked items` rows from a non-owner; the owner still sees them', () => {
  settings.setSetting('active_project_id', String(alpha))
  // Even a membership of `Unlinked items` does not show its rows.
  addMember(member.id, unlinked)
  const viewer = access.viewerFor({ user: member })
  try {
    assert.ok(viewer.projectIds.has(unlinked))
    const memberIds = store.listItems({ scope: 'enabled', viewer, stepOutputs: false }).map((i) => i.id)
    assert.deepEqual(memberIds, ['ALA-1'])
    assert.deepEqual(store.listItems({ scope: 'active', viewer, stepOutputs: false }).map((i) => i.id), ['ALA-1'])
    const ownerIds = store.listItems({ scope: 'enabled', stepOutputs: false }).map((i) => i.id)
    for (const id of ['ALA-1', 'BTA-1', 'UNL-1', 'NUL-1']) assert.ok(ownerIds.includes(id), id)
    assert.equal(store.itemStepOutputs('UNL-1', viewer), null)
    assert.equal(store.itemStepOutputs('BTA-1', viewer), null)
    assert.notEqual(store.itemStepOutputs('ALA-1', viewer), null)
  } finally {
    db.prepare('DELETE FROM project_member WHERE project_id = ? AND user_id = ?').run(unlinked, member.id)
  }
})

test('listItems({ viewer }) shows a non-owner nothing while no project is active; the owner sees every item', () => {
  db.prepare("DELETE FROM setting WHERE key = 'active_project_id'").run()
  assert.equal(settings.getActiveProjectId(), null)
  const viewer = access.viewerFor({ user: member })
  assert.deepEqual(store.listItems({ scope: 'active', viewer, stepOutputs: false }), [])
  const ownerIds = store.listItems({ scope: 'active', stepOutputs: false }).map((i) => i.id)
  for (const id of ['ALA-1', 'BTA-1', 'UNL-1', 'NUL-1']) assert.ok(ownerIds.includes(id), id)
})
