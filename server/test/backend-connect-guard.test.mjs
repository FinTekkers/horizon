// HO-870: Horizon refuses to connect or reconnect a repo as a backend that
// differs from the backend its items already use. Items outlive a disconnect,
// so each case runs the real journey — connect, sync an item, disconnect,
// reconnect — and checks the 409 or 200 and what is stored afterwards.
//
// HO-879: the owner route stores an sl connect with no GitHub call (below);
// the sl half of "same backend reconnects" is still proven at the store
// (addRepoToProject), as HO-870 wrote it.
//
// GitHub is a stubbed globalThis.fetch that records every call.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const TOKEN_ROOT = mkdtempSync(join(tmpdir(), 'horizon-backend-guard-tokens-'))
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-backend-guard-')), 'test.db')
process.env.HORIZON_TENANT_TOKEN_ROOT = TOKEN_ROOT
process.env.HORIZON_UI_URL = 'https://horizon.test/horizon'
process.env.GITHUB_WEBHOOK_SECRET = 'ho870-webhook-secret'
process.env.GITHUB_TOKEN = 'ghp_OWNERGLOBALTOKENho870ABCDEFGHIJKLMNOP'
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

// ---- the GitHub stub ----

let calls = []
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input, opts = {}) => {
  const url = String(input)
  const method = (opts.method || 'GET').toUpperCase()
  calls.push(`${method} ${url}`)
  const { pathname, search } = new URL(url)
  const repo = pathname.match(/^\/repos\/([^/]+\/[^/]+)/)?.[1]
  if (method === 'GET' && repo && pathname === `/repos/${repo}`) return json({ full_name: repo, default_branch: 'main' })
  // pollRepo: one open issue, so a connect syncs an item.
  if (method === 'GET' && pathname === `/repos/${repo}/issues` && search.includes('state=all')) {
    return json([{ number: 5, title: 'Synced issue', body: '', labels: [], state: 'open', updated_at: '2026-11-01T00:00:00Z' }])
  }
  if (method === 'POST' && pathname.endsWith('/hooks')) return json({ id: 7, config: { url: 'x' } }, 201)
  return method === 'GET' ? json([]) : json({}, 201)
}

// ---- app, users, projects ----

const app = buildApp({ logger: false, provisionRunUser: async () => {} })
await app.ready()

const owner = loginFixtureUser(auth, config)
const member = loginFixtureUser(auth, config, { email: 'm@example.com', name: 'Member', role: 'member' })
const P = store.createProject('Backend guard').id
db.prepare('INSERT INTO project_member (project_id, user_id) VALUES (?, ?)').run(P, member.user.id)
const TENANT = store.createProject('Tenant', { isolation: 'tenant', memberId: member.user.id }).id

const send = (who, method, url, payload, { pin } = {}) =>
  app.inject({ method, url, headers: { cookie: who.cookie, ...(pin ? { 'x-human-key': pin } : {}) }, payload })
const connect = (payload) => send(owner, 'POST', `/api/projects/${P}/repos`, payload)
const disconnect = (repo) => send(owner, 'POST', `/api/projects/${P}/repos/disconnect`, { repo }, { pin: owner.pin })

const repoRow = (repo) => db.prepare('SELECT * FROM project_repo WHERE repo = ? COLLATE NOCASE').get(repo) ?? null
const itemBackends = (repo) => db.prepare('SELECT id, backend FROM work_item WHERE repo = ? ORDER BY id').all(repo)
const issue = (number) => ({ number, title: `Issue ${number}`, body: '', labels: [], state: 'open', updated_at: '2026-11-01T00:00:00Z' })

// An sl repo with one item, then disconnected: connected at the store (the
// route refuses sl), its item synced through the same insert as GitHub's.
function slRepoWithItem(repo, projectId = P) {
  assert.equal(store.addRepoToProject(projectId, repo, 'sl').ok, true)
  assert.equal(store.upsertFromGithub(issue(1), repo), true)
  assert.deepEqual(
    itemBackends(repo).map((r) => r.backend),
    ['sl'],
    'the item takes its repo’s backend',
  )
  return repoRow(repo).prefix
}

// ---- metric 3 ----

test('metric 3: reconnecting a repo whose items are sl as github returns 409 naming both backends; stored backends are unchanged', async () => {
  const repo = 'acme/sl-app'
  slRepoWithItem(repo)
  const off = await disconnect(repo)
  assert.equal(off.statusCode, 200, off.body)
  assert.equal(repoRow(repo), null)
  const items = itemBackends(repo)

  calls = []
  const res = await connect({ repo })
  assert.equal(res.statusCode, 409, res.body)
  assert.deepEqual(res.json(), { error: 'Repository items use sl; cannot connect as github', itemBackend: 'sl', backend: 'github' })
  assert.deepEqual(itemBackends(repo), items, 'item backends are unchanged')
  assert.equal(repoRow(repo), null, 'no project_repo row is added')
  assert.deepEqual(calls, [], 'the conflict is found before any GitHub call')

  // Any letter case of the repo is the same repo.
  const upper = await connect({ repo: 'ACME/SL-APP', backend: 'github' })
  assert.equal(upper.statusCode, 409, upper.body)
  assert.equal(upper.json().itemBackend, 'sl')
  assert.equal(repoRow(repo), null)

  // metric 4, the sl half: the same backend reconnects (store level — see the header).
  const same = store.addRepoToProject(P, repo, 'sl')
  assert.equal(same.ok, true, JSON.stringify(same))
  assert.equal(same.backend, 'sl')
  assert.equal(repoRow(repo).backend, 'sl')
  assert.deepEqual(itemBackends(repo), items)
})

