// HZ-658: item writes and gates require membership. Every /api/items/:id/*
// write is `member:item` (the dependency pair `member:items`) and POST
// /api/items is `member:repo`, so a signed-in non-owner changes only items in
// projects they belong to. Anyone else gets the guard's 404 — the same one a
// missing item gets — before any handler code runs: no row is written and the
// overlap check is never reached. Gates still need the caller's own PIN too.
// Driven through app.inject with real sessions, so the real guard runs.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-item-write-membership-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire during these tests
process.env.FARM_STEP_TIMEOUT_MS = '600000'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.FARM_RECOVERY_POLL_MS = String(60 * 60 * 1000)
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_HOME

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const overlapService = await import('../src/overlapService.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { PERSONAS } = await import('../src/personas.js')
const { ensureUnlinkedProject } = await import('../src/membership.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const PRIORITIZE_GATE = requiredStepIndex('Approve & prioritize this work')
const SUMMARIZE = requiredStepIndex('Summarize reviews & recommend')
const REVIEW_GATE = requiredStepIndex('Review before execution')

// GitHub answers every issue create with a fresh number; the farm accepts
// every task. Both are recorded.
const githubCalls = []
const farmCalls = []
let issueNumber = 700
globalThis.fetch = async (url, opts) => {
  const u = String(url)
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data })
  const ok = (data) => reply(200, data)
  if (u.startsWith('https://api.github.com/')) {
    githubCalls.push(u)
    if (u.endsWith('/issues') && opts?.method === 'POST') {
      const n = ++issueNumber
      return ok({ number: n, title: JSON.parse(opts.body).title, body: '', html_url: `https://github.com/x/issues/${n}`, labels: [], state: 'open' })
    }
    return ok({})
  }
  const path = new URL(u).pathname
  farmCalls.push(path)
  if (path === '/farm/status') return reply(200, { status: 'running' })
  if (path === '/runs/alive') return reply(200, { alive: {} })
  return reply(200, { ok: true })
}

// Counts every overlap check; returns an empty check so step 9 carries on.
let overlapCalls = 0
overlapService.setComputeOverlapForTest(async (itemId) => {
  overlapCalls++
  return { repo: store.getItem(itemId)?.repo ?? null, self: { id: itemId, sourceLabel: 'test' }, results: [] }
})

orchestrator.init({ info: () => {}, warn: () => {}, error: () => {} })
const app = buildApp({ logger: false })
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Owner' })
const m = loginFixtureUser(auth, config, { email: 'member-a@example.com', name: 'Member A', role: 'member' })
const both = loginFixtureUser(auth, config, { email: 'member-ab@example.com', name: 'Member AB', role: 'member' })
await app.ready()

after(async () => {
  overlapService.setComputeOverlapForTest(null)
  for (const { item_id: id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(id)
  await app.close()
})

function project(name, repo, prefix) {
  const { id } = store.createProject(name)
  db.prepare('UPDATE project SET enabled = 1 WHERE id = ?').run(id)
  db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(id, repo, prefix)
  return id
}
const A = project('Alpha Writes', 'acme/alpha', 'ALW')
const B = project('Beta Writes', 'acme/beta', 'BEW')
const UNLINKED = ensureUnlinkedProject(db)

const insertItem = db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo, project_id) VALUES (?, ?, 'Medium', ?, ?, ?)")
function item(id, cursor, projectId, repo = null) {
  insertItem.run(id, `Title ${id}`, cursor, repo, projectId)
  return id
}
const ALPHA_GATE = item('ALW-1', PRIORITIZE_GATE, A, 'acme/alpha')
const BETA_GATE = item('BEW-1', PRIORITIZE_GATE, B, 'acme/beta')
const ALPHA_REVIEW = item('ALW-2', REVIEW_GATE, A, 'acme/alpha')
const ALPHA_DEP = item('ALW-3', 0, A)
const ALPHA_DEP2 = item('ALW-4', 0, A)
const BETA_DEP = item('BEW-2', 0, B)
const NULL_ITEM = item('NUL-1', 0, null)
const UNLINKED_ITEM = item('UNL-1', 0, UNLINKED)
// An edge the refused removals must leave in place.
db.prepare("INSERT INTO work_item_dependency (item_id, depends_on_id) VALUES (?, ?)").run(ALPHA_DEP, BETA_DEP)

const addMember = db.prepare('INSERT INTO project_member (project_id, user_id) VALUES (?, ?)')
addMember.run(A, m.user.id)
addMember.run(UNLINKED, m.user.id) // still nothing: `Unlinked items` is owner-only
addMember.run(A, both.user.id)
addMember.run(B, both.user.id)

const as = (who, pin = who.pin) => ({ cookie: who.cookie, 'x-human-key': pin })
const post = (url, who, payload, headers = as(who)) => app.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload }) })

