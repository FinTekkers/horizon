// HZ-398: choose the model, not just the provider, per step — per item
// (PUT /api/items/:id/steps/:stepIndex/provider) and as a project default
// (PUT /api/projects/:id/step-providers/:stepIndex). A stored value is a bare
// provider (HZ-357's form, unchanged) or "<provider>:<model id>"; both routes
// accept exactly what domain/providers.json's choiceValues() lists.
//
// Every model id here is read from domain/providers.json. Its own file because
// config.js reads the environment at import time.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-step-model-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const appModule = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { STEPS, requiredStepIndex, DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { choiceValues } = await import('../../domain/js/providers.js')

store.purgeDemoItems()

const catalogue = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/providers.json'), 'utf8'))
const byName = Object.fromEntries(catalogue.providers.map((p) => [p.name, p]))
const selectable = (name) => byName[name].models.filter((m) => m.selectable).map((m) => m.id)
const SONNET = selectable('claude').find((id) => id.includes('sonnet'))
const HAIKU = selectable('claude').find((id) => id.includes('haiku'))
const UNSELECTABLE = byName.claude.models.find((m) => !m.selectable).id
const MUSE_ID = selectable('muse')[0]
const CLAUDE_ID = selectable('claude')[0]
// Exactly "default", each bare provider name, and each selectable provider:id.
const EXPECTED_VALUES = [
  'default',
  ...catalogue.providers.map((p) => p.name),
  ...catalogue.providers.flatMap((p) => p.models.filter((m) => m.selectable).map((m) => `${p.name}:${m.id}`)),
]

const dispatches = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith('http://farm.test')) return realFetch(url, opts)
  dispatches.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  if (String(url).includes('/runs/status')) return { ok: true, json: async () => ({ states: {} }) }
  return { ok: true, json: async () => ({}) }
}
orchestrator.init({ info: () => {}, warn: () => {} })

const app = appModule.buildApp({ logger: false })
const user = loginFixtureUser(auth, config)
await app.ready()
after(() => app.close())

const ARCH = requiredStepIndex('Architecture review')
const QA = requiredStepIndex('QA reviews the test plan')
const project = store.createProject('Model choices')
store.setProjectEnabled(project.id, true)

const putItem = (id, stepIndex, provider) =>
  app.inject({ method: 'PUT', url: `/api/items/${id}/steps/${stepIndex}/provider`, payload: { provider }, headers: { cookie: user.cookie } })
const putProject = (stepIndex, provider) =>
  app.inject({
    method: 'PUT',
    url: `/api/projects/${project.id}/step-providers/${stepIndex}`,
    payload: { provider },
    headers: { cookie: user.cookie, 'x-human-key': user.pin },
  })
const insertItem = (id, cursor, choices = null) =>
  db
    .prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, provider_choices_json) VALUES (?, ?, 'Medium', ?, ?, ?)")
    .run(id, id, cursor, project.id, choices == null ? null : JSON.stringify(choices))
const setProjectDefaults = (defaults) =>
  db.prepare('UPDATE project SET provider_defaults_json = ? WHERE id = ?').run(defaults == null ? null : JSON.stringify(defaults), project.id)
const itemColumn = (id) => db.prepare('SELECT provider_choices_json AS v FROM work_item WHERE id = ?').get(id).v
const projectColumn = () => db.prepare('SELECT provider_defaults_json AS v FROM project WHERE id = ?').get(project.id).v
const eventTexts = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((r) => r.text)
const outputsOf = async (id) =>
  (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: user.cookie } })).json().items.find((it) => it.id === id)
    .stepOutputs
const sentFor = (id) => dispatches.filter((d) => d.url.endsWith('/steps/run') && d.body?.item?.id === id)

async function dispatched(id) {
  orchestrator.kick(id)
  for (let i = 0; i < 200 && sentFor(id).length === 0; i++) await sleep(10)
  assert.equal(sentFor(id).length, 1, `${id} was not dispatched`)
  orchestrator.cancel(id)
  return sentFor(id)[0].body
}

test('sanity: the catalogue has what these cases need', () => {
  for (const v of [SONNET, HAIKU, UNSELECTABLE, MUSE_ID, CLAUDE_ID]) assert.equal(typeof v, 'string')
  for (const i of [ARCH, QA]) assert.equal(STEPS[i].providerOverrideEligible, true)
  assert.equal(STEPS[DEPLOY_STEP_INDEX].providerOverrideEligible, false)
})

// ---- metric 1: both routes accept exactly Default plus the catalogue's choices ----

test('the routes offer exactly default + bare names + selectable provider:id, read from domain/providers.json', () => {
  assert.deepEqual(['default', ...choiceValues()], EXPECTED_VALUES)
})