test('metric 3: a tenant connect on a repo whose items are sl returns 409 backend_conflict; no token file and no repo row are written', async () => {
  const repo = 'acme/tenant-sl'
  const internal = store.createProject('Former home').id
  slRepoWithItem(repo, internal)
  assert.equal(store.removeRepoFromProject(internal, repo).ok, true)

  calls = []
  const res = await send(member, 'POST', `/api/tenant/projects/${TENANT}/repos`, { repo, token: `github_pat_11TENANT_${'t'.repeat(60)}` }, { pin: member.pin })
  assert.equal(res.statusCode, 409, res.body)
  assert.equal(res.json().error, 'backend_conflict')
  assert.equal(res.json().message, 'Repository items use sl; cannot connect as github')
  assert.deepEqual(readdirSync(TOKEN_ROOT), [], 'no token file is written')
  assert.equal(repoRow(repo), null)
  assert.deepEqual(db.prepare('SELECT * FROM project_repo WHERE project_id = ?').all(TENANT), [])
  assert.deepEqual(calls, [])
  assert.deepEqual(
    itemBackends(repo).map((r) => r.backend),
    ['sl'],
  )
  // setTenantConnection asks inside its transaction too.
  assert.equal(store.setTenantConnection(TENANT, repo, 'test').error, 'backend_conflict')
  assert.equal(repoRow(repo), null)
})

// ---- metric 4 ----

test('metric 4: connecting, syncing, disconnecting and reconnecting a github repo as github returns 200 with backend github', async () => {
  const repo = 'acme/gh-app'
  const first = await connect({ repo })
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json().backend, 'github')
  const items = itemBackends(repo)
  assert.equal(items.length, 1, 'the connect synced the issue')
  assert.equal(items[0].backend, 'github')

  assert.equal((await disconnect(repo)).statusCode, 200)
  assert.equal(repoRow(repo), null)

  const again = await connect({ repo })
  assert.equal(again.statusCode, 200, again.body)
  assert.equal(again.json().ok, true)
  assert.equal(again.json().repo, repo)
  assert.equal(again.json().backend, 'github')
  assert.equal(repoRow(repo).backend, 'github')
  assert.deepEqual(itemBackends(repo), items)

  // Naming the backend explicitly is the same connect.
  assert.equal((await disconnect(repo)).statusCode, 200)
  const named = await connect({ repo, backend: 'github' })
  assert.equal(named.statusCode, 200, named.body)
  assert.equal(repoRow(repo).backend, 'github')
})

// ---- metric 5 ----

test('metric 5: addRepoToProject without a backend stores github', () => {
  const result = store.addRepoToProject(P, 'acme/plain')
  assert.equal(result.ok, true)
  assert.equal(result.backend, 'github')
  assert.equal(repoRow('acme/plain').backend, 'github')
})

// ---- guardrail 2: only github and sl ----

test('guardrail 2: internal is refused by addRepoToProject (no row) and by the route (400, no GitHub call)', async () => {
  assert.deepEqual(store.addRepoToProject(P, 'acme/internal', 'internal'), { error: 'invalid_backend' })
  assert.deepEqual(store.addRepoToProject(P, 'acme/internal', null), { error: 'invalid_backend' })
  assert.equal(repoRow('acme/internal'), null)

  calls = []
  const res = await connect({ repo: 'acme/internal', backend: 'internal' })
  assert.equal(res.statusCode, 400, res.body)
  assert.equal(repoRow('acme/internal'), null)
  assert.deepEqual(calls, [])
})

// HO-879: was refused with 400 under HO-870; an owner sl connect now stores sl.
test('an sl connect over HTTP with no conflicting items stores sl and makes no GitHub call', async () => {
  calls = []
  const res = await connect({ repo: 'acme/new-sl', backend: 'sl' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().backend, 'sl')
  assert.equal(repoRow('acme/new-sl').backend, 'sl')
  assert.deepEqual(calls, [])
})

// ---- exposure ----

test('GET /api/projects carries backend on every repo entry, for the owner and for a member', async () => {
  for (const [label, who] of [
    ['owner', owner],
    ['member', member],
  ]) {
    const res = await send(who, 'GET', '/api/projects')
    assert.equal(res.statusCode, 200, `${label}: ${res.body}`)
    const project = res.json().projects.find((p) => p.id === P)
    assert.ok(project, `${label} sees the project`)
    assert.ok(project.repos.length >= 2, label)
    for (const entry of project.repos) {
      assert.equal(entry.backend, repoRow(entry.repo).backend, `${label}: ${entry.repo}`)
    }
    assert.ok(
      project.repos.some((r) => r.backend === 'sl'),
      `${label}: the sl repo reads sl`,
    )
  }
})