const rows = (table, order = 'rowid') => db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).all()
const snapshot = () => ({
  event: rows('event'),
  gate_decision: rows('gate_decision'),
  work_item: rows('work_item'),
  work_item_dependency: rows('work_item_dependency'),
  step_run: rows('step_run'),
})
const decisions = (id) => db.prepare('SELECT * FROM gate_decision WHERE item_id = ?').all(id)
const edges = () => rows('work_item_dependency', 'item_id, depends_on_id').map((r) => `${r.item_id}->${r.depends_on_id}`)
const itemCount = () => db.prepare('SELECT COUNT(*) AS n FROM work_item').get().n

// Settles the async kick a gate action starts, without a fixed sleep.
async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((r) => setImmediate(r))
  }
  assert.fail(`never happened: ${what}`)
}

const NOT_FOUND = { error: 'not_found' }
const PLAN_DRAFT_DOC = JSON.parse(readFileSync(join(REPO_ROOT, 'domain/fixtures/plan-draft-cases.json'), 'utf8')).base

// One valid body and params per member:item route, so schema validation never
// answers 400 before the guard's 404.
const MEMBER_ITEM_ROUTES = {
  'PUT /api/items/:id/plan-draft': { payload: { base_version: 1, doc: PLAN_DRAFT_DOC } },
  'POST /api/items/:id/screenshots/approve': { payload: { commit: 'abc123', all: true } },
  'POST /api/items/:id/job/stop': {},
  'POST /api/items/:id/job/resume': {},
  'POST /api/items/:id/gates/:stepIndex/approve': { payload: {} },
  'POST /api/items/:id/reject': { payload: { feedback: 'no' } },
  'POST /api/items/:id/resolve-conflicts': {},
  'POST /api/items/:id/forward-to-accept': {},
  'POST /api/items/:id/feedback': { payload: { message: 'hello' } },
  'POST /api/items/:id/pause': { payload: { paused: true } },
  'POST /api/items/:id/persona': { payload: { agent: Object.keys(PERSONAS)[0], persona: 'generalist' } },
  'PUT /api/items/:id/steps/:stepIndex/provider': { payload: { provider: 'default' } },
  'POST /api/items/:id/priority': { payload: { priority: 'High' } },
  'POST /api/items/:id/autopilot-off': { payload: { off: true } },
  'POST /api/items/:id/phases/:phase/restart': { payload: {} },
  'POST /api/items/:id/abandon': { payload: { reason: 'drop it' } },
}
const fillUrl = (url, id) => url.replace(':id', id).replace(':stepIndex', String(PRIORITIZE_GATE)).replace(':phase', '1')