test('the item route accepts every catalogue value and refuses unselectable, undeclared and cross-provider ones', async () => {
  insertItem('MC-1', ARCH)
  for (const value of EXPECTED_VALUES) {
    const res = await putItem('MC-1', ARCH, value)
    assert.equal(res.statusCode, 200, `${value}: ${res.body}`)
  }
  for (const value of [`claude:${UNSELECTABLE}`, 'claude:claude-opus-9-9', `muse:${CLAUDE_ID}`, `claude:${MUSE_ID}`, 'claude:', 'zeta']) {
    assert.equal((await putItem('MC-1', ARCH, value)).statusCode, 400, value)
  }
})

test('the project route accepts every catalogue value and refuses the same ones', async () => {
  for (const value of EXPECTED_VALUES) {
    const res = await putProject(QA, value)
    assert.equal(res.statusCode, 200, `${value}: ${res.body}`)
  }
  for (const value of [`claude:${UNSELECTABLE}`, 'claude:claude-opus-9-9', `muse:${CLAUDE_ID}`]) {
    assert.equal((await putProject(QA, value)).statusCode, 400, value)
  }
  assert.equal((await putProject(QA, 'default')).statusCode, 200)
})

test('a model choice saves, reads back, and its event names the model by its catalogue label', async () => {
  insertItem('MC-2', ARCH)
  assert.equal((await putItem('MC-2', ARCH, `claude:${SONNET}`)).statusCode, 200)
  assert.deepEqual(store.getItem('MC-2').providerChoices, { [ARCH]: `claude:${SONNET}` })
  const label = byName.claude.models.find((m) => m.id === SONNET).label
  assert.ok(eventTexts('MC-2').some((t) => t.endsWith(`to run on ${byName.claude.label} · ${label}`)), eventTexts('MC-2').join('\n'))
})

// ---- guardrail: deploy stays on its default provider and model ----

test('deploy refuses a model choice on both routes, and a DB-seeded one is never dispatched', async () => {
  insertItem('MC-3', ARCH)
  for (const res of [await putItem('MC-3', DEPLOY_STEP_INDEX, `claude:${SONNET}`), await putProject(DEPLOY_STEP_INDEX, `claude:${SONNET}`)]) {
    assert.equal(res.statusCode, 400)
    assert.deepEqual(res.json(), { error: 'provider_not_eligible' })
  }
  db.prepare('UPDATE work_item SET provider_choices_json = ? WHERE id = ?').run(JSON.stringify({ [DEPLOY_STEP_INDEX]: `claude:${SONNET}` }), 'MC-3')
  setProjectDefaults({ [DEPLOY_STEP_INDEX]: `claude:${HAIKU}` })
  assert.deepEqual(store.getItem('MC-3').providerChoices, {})
  const body = await dispatched('MC-3')
  assert.deepEqual(body.item.providerChoices, {})
  setProjectDefaults(null)
})

// ---- metric 2: item choice, then project default ----

test('an item model choice beats the project default model', async () => {
  setProjectDefaults({ [ARCH]: `claude:${HAIKU}` })
  insertItem('MC-4', ARCH, { [ARCH]: `claude:${SONNET}` })
  assert.deepEqual((await dispatched('MC-4')).item.providerChoices, { [ARCH]: `claude:${SONNET}` })
  setProjectDefaults(null)
})

test('a bare item "claude" beats a project model default — the models block runs, not the project model', async () => {
  setProjectDefaults({ [ARCH]: `claude:${SONNET}` })
  insertItem('MC-5', ARCH, { [ARCH]: 'claude' })
  assert.deepEqual((await dispatched('MC-5')).item.providerChoices, { [ARCH]: 'claude' })
  setProjectDefaults(null)
})

test('with no item choice the project default model reaches the farm', async () => {
  setProjectDefaults({ [ARCH]: `claude:${HAIKU}` })
  insertItem('MC-6', ARCH)
  assert.deepEqual((await dispatched('MC-6')).item.providerChoices, { [ARCH]: `claude:${HAIKU}` })
  setProjectDefaults(null)
})

// ---- metric 5: a stored model no longer declared falls back to Default ----

test('a stale item choice is dropped, warned about once, and its row is left as stored', async () => {
  const stored = JSON.stringify({ [ARCH]: 'claude:claude-gone' })
  insertItem('MC-7', ARCH, { [ARCH]: 'claude:claude-gone' })
  const body = await dispatched('MC-7')
  assert.deepEqual(body.item.providerChoices, {})
  assert.ok(!JSON.stringify(body).includes('claude-gone'), 'the undeclared id reached the farm')
  const warnings = eventTexts('MC-7').filter((t) => t.includes('claude:claude-gone'))
  assert.equal(warnings.length, 1, eventTexts('MC-7').join('\n'))
  assert.match(warnings[0], /no longer declared .* running on Default/)
  assert.ok(warnings[0].includes(STEPS[ARCH].label))
  assert.equal(itemColumn('MC-7'), stored)
})

