// HZ-208: the server side of the multi-project UI — exactly the four allowed
// exceptions. (a) POST /api/projects/:id/enabled is gate-PIN protected;
// (b) /activate never enables a project; (c) GET /api/items carries every
// enabled project's items (snapshot scope 'enabled'), never a disabled one's;
// (d) POST /api/items files into any enabled project's repo, and a disabled
// project's repo is refused before GitHub is called.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-projects-ui-scope-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const settings = await import('../src/settings.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { STEPS, awaitingGate } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

// The fake GitHub: counts issue creations, answers everything else with 200.
const issuePosts = []
let nextIssue = 100
globalThis.fetch = async (url, opts = {}) => {
  const { pathname } = new URL(String(url))
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data })
  const issueMatch = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(pathname)
  if (issueMatch && opts.method === 'POST') {
    const body = JSON.parse(opts.body)
    const number = nextIssue++
    issuePosts.push({ repo: issueMatch[1], number })
    return reply(201, {
      number,
      title: body.title,
      body: body.body,
      state: 'open',
      labels: [],
      html_url: `https://github.com/${issueMatch[1]}/issues/${number}`,
    })
  }
  return reply(200, [])
}

const app = buildApp({ logger: false })
const alice = loginFixtureUser(auth, config)
await app.ready()

const asAlice = (opts, extra = {}) => app.inject({ ...opts, headers: { cookie: alice.cookie, ...extra } })
const enabledOf = (id) => db.prepare('SELECT enabled FROM project WHERE id = ?').get(id).enabled
const itemCount = () => db.prepare('SELECT COUNT(*) AS n FROM work_item').get().n

const GATE = STEPS.findIndex((s) => s.kind === 'gate')

// Three projects: Alpha is first (active, enabled), Beta is enabled, Gamma
// stays disabled. Two gate-waiting items each, plus one non-gate item in Alpha.
const alpha = store.createProject('Alpha').id
const beta = store.createProject('Beta').id
const gamma = store.createProject('Gamma').id
store.setProjectEnabled(beta, true)
assert.equal(settings.getActiveProjectId(), alpha, 'active_project_id is set, so the disabled exclusion is exercised')
store.addRepoToProject(alpha, 'Org/alpha-repo')
store.addRepoToProject(beta, 'Org/beta-repo')
store.addRepoToProject(gamma, 'Org/gamma-repo')

const insert = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, project_id) VALUES (?, ?, ?, ?, ?, ?)')
for (const [id, cursor, repo, project] of [
  ['AR-1', GATE, 'Org/alpha-repo', alpha],
  ['AR-2', GATE, 'Org/alpha-repo', alpha],
  ['AR-3', GATE + 1, 'Org/alpha-repo', alpha],
  ['BR-1', GATE, 'Org/beta-repo', beta],
  ['BR-2', GATE, 'Org/beta-repo', beta],
  ['GR-1', GATE, 'Org/gamma-repo', gamma],
  ['GR-2', GATE, 'Org/gamma-repo', gamma],
]) {
  insert.run(id, `Fixture ${id}`, 'Medium', cursor, repo, project)
}

async function listedItems() {
  const res = await asAlice({ method: 'GET', url: '/api/items' })
  assert.equal(res.statusCode, 200)
  return res.json().items
}

// ---- (c) metric 4 / guardrail 5: every enabled project, never a disabled one ----

test('GET /api/items: items from both enabled projects, none from the disabled one, and the exact gate-waiting count', async () => {
  const items = (await listedItems()).filter((it) => it.project_id != null)
  assert.deepEqual(items.map((it) => it.id).sort(), ['AR-1', 'AR-2', 'AR-3', 'BR-1', 'BR-2'])
  assert.equal(items.filter(awaitingGate).length, 4)
})

test('snapshot scopes: the SSE/items feed is "enabled"; the farm snapshot keeps the active project only', async () => {
  const farm = await app.inject({ method: 'GET', url: '/api/farm/snapshot', headers: { 'x-farm-secret': config.FARM_SHARED_SECRET } })
  assert.equal(farm.statusCode, 200)
  assert.deepEqual(
    farm.json().items.filter((it) => it.project_id != null).map((it) => it.id).sort(),
    ['AR-1', 'AR-2', 'AR-3'],
  )
  assert.deepEqual(
    store.listItems({ scope: 'enabled' }).map((it) => it.id).sort(),
    (await listedItems()).map((it) => it.id).sort(),
  )
})

test('re-enabling the disabled project brings its items back', async () => {
  store.setProjectEnabled(gamma, true)
  try {
    assert.ok((await listedItems()).some((it) => it.id === 'GR-1'))
  } finally {
    store.setProjectEnabled(gamma, false)
  }
  assert.ok(!(await listedItems()).some((it) => it.id === 'GR-1'))
})

test('no active project chosen: every item is listed (the legacy rule)', async () => {
  const saved = settings.getActiveProjectId()
  db.prepare("DELETE FROM setting WHERE key = 'active_project_id'").run()
  try {
    assert.equal(settings.getActiveProjectId(), null)
    const ids = (await listedItems()).map((it) => it.id)
    for (const id of ['AR-1', 'BR-1', 'GR-1']) assert.ok(ids.includes(id), id)
  } finally {
    settings.setSetting('active_project_id', String(saved))
  }
})

// ---- (a) metric 5 / guardrail 2a: the gate PIN on /enabled ----

