// HO-879: the server builds every repo and item link, per backend, in
// links.js, and GET /api/projects carries them to the UI:
//   - each repo's `backend`, `url` and `itemCount` (the count folds letter case,
//     like COLLATE NOCASE), and
//   - each project's `repoLinks` and GitHub's `tokenPages`.
// GitHub's strings are byte-identical to the ones the UI used to build. sl
// fills the host's HORIZON_SL_*_URL_TEMPLATE values, and with none set an sl
// link is null — never a guessed link. A member sees the links but not
// `itemCount`.
//
// An owner sl connect stores the row and makes no GitHub call. A repo's
// backend switches in place through PUT /api/projects/:id/repos/backend until
// the repo has items, then 409. GitHub is a stubbed globalThis.fetch.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const SL_REPO = 'https://sl.example.test/{repo}'
const SL_ISSUE = 'https://sl.example.test/{repo}/tasks/{n}'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-repo-links-')), 'test.db')
process.env.HORIZON_TENANT_TOKEN_ROOT = mkdtempSync(join(tmpdir(), 'horizon-repo-links-tokens-'))
process.env.GITHUB_WEBHOOK_SECRET = 'ho879-webhook-secret'
process.env.GITHUB_TOKEN = 'ghp_OWNERGLOBALTOKENho879ABCDEFGHIJKLMNOP'
process.env.HORIZON_SL_REPO_URL_TEMPLATE = SL_REPO
process.env.HORIZON_SL_ISSUE_URL_TEMPLATE = SL_ISSUE
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const settings = await import('../src/settings.js')
const links = await import('../src/links.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

// ---- the GitHub stub: every repo exists; no issues sync ----

let calls = []
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input, opts = {}) => {
  const url = String(input)
  const method = (opts.method || 'GET').toUpperCase()
  calls.push(`${method} ${url}`)
  const { pathname } = new URL(url)
  const repo = pathname.match(/^\/repos\/([^/]+\/[^/]+)/)?.[1]
  if (method === 'GET' && repo && pathname === `/repos/${repo}`) return json({ full_name: repo, default_branch: 'main' })
  if (method === 'POST' && pathname.endsWith('/hooks')) return json({ id: 7, config: { url: 'x' } }, 201)
  return method === 'GET' ? json([]) : json({}, 201)
}

const app = buildApp({ logger: false, provisionRunUser: async () => {} })
await app.ready()

const owner = loginFixtureUser(auth, config)
const member = loginFixtureUser(auth, config, { email: 'm@example.com', name: 'Member', role: 'member' })
const P = store.createProject('Links').id
db.prepare('INSERT INTO project_member (project_id, user_id) VALUES (?, ?)').run(P, member.user.id)

const send = (who, method, url, payload, { pin } = {}) =>
  app.inject({ method, url, headers: { cookie: who.cookie, ...(pin ? { 'x-human-key': pin } : {}) }, payload })
const connect = (payload) => send(owner, 'POST', `/api/projects/${P}/repos`, payload)

async function projectsAs(who) {
  const res = await send(who, 'GET', '/api/projects')
  assert.equal(res.statusCode, 200, res.body)
  return res.json().projects
}
const projectAs = async (who) => (await projectsAs(who)).find((p) => p.id === P)
const repoAs = async (who, repo) => (await projectAs(who)).repos.find((r) => r.repo === repo)
const linkAs = async (who, repo) => (await projectAs(who)).repoLinks.find((l) => l.repo === repo)

const insertItem = db.prepare("INSERT INTO work_item (id, title, priority, repo, issue, project_id, backend) VALUES (?, ?, 'Medium', ?, ?, ?, ?)")

// ---- links.js ----

test('repoLinks: github builds exactly the strings the UI used to build', () => {
  assert.deepEqual(links.repoLinks('github', 'acme/web'), {
    url: 'https://github.com/acme/web',
    issueUrlTemplate: 'https://github.com/acme/web/issues/{n}',
  })
  assert.equal(links.issueLink(links.repoLinks('github', 'acme/web').issueUrlTemplate, 7), 'https://github.com/acme/web/issues/7')
  assert.equal(links.issueLink(links.repoLinks('github', 'Acme/Web').issueUrlTemplate, '12'), 'https://github.com/Acme/Web/issues/12')
})

