// HZ-370: a project's default "Runs on" per step (Admin), used when an item
// has no choice of its own — steps 0-2 run as soon as an item is filed, before
// anyone can open it. PUT /api/projects/:id/step-providers/:stepIndex saves
// it (PIN-gated, like Autopilot); listProjects() carries it as
// providerDefaults; at dispatch resolveStepProviders() merges it under the
// item's own choices into the task's providerChoices.
//
// The database is created in the pre-HZ-370 shape first, so the migration is
// exercised on a real existing row: it comes out with no default.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-project-step-provider-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
delete process.env.GITHUB_WEBHOOK_SECRET

const old = new Database(process.env.HORIZON_DB)
old.exec(`
  CREATE TABLE project (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 0);
  INSERT INTO project (name, enabled) VALUES ('Existing', 1);
`)
old.close()

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { STEPS, requiredStepIndex, DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

// The farm records every dispatch; GitHub answers an issue creation.
const dispatches = []
let nextIssue = 100
globalThis.fetch = async (url, opts = {}) => {
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data })
  if (String(url).startsWith('http://farm.test')) {
    dispatches.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null })
    if (String(url).includes('/runs/status')) return reply(200, { states: {} })
    if (String(url).endsWith('/farm/status')) return reply(200, { status: 'running' })
    return reply(200, {})
  }
  const { pathname } = new URL(String(url))
  const issueMatch = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(pathname)
  if (issueMatch && opts.method === 'POST') {
    const body = JSON.parse(opts.body)
    const number = nextIssue++
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
orchestrator.init({ info: () => {}, warn: () => {} })

const app = buildApp({ logger: false })
const alice = loginFixtureUser(auth, config)
await app.ready()

const EXISTING = 1
const OUTCOME = 0 // step 0, checked against the table below
const METRIC = requiredStepIndex('Define how we measure success')
const GATE = requiredStepIndex('Approve & prioritize this work')
const defaultsColumn = (id) => db.prepare('SELECT provider_defaults_json AS v FROM project WHERE id = ?').get(id).v
const eventsOf = (id) =>
  db.prepare("SELECT old_value, new_value FROM project_event WHERE project_id = ? AND kind = 'step_provider' ORDER BY id").all(id)
const asSession = (pin) => ({ cookie: alice.cookie, ...(pin === undefined ? {} : { 'x-human-key': pin }) })
const put = (id, stepIndex, payload, headers = asSession(alice.pin)) =>
  app.inject({ method: 'PUT', url: `/api/projects/${id}/step-providers/${stepIndex}`, payload, headers })
const providerDefaultsOf = (id) => store.listProjects().find((p) => p.id === id).providerDefaults

test('sanity: the indices under test are what the step table says they are', () => {
  assert.equal(STEPS[OUTCOME].runsIn, 'pm')
  for (const i of [OUTCOME, METRIC]) assert.equal(STEPS[i].providerOverrideEligible, true, `step ${i}`)
  assert.equal(STEPS[DEPLOY_STEP_INDEX].providerOverrideEligible, false)
  assert.equal(STEPS[GATE].kind, 'gate')
})

// ---- guardrail 2: existing projects never default to Muse ----

test('an existing project migrates to no default, and its items dispatch their own choices unchanged', () => {
  assert.equal(defaultsColumn(EXISTING), null)
  assert.deepEqual(providerDefaultsOf(EXISTING), {})
  const project = db.prepare('SELECT * FROM project WHERE id = ?').get(EXISTING)
  assert.deepEqual(store.resolveStepProviders({}, store.providerDefaultsFromRow(project)), {})
  assert.deepEqual(store.resolveStepProviders({ 7: 'muse' }, store.providerDefaultsFromRow(project)), { 7: 'muse' })
})

// ---- metric 3: item choice, then project default, then today's routing ----

test('resolveStepProviders: the item choice wins, then the project default, then nothing', () => {
  const cases = [
    { name: 'item claude beats project muse', item: { 0: 'claude' }, project: { 0: 'muse' }, want: { 0: 'claude' } },
    { name: 'item muse beats project claude', item: { 0: 'muse' }, project: { 0: 'claude' }, want: { 0: 'muse' } },
    { name: 'a project default alone applies', item: {}, project: { 0: 'muse' }, want: { 0: 'muse' } },
    { name: 'neither set is today’s routing', item: {}, project: {}, want: {} },
  ]
  for (const { name, item, project, want } of cases) {
    assert.deepEqual(store.resolveStepProviders(item, project), want, name)
  }
})

// ---- the route (metric 2, guardrail 3) ----

for (const [name, headers] of [
  ['a missing PIN', asSession()],
  ['a wrong PIN', asSession('0000-wrong')],
]) {
  test(`${name} is 401 and leaves the default unchanged`, async () => {
    const res = await put(EXISTING, OUTCOME, { provider: 'muse' }, headers)
    assert.equal(res.statusCode, 401)
    assert.equal(defaultsColumn(EXISTING), null)
    assert.deepEqual(eventsOf(EXISTING), [])
  })
}

test('an unknown provider or an extra body key is a schema 400 and saves nothing', async () => {
  for (const payload of [{ provider: 'gpt' }, { provider: 'muse', extra: 1 }]) {
    const res = await put(EXISTING, OUTCOME, payload)
    assert.equal(res.statusCode, 400, JSON.stringify(payload))
    assert.notEqual(res.json().error, 'provider_not_eligible')
  }
  assert.equal(defaultsColumn(EXISTING), null)
})

test('an unknown project is 404', async () => {
  const res = await put(999, OUTCOME, { provider: 'muse' })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'Project not found' })
})