test('POST /api/projects/:id/enabled: no PIN, a wrong PIN or a bearer token is 401 and the state is unchanged', async () => {
  const created = await asAlice({ method: 'POST', url: '/api/tokens', payload: { name: 'ci-bot' } })
  assert.equal(created.statusCode, 201, created.body)
  const token = created.json().token
  const url = `/api/projects/${gamma}/enabled`
  const cases = [
    ['no PIN', { cookie: alice.cookie }],
    ['wrong PIN', { cookie: alice.cookie, 'x-human-key': 'not-the-pin' }],
    ['bearer token + correct PIN', { authorization: `Bearer ${token}`, 'x-human-key': alice.pin }],
  ]
  for (const [label, headers] of cases) {
    const res = await app.inject({ method: 'POST', url, headers, payload: { enabled: true } })
    assert.equal(res.statusCode, 401, label)
    assert.deepEqual(res.json(), { error: 'human_gate_key_required' }, label)
    assert.equal(enabledOf(gamma), 0, label)
  }
})

test('POST /api/projects/:id/enabled: the correct PIN flips it both ways with the unchanged { ok, enabled } body', async () => {
  const url = `/api/projects/${gamma}/enabled`
  const on = await asAlice({ method: 'POST', url, payload: { enabled: true } }, { 'x-human-key': alice.pin })
  assert.equal(on.statusCode, 200)
  assert.deepEqual(on.json(), { ok: true, enabled: true })
  assert.equal(enabledOf(gamma), 1)
  const off = await asAlice({ method: 'POST', url, payload: { enabled: false } }, { 'x-human-key': alice.pin })
  assert.equal(off.statusCode, 200)
  assert.deepEqual(off.json(), { ok: true, enabled: false })
  assert.equal(enabledOf(gamma), 0)
})

test('POST /api/projects/:id/enabled: a bad PIN on an unknown id is 401, not 404; a malformed body is 400 and changes nothing', async () => {
  const none = await asAlice({ method: 'POST', url: '/api/projects/999999/enabled', payload: { enabled: true } }, { 'x-human-key': 'nope' })
  assert.equal(none.statusCode, 401)
  const malformed = await asAlice({ method: 'POST', url: `/api/projects/${gamma}/enabled`, payload: { enabled: 'yes' } }, { 'x-human-key': 'nope' })
  assert.equal(malformed.statusCode, 400)
  assert.equal(enabledOf(gamma), 0)
})

// ---- (b) guardrail 2b: activating never enables ----

test('POST /api/projects/:id/activate on a disabled project leaves it disabled', async () => {
  try {
    const res = await asAlice({ method: 'POST', url: `/api/projects/${gamma}/activate`, payload: {} })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true, restarting: false })
    assert.equal(enabledOf(gamma), 0)
  } finally {
    settings.setSetting('active_project_id', String(alpha))
  }
})

// ---- (d) metric 6: POST /api/items files into enabled projects' repos only ----

const NEW_ITEM = { title: 'New work', outcome: 'A clear outcome for the work', metric: 'Measured somehow' }

test('POST /api/items: a disabled project’s repo is 400 with no GitHub call and no new row', async () => {
  const before = { posts: issuePosts.length, rows: itemCount() }
  const res = await asAlice({ method: 'POST', url: '/api/items', payload: { ...NEW_ITEM, repo: 'Org/gamma-repo' } })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { error: 'That repository’s project is disabled' })
  assert.deepEqual({ posts: issuePosts.length, rows: itemCount() }, before)
})

test('POST /api/items: an unknown repo, or no repo with two enabled repos, is 400 with no GitHub call', async () => {
  const before = issuePosts.length
  const unknown = await asAlice({ method: 'POST', url: '/api/items', payload: { ...NEW_ITEM, repo: 'Org/nope' } })
  assert.equal(unknown.statusCode, 400)
  assert.notEqual(unknown.json().error, 'That repository’s project is disabled')
  const ambiguous = await asAlice({ method: 'POST', url: '/api/items', payload: NEW_ITEM })
  assert.equal(ambiguous.statusCode, 400)
  assert.equal(issuePosts.length, before)
})

test('POST /api/items: a non-active enabled project’s repo files the item with that repo and project', async () => {
  const res = await asAlice({ method: 'POST', url: '/api/items', payload: { ...NEW_ITEM, repo: 'Org/beta-repo' } })
  assert.equal(res.statusCode, 200, res.body)
  const { id, issue } = res.json()
  assert.deepEqual(issuePosts.at(-1), { repo: 'Org/beta-repo', number: issue })
  const filed = (await listedItems()).find((it) => it.id === id)
  assert.equal(filed.repo, 'Org/beta-repo')
  assert.equal(filed.project_id, beta)
})

test('POST /api/items: one enabled repo and no repo given keeps today’s default; none enabled is 400, never a local item', async () => {
  store.setProjectEnabled(beta, false)
  try {
    const res = await asAlice({ method: 'POST', url: '/api/items', payload: NEW_ITEM })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(issuePosts.at(-1).repo, 'Org/alpha-repo')

    db.prepare('UPDATE project SET enabled = 0 WHERE id = ?').run(alpha)
    const before = { posts: issuePosts.length, rows: itemCount() }
    const none = await asAlice({ method: 'POST', url: '/api/items', payload: NEW_ITEM })
    assert.equal(none.statusCode, 400)
    assert.deepEqual({ posts: issuePosts.length, rows: itemCount() }, before)
  } finally {
    db.prepare('UPDATE project SET enabled = 1 WHERE id IN (?, ?)').run(alpha, beta)
  }
})