test('a stale project default is dropped, warned about once, and the project row is left as stored', async () => {
  const stored = JSON.stringify({ [ARCH]: 'muse:muse-gone' })
  db.prepare('UPDATE project SET provider_defaults_json = ? WHERE id = ?').run(stored, project.id)
  insertItem('MC-8', ARCH)
  const body = await dispatched('MC-8')
  assert.deepEqual(body.item.providerChoices, {})
  assert.ok(!JSON.stringify(body).includes('muse-gone'))
  const warnings = eventTexts('MC-8').filter((t) => t.includes('muse:muse-gone'))
  assert.equal(warnings.length, 1, eventTexts('MC-8').join('\n'))
  assert.match(warnings[0], /project default/)
  assert.equal(projectColumn(), stored)
  setProjectDefaults(null)
})

test('a stale project default the item overrides with its own choice is not warned about', async () => {
  db.prepare('UPDATE project SET provider_defaults_json = ? WHERE id = ?').run(JSON.stringify({ [ARCH]: 'claude:claude-gone' }), project.id)
  insertItem('MC-9', ARCH, { [ARCH]: `claude:${SONNET}` })
  assert.deepEqual((await dispatched('MC-9')).item.providerChoices, { [ARCH]: `claude:${SONNET}` })
  assert.deepEqual(eventTexts('MC-9').filter((t) => t.includes('claude-gone')), [])
  setProjectDefaults(null)
})

test('staleStepChoices ignores bare values, valid choices, unknown providers and ineligible steps', () => {
  const json = JSON.stringify({
    [ARCH]: 'claude',
    [QA]: `muse:${MUSE_ID}`,
    0: 'gpt:x',
    [DEPLOY_STEP_INDEX]: 'claude:claude-gone',
    1: `claude:${UNSELECTABLE}`,
  })
  assert.deepEqual(store.staleStepChoices(json), [{ step: 1, value: `claude:${UNSELECTABLE}` }])
  assert.deepEqual(store.staleStepChoices('not json'), [])
  assert.deepEqual(store.staleStepChoices(null), [])
})

// ---- guardrail: stored HZ-357/HZ-370 choices resolve as before and are not rewritten ----

test('legacy "claude" and "muse" rows dispatch unchanged and stay byte-identical', async () => {
  const projectStored = JSON.stringify({ [QA]: 'muse' })
  db.prepare('UPDATE project SET provider_defaults_json = ? WHERE id = ?').run(projectStored, project.id)
  const itemStored = JSON.stringify({ [ARCH]: 'claude' })
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, provider_choices_json) VALUES ('MC-10', 'MC-10', 'Medium', ?, ?, ?)").run(
    ARCH,
    project.id,
    itemStored,
  )
  const body = await dispatched('MC-10')
  assert.deepEqual(body.item.providerChoices, { [ARCH]: 'claude', [QA]: 'muse' })
  assert.equal(itemColumn('MC-10'), itemStored)
  assert.equal(projectColumn(), projectStored)
  assert.deepEqual(eventTexts('MC-10').filter((t) => t.includes('no longer declared')), [])
  setProjectDefaults(null)
})

// ---- metric 4: step_run records the model that ran ----

test('a step that ran on Sonnet stores the Sonnet id beside the provider, and the output reader returns it', async () => {
  insertItem('MC-11', ARCH, { [ARCH]: `claude:${SONNET}` })
  const runId = db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)')
    .run('MC-11', ARCH, STEPS[ARCH].agent).lastInsertRowid
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'reviewed',
    artifacts: { artifact_md: '# review', provider: 'claude', model: SONNET, command_id: null },
  })
  assert.deepEqual(result, { ok: true })
  orchestrator.cancel('MC-11')
  assert.deepEqual(db.prepare('SELECT provider, model FROM step_run WHERE id = ?').get(runId), { provider: 'claude', model: SONNET })
  const outputs = await outputsOf('MC-11')
  assert.equal(outputs[ARCH].provider, 'claude')
  assert.equal(outputs[ARCH].model, SONNET)
})

test('a farm that reports no model leaves step_run.model NULL', async () => {
  insertItem('MC-12', ARCH)
  const runId = db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)')
    .run('MC-12', ARCH, STEPS[ARCH].agent).lastInsertRowid
  await orchestrator.completeFarmRun(runId, { summary: 'reviewed', artifacts: { artifact_md: '# r', provider: 'claude' } })
  orchestrator.cancel('MC-12')
  assert.equal(db.prepare('SELECT model FROM step_run WHERE id = ?').get(runId).model, null)
  assert.equal((await outputsOf('MC-12'))[ARCH].model, null)
})