test('overlap spy is live: a member sending their own item back to step 9 runs the overlap check', async () => {
  const res = await post(`/api/items/${ALPHA_REVIEW}/reject`, m, { feedback: 'redo the summary', targetStepIndex: SUMMARIZE })
  assert.equal(res.statusCode, 200, res.body)
  await until(() => overlapCalls >= 1, 'the overlap check ran')
  await until(
    () => db.prepare("SELECT 1 FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(ALPHA_REVIEW, SUMMARIZE),
    'step 9 dispatched',
  )
})

test('metric 1: a non-member gets exactly 404 on every member:item route; nothing is written and no overlap check runs', async () => {
  const routes = app
    .routeScopes()
    .filter((r) => r.scope === 'member:item' && r.method !== 'GET' && r.method !== 'HEAD')
    .map((r) => `${r.method} ${r.url}`)
  assert.deepEqual(routes.sort(), Object.keys(MEMBER_ITEM_ROUTES).sort())
  assert.equal(routes.length, 16)

  const overlapBefore = overlapCalls
  const before = snapshot()
  for (const [key, { payload }] of Object.entries(MEMBER_ITEM_ROUTES)) {
    const [method, url] = key.split(' ')
    const res = await app.inject({ method, url: fillUrl(url, BETA_GATE), headers: as(m), ...(payload === undefined ? {} : { payload }) })
    assert.equal(res.statusCode, 404, `${key}: ${res.body}`)
    assert.deepEqual(res.json(), NOT_FOUND, key)
  }
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(snapshot(), before)
  assert.equal(overlapCalls, overlapBefore)
})

test('guardrail: membership never replaces the PIN — no PIN, or the owner’s PIN, is 401 on the member’s own item', async () => {
  const url = `/api/items/${ALPHA_GATE}/gates/${PRIORITIZE_GATE}/approve`
  const noPin = await post(url, m, {}, { cookie: m.cookie })
  assert.equal(noPin.statusCode, 401)
  assert.deepEqual(noPin.json(), { error: 'human_gate_key_required' })
  const ownersPin = await post(url, m, {}, as(m, owner.pin))
  assert.equal(ownersPin.statusCode, 401)
  assert.deepEqual(ownersPin.json(), { error: 'human_gate_key_required' })
  assert.deepEqual(decisions(ALPHA_GATE), [])
})

test('metric 2: a member with their own PIN approves a gate on an item in their project', async () => {
  const res = await post(`/api/items/${ALPHA_GATE}/gates/${PRIORITIZE_GATE}/approve`, m, {})
  assert.equal(res.statusCode, 200, res.body)
  const rows = decisions(ALPHA_GATE)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].step_index, PRIORITIZE_GATE)
  assert.equal(rows[0].decision, 'approved')
})

test('metric 3: a member’s valid PIN on another project’s approvable gate is 404 with no gate_decision row', async () => {
  const res = await post(`/api/items/${BETA_GATE}/gates/${PRIORITIZE_GATE}/approve`, m, {})
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), NOT_FOUND)
  assert.deepEqual(decisions(BETA_GATE), [])

  // The gate was approvable: the owner's own PIN approves that exact gate.
  const control = await post(`/api/items/${BETA_GATE}/gates/${PRIORITIZE_GATE}/approve`, owner, {})
  assert.equal(control.statusCode, 200, control.body)
  assert.equal(decisions(BETA_GATE).length, 1)
})

const NEW_ITEM = { title: 'New work for the members', outcome: 'Members can file their own work', metric: 'A test files one item and passes' }

test('metric 4: POST /api/items with a repo outside the caller’s projects is 404; no item and no GitHub call', async () => {
  const count = itemCount()
  const calls = githubCalls.length
  for (const [label, url, payload] of [
    ['another project’s repo', '/api/items', { ...NEW_ITEM, repo: 'acme/beta' }],
    ['own repo with another projectId', '/api/items', { ...NEW_ITEM, repo: 'acme/alpha', projectId: B }],
    ['body repo outside, query repo inside', '/api/items?repo=acme/alpha', { ...NEW_ITEM, repo: 'acme/beta' }],
    ['query repo inside, no body repo', '/api/items?repo=acme/alpha', { ...NEW_ITEM }],
  ]) {
    const res = await post(url, m, payload)
    assert.equal(res.statusCode, 404, `${label}: ${res.body}`)
    assert.deepEqual(res.json(), NOT_FOUND, label)
  }
  assert.equal(itemCount(), count)
  assert.equal(githubCalls.length, calls)
})