test('deploy and a gate step are 400 provider_not_eligible, on the server, and nothing is saved', async () => {
  for (const stepIndex of [DEPLOY_STEP_INDEX, GATE, STEPS.length + 5]) {
    const res = await put(EXISTING, stepIndex, { provider: 'muse' })
    assert.equal(res.statusCode, 400, `step ${stepIndex}`)
    assert.deepEqual(res.json(), { error: 'provider_not_eligible' })
  }
  assert.equal(defaultsColumn(EXISTING), null)
  assert.deepEqual(eventsOf(EXISTING), [])
})

test('the right PIN saves Muse for step 0, a fresh read returns it, and Default clears it to NULL', async () => {
  const res = await put(EXISTING, OUTCOME, { provider: 'muse' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, projectId: EXISTING, stepIndex: OUTCOME, old: 'default', new: 'muse' })
  assert.deepEqual(providerDefaultsOf(EXISTING), { [OUTCOME]: 'muse' })
  // What Admin reads after a reload: the snapshot's projects.
  const listed = (await app.inject({ method: 'GET', url: '/api/items?v=2', headers: asSession() })).json()
  const fromApi = listed.projects.find((p) => p.id === EXISTING)
  assert.deepEqual(fromApi.providerDefaults, { [OUTCOME]: 'muse' })
  assert.deepEqual(eventsOf(EXISTING), [{ old_value: `${OUTCOME}:default`, new_value: `${OUTCOME}:muse` }])

  const back = await put(EXISTING, OUTCOME, { provider: 'default' })
  assert.deepEqual(back.json(), { ok: true, projectId: EXISTING, stepIndex: OUTCOME, old: 'muse', new: 'default' })
  assert.equal(defaultsColumn(EXISTING), null)
  assert.deepEqual(providerDefaultsOf(EXISTING), {})
})

test('a stored default for deploy or an unknown provider is never read back', () => {
  const row = { provider_defaults_json: JSON.stringify({ [DEPLOY_STEP_INDEX]: 'muse', [OUTCOME]: 'gpt', [METRIC]: 'muse' }) }
  assert.deepEqual(store.providerDefaultsFromRow(row), { [METRIC]: 'muse' })
})

// ---- metric 3: a newly filed item runs step 0 on the project default ----

test('a newly filed item in a project whose step 0 default is Muse dispatches step 0 with providerChoices {"0":"muse"}', async () => {
  const project = store.createProject('Muse Default')
  store.setProjectEnabled(project.id, true)
  store.addRepoToProject(project.id, 'Org/muse-repo')
  assert.equal((await put(project.id, OUTCOME, { provider: 'muse' })).statusCode, 200)

  const res = await app.inject({
    method: 'POST',
    url: '/api/items',
    headers: asSession(),
    payload: { title: 'Filed fresh', outcome: 'A clear outcome', metric: 'Measured', repo: 'Org/muse-repo' },
  })
  assert.equal(res.statusCode, 200, res.body)
  const { id } = res.json()
  assert.deepEqual(store.getItem(id).providerChoices, {}, 'no item choice: the default is not copied onto the item')

  const sentFor = () => dispatches.filter((d) => d.url.endsWith('/steps/run') && d.body?.item?.id === id)
  for (let i = 0; i < 200 && sentFor().length === 0; i++) await sleep(10)
  assert.equal(sentFor().length, 1)
  assert.equal(sentFor()[0].body.step.index, OUTCOME)
  assert.deepEqual(sentFor()[0].body.item.providerChoices, { [OUTCOME]: 'muse' })
  orchestrator.cancel(id)
})