test('repoLinks: sl fills the templates it is given, with no github.com', () => {
  const t = { repo: 'https://code.example.test/r/{repo}', issue: 'https://code.example.test/r/{repo}/t/{n}?from={repo}' }
  const got = links.repoLinks('sl', 'acme/core', t)
  assert.deepEqual(got, {
    url: 'https://code.example.test/r/acme/core',
    issueUrlTemplate: 'https://code.example.test/r/acme/core/t/{n}?from=acme/core',
  })
  assert.equal(links.issueLink(got.issueUrlTemplate, 3), 'https://code.example.test/r/acme/core/t/3?from=acme/core')
  assert.ok(!JSON.stringify(got).includes('github.com'))
})

test('repoLinks: sl reads the host templates from HORIZON_SL_*_URL_TEMPLATE', () => {
  assert.equal(config.SL_REPO_URL_TEMPLATE, SL_REPO)
  assert.equal(config.SL_ISSUE_URL_TEMPLATE, SL_ISSUE)
  assert.deepEqual(links.repoLinks('sl', 'acme/core'), {
    url: 'https://sl.example.test/acme/core',
    issueUrlTemplate: 'https://sl.example.test/acme/core/tasks/{n}',
  })
})

test('repoLinks: with no sl template, or an issue template with no {n}, the link is null', () => {
  assert.deepEqual(links.repoLinks('sl', 'acme/core', { repo: null, issue: null }), { url: null, issueUrlTemplate: null })
  assert.deepEqual(links.repoLinks('sl', 'acme/core', { repo: SL_REPO, issue: 'https://sl.example.test/{repo}/tasks' }), {
    url: 'https://sl.example.test/acme/core',
    issueUrlTemplate: null,
  })
})

test('repoLinks: an unknown backend or a missing repo has no link; issueLink needs a template and a number', () => {
  assert.deepEqual(links.repoLinks('internal', 'acme/web'), { url: null, issueUrlTemplate: null })
  assert.deepEqual(links.repoLinks('github', ''), { url: null, issueUrlTemplate: null })
  assert.deepEqual(links.repoLinks('github', null), { url: null, issueUrlTemplate: null })
  assert.equal(links.issueLink(null, 7), null)
  assert.equal(links.issueLink('https://github.com/acme/web/issues/{n}', null), null)
  assert.equal(links.issueLink('https://github.com/acme/web/issues/{n}', ''), null)
})

test('GitHub token pages are the two pages the UI used to hard-code', () => {
  assert.deepEqual({ ...links.GITHUB_TOKEN_PAGES }, {
    fineGrained: 'https://github.com/settings/personal-access-tokens/new',
    classic: 'https://github.com/settings/tokens/new?scopes=repo,workflow',
  })
  assert.ok(Object.isFrozen(links.GITHUB_TOKEN_PAGES))
})

test('getRepoUrl returns the same string as before, now built by repoLinks', () => {
  db.prepare("DELETE FROM setting WHERE key = 'github_repo'").run()
  assert.equal(settings.getRepoUrl(), 'https://github.com/FinTekkers/horizon')
  settings.setSetting('github_repo', 'acme/board')
  try {
    assert.equal(settings.getRepoUrl(), 'https://github.com/acme/board')
  } finally {
    db.prepare("DELETE FROM setting WHERE key = 'github_repo'").run()
  }
})

// ---- GET /api/projects ----