test('metric 4 control: a member creates an item in their own project’s repo', async () => {
  const count = itemCount()
  const res = await post('/api/items', m, { ...NEW_ITEM, repo: 'acme/alpha' })
  assert.equal(res.statusCode, 200, res.body)
  assert.match(res.json().id, /^ALW-\d+$/)
  assert.equal(itemCount(), count + 1)
  assert.equal(store.getItem(res.json().id).project_id, A)
})

test('metric 5: dependencies and dependencies/remove are 404 when either item is hidden; the edges do not change', async () => {
  const before = edges()
  assert.deepEqual(before, [`${ALPHA_DEP}->${BETA_DEP}`])
  for (const route of ['dependencies', 'dependencies/remove']) {
    for (const [id, dependsOnId] of [
      [ALPHA_DEP, BETA_DEP],
      [BETA_DEP, ALPHA_DEP],
    ]) {
      const res = await post(`/api/items/${id}/${route}`, m, { dependsOnId })
      assert.equal(res.statusCode, 404, `${route} ${id} -> ${dependsOnId}: ${res.body}`)
      assert.deepEqual(res.json(), NOT_FOUND)
    }
  }
  assert.deepEqual(edges(), before)
})

test('metric 5 control: a member of both projects adds, then removes, a cross-project dependency', async () => {
  const edge = `${ALPHA_DEP2}->${BETA_DEP}`
  const added = await post(`/api/items/${ALPHA_DEP2}/dependencies`, both, { dependsOnId: BETA_DEP })
  assert.equal(added.statusCode, 200, added.body)
  assert.ok(edges().includes(edge))
  const removed = await post(`/api/items/${ALPHA_DEP2}/dependencies/remove`, both, { dependsOnId: BETA_DEP })
  assert.equal(removed.statusCode, 200, removed.body)
  assert.ok(!edges().includes(edge))
})

test('guardrail: a non-member’s 404 matches a missing one’s — status, body and content-type', async () => {
  const same = (hidden, missing, label) => {
    assert.equal(hidden.statusCode, 404, label)
    assert.equal(missing.statusCode, 404, label)
    assert.deepEqual(hidden.json(), missing.json(), label)
    assert.equal(hidden.headers['content-type'], missing.headers['content-type'], label)
  }
  same(
    await post(`/api/items/${BETA_DEP}/pause`, m, { paused: true }),
    await post('/api/items/NOPE-404/pause', m, { paused: true }),
    'item',
  )
  same(
    await post('/api/items', m, { ...NEW_ITEM, repo: 'acme/beta' }),
    await post('/api/items', m, { ...NEW_ITEM, repo: 'acme/nowhere' }),
    'repo',
  )
  same(
    await post(`/api/items/${ALPHA_DEP}/dependencies`, m, { dependsOnId: BETA_DEP }),
    await post(`/api/items/${ALPHA_DEP}/dependencies`, m, { dependsOnId: 'NOPE-404' }),
    'dependsOnId',
  )
})

test('guardrail: an unscoped lookup gives a non-owner nothing — NULL project, `Unlinked items`, no repo', async () => {
  const before = snapshot()
  for (const id of [NULL_ITEM, UNLINKED_ITEM]) {
    const res = await post(`/api/items/${id}/pause`, m, { paused: true })
    assert.equal(res.statusCode, 404, id)
    assert.deepEqual(res.json(), NOT_FOUND, id)
  }
  const noRepo = await post('/api/items', m, NEW_ITEM)
  assert.equal(noRepo.statusCode, 404)
  assert.deepEqual(noRepo.json(), NOT_FOUND)
  assert.deepEqual(snapshot(), before)
})