test('a connect with no backend stores github; GET /api/projects reads it back with its link and a 0 count', async () => {
  calls = []
  const res = await connect({ repo: 'acme/web' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(db.prepare('SELECT backend FROM project_repo WHERE repo = ?').get('acme/web').backend, 'github')
  const repo = await repoAs(owner, 'acme/web')
  assert.deepEqual(
    { backend: repo.backend, url: repo.url, itemCount: repo.itemCount },
    { backend: 'github', url: 'https://github.com/acme/web', itemCount: 0 },
  )
  assert.deepEqual(await linkAs(owner, 'acme/web'), {
    repo: 'acme/web',
    backend: 'github',
    url: 'https://github.com/acme/web',
    issueUrlTemplate: 'https://github.com/acme/web/issues/{n}',
  })
})

test('a connect that names github stores github', async () => {
  const res = await connect({ repo: 'acme/named', backend: 'github' })
  assert.equal(res.statusCode, 200, res.body)
  const repo = await repoAs(owner, 'acme/named')
  assert.equal(repo.backend, 'github')
  assert.equal(repo.url, 'https://github.com/acme/named')
})

test('an sl connect stores sl, reads it back from GET /api/projects, and calls no GitHub', async () => {
  calls = []
  const res = await connect({ repo: 'acme/sl-app', backend: 'sl' })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.deepEqual(
    { ok: body.ok, repo: body.repo, backend: body.backend, defaultBranch: body.defaultBranch, webhook: body.webhook },
    { ok: true, repo: 'acme/sl-app', backend: 'sl', defaultBranch: null, webhook: null },
  )
  assert.equal(db.prepare('SELECT backend FROM project_repo WHERE repo = ?').get('acme/sl-app').backend, 'sl')
  assert.equal((await repoAs(owner, 'acme/sl-app')).backend, 'sl')
  assert.deepEqual(calls, [])
})

test('itemCount counts every item that names the repo, in any letter case (COLLATE NOCASE)', async () => {
  const res = await connect({ repo: 'acme/count' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal((await repoAs(owner, 'acme/count')).itemCount, 0)
  insertItem.run('CO-1', 'One', 'acme/count', 1, P, 'github')
  insertItem.run('CO-2', 'Two', 'ACME/Count', 2, P, 'github')
  // Another repo's item does not count.
  insertItem.run('WE-9', 'Other', 'acme/web2', 9, P, 'github')
  assert.equal((await repoAs(owner, 'acme/count')).itemCount, 2)
  // The same number as a COLLATE NOCASE count.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_item WHERE repo = ? COLLATE NOCASE').get('acme/count').n, 2)
  // A case variant an item carries keeps its own exact-name link.
  assert.equal((await linkAs(owner, 'ACME/Count')).issueUrlTemplate, 'https://github.com/ACME/Count/issues/{n}')
})

test('an sl repo carries the server-built sl links and no github.com', async () => {
  const repo = await repoAs(owner, 'acme/sl-app')
  assert.equal(repo.backend, 'sl')
  assert.equal(repo.url, 'https://sl.example.test/acme/sl-app')
  assert.equal(repo.itemCount, 0)
  const link = await linkAs(owner, 'acme/sl-app')
  assert.equal(link.issueUrlTemplate, 'https://sl.example.test/acme/sl-app/tasks/{n}')
  assert.ok(!JSON.stringify({ repo, link }).includes('github.com'))
})

test("a disconnected repo's items keep their links, under the items' backend", async () => {
  insertItem.run('GO-1', 'Gone', 'acme/gone-sl', 1, P, 'sl')
  const project = await projectAs(owner)
  assert.equal(project.repos.some((r) => r.repo === 'acme/gone-sl'), false)
  assert.deepEqual(await linkAs(owner, 'acme/gone-sl'), {
    repo: 'acme/gone-sl',
    backend: 'sl',
    url: 'https://sl.example.test/acme/gone-sl',
    issueUrlTemplate: 'https://sl.example.test/acme/gone-sl/tasks/{n}',
  })
})

test('every project carries the GitHub token pages', async () => {
  const project = await projectAs(owner)
  assert.deepEqual(project.tokenPages, { ...links.GITHUB_TOKEN_PAGES })
})

test('a member sees the links and token pages but not itemCount', async () => {
  const project = await projectAs(member)
  const repo = project.repos.find((r) => r.repo === 'acme/web')
  assert.deepEqual(repo, { repo: 'acme/web', prefix: repo.prefix, backend: 'github', url: 'https://github.com/acme/web' })
  assert.equal(Object.hasOwn(repo, 'itemCount'), false)
  assert.deepEqual(project.tokenPages, { ...links.GITHUB_TOKEN_PAGES })
  assert.equal(project.repoLinks.find((l) => l.repo === 'acme/sl-app').url, 'https://sl.example.test/acme/sl-app')
})

test('the board snapshot does not carry the new link fields (its shape stays pinned)', () => {
  const project = store.listProjects().find((p) => p.id === P)
  assert.equal(Object.hasOwn(project, 'repoLinks'), false)
  assert.equal(Object.hasOwn(project, 'tokenPages'), false)
  for (const repo of project.repos) {
    for (const key of ['backend', 'url', 'itemCount']) assert.equal(Object.hasOwn(repo, key), false, key)
  }
})

// ---- the backend lock (PUT /api/projects/:id/repos/backend and connect) ----

const repoBackend = (repo) => db.prepare('SELECT backend FROM project_repo WHERE repo = ?').get(repo)?.backend
const putBackend = (payload, { pin = owner.pin } = {}) => send(owner, 'PUT', `/api/projects/${P}/repos/backend`, payload, { pin })

test('PUT backend switches a repo with 0 items in place, and back; GET /api/projects reads the new backend and link', async () => {
  assert.equal((await connect({ repo: 'acme/switch' })).statusCode, 200)
  calls = []
  const res = await putBackend({ repo: 'acme/switch', backend: 'sl' })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true, repo: 'acme/switch', backend: 'sl', url: 'https://sl.example.test/acme/switch' })
  assert.equal(repoBackend('acme/switch'), 'sl')
  assert.equal((await repoAs(owner, 'acme/switch')).url, 'https://sl.example.test/acme/switch')
  assert.deepEqual(calls, [])
  const back = await putBackend({ repo: 'acme/switch', backend: 'github' })
  assert.equal(back.statusCode, 200, back.body)
  assert.equal(back.json().url, 'https://github.com/acme/switch')
  assert.equal(repoBackend('acme/switch'), 'github')
})

test('PUT backend returns 409 backend_locked for a repo with items, github → sl and sl → github; nothing changes', async () => {
  // acme/count has two github items (above).
  const locked = await putBackend({ repo: 'acme/count', backend: 'sl' })
  assert.equal(locked.statusCode, 409, locked.body)
  assert.equal(locked.json().error, 'backend_locked')
  assert.equal(repoBackend('acme/count'), 'github')
  // The architecture review's case: an sl repo row with one sl item.
  insertItem.run('SL-1', 'Sl item', 'acme/sl-app', 1, P, 'sl')
  const slLocked = await putBackend({ repo: 'acme/sl-app', backend: 'github' })
  assert.equal(slLocked.statusCode, 409, slLocked.body)
  assert.equal(slLocked.json().error, 'backend_locked')
  assert.equal(repoBackend('acme/sl-app'), 'sl')
  // Picking the backend it already has is a no-op, items or not.
  const same = await putBackend({ repo: 'acme/count', backend: 'github' })
  assert.equal(same.statusCode, 200, same.body)
})

test('PUT backend: 404 for a repo not on the project, 400 for an unknown backend, 401 with no PIN', async () => {
  assert.equal((await putBackend({ repo: 'acme/nowhere', backend: 'sl' })).statusCode, 404)
  assert.equal((await putBackend({ repo: 'acme/switch', backend: 'internal' })).statusCode, 400)
  const noPin = await send(owner, 'PUT', `/api/projects/${P}/repos/backend`, { repo: 'acme/switch', backend: 'sl' })
  assert.equal(noPin.statusCode, 401, noPin.body)
  assert.equal(repoBackend('acme/switch'), 'github')
})

test('an owner re-POST of a connected repo with items, naming a new backend, returns 409; nothing changes', async () => {
  calls = []
  const res = await connect({ repo: 'acme/count', backend: 'sl' })
  assert.equal(res.statusCode, 409, res.body)
  assert.equal(repoBackend('acme/count'), 'github')
  assert.deepEqual(calls, [])
})

test('creating an item on an sl repo returns 400 backend_unsupported and calls no GitHub', async () => {
  db.prepare('UPDATE project SET enabled = 1 WHERE id = ?').run(P)
  calls = []
  const res = await send(owner, 'POST', '/api/items', { title: 'On sl', outcome: 'An outcome', metric: 'A metric', repo: 'acme/sl-app', projectId: P })
  assert.equal(res.statusCode, 400, res.body)
  assert.equal(res.json().error, 'backend_unsupported')
  assert.deepEqual(calls, [])
})

test('the GitHub poller never reads an sl repo: listRepos({ backend: github }) leaves it out', async () => {
  assert.ok(store.listRepos().some((r) => r.repo === 'acme/sl-app'))
  assert.equal(store.listRepos({ backend: 'github' }).some((r) => r.repo === 'acme/sl-app'), false)
  assert.ok(store.listRepos({ backend: 'github' }).some((r) => r.repo === 'acme/web'))
  const github = await import('../src/github.js')
  calls = []
  await github.pollOnce(null)
  assert.ok(calls.some((c) => c.includes('/repos/acme/web')), 'the github repos are polled')
  assert.equal(calls.filter((c) => c.includes('acme/sl-app')).length, 0, calls.join('\n'))
})

test('infra/host/DEPLOY.md documents both sl link template settings', () => {
  const runbook = readFileSync(new URL('../../infra/host/DEPLOY.md', import.meta.url), 'utf8')
  for (const name of ['HORIZON_SL_REPO_URL_TEMPLATE', 'HORIZON_SL_ISSUE_URL_TEMPLATE']) {
    assert.match(runbook, new RegExp(`\\| \`/etc/horizon/server\\.env\` \\| \`${name}\` \\|`), name)
  }
})
