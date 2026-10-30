// HZ-654: `Unlinked items` holds the items that used to have no project. At
// every site that tested for a NULL project_id, its items behave as a NULL item
// did: listed in every scope, read as no project by the API, global personas,
// no golden cases, no project defaults or Autopilot, and no project in the farm
// payload. By the owner's ruling of 30 Oct it is otherwise an ordinary project:
// disabled, its items still show but are not dispatched.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const farmDir = mkdtempSync(join(tmpdir(), 'horizon-unlinked-farm-'))
process.env.HORIZON_FARM_DIR = farmDir
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-unlinked-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire during these tests
process.env.FARM_STEP_TIMEOUT_MS = '600000'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.FARM_RECOVERY_POLL_MS = String(60 * 60 * 1000)
delete process.env.GITHUB_WEBHOOK_SECRET

const CLAUDE_MODEL = (await import('../../domain/js/providers.js')).PROVIDERS.find((p) => p.name === 'claude').models[0].id
const QUANT = { id: 'quant', agent: 'eng', label: 'Quant', initials: 'QT', color: '#2E6CB2', model: CLAUDE_MODEL, provider: 'claude', file: 'quant.md' }
for (const slug of ['unlinked-items', 'acme']) {
  mkdirSync(join(farmDir, 'projects', slug, 'personas'), { recursive: true })
  writeFileSync(join(farmDir, 'projects', slug, 'personas.json'), JSON.stringify({ personas: [QUANT] }))
  writeFileSync(join(farmDir, 'projects', slug, 'personas', 'quant.md'), 'Think like a quant.\n')
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const settings = await import('../src/settings.js')
const orchestrator = await import('../src/orchestrator.js')
const golden = await import('../src/goldenCases.js')
const { productivityReport } = await import('../src/productivity.js')
const { unlinkedProjectId } = await import('../src/membership.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
const inject = (opts) => app.inject({ ...opts, headers: { 'x-human-key': pin, ...opts.headers, cookie } })
await app.ready()

const calls = []
globalThis.fetch = async (url, opts) => {
  const path = new URL(String(url)).pathname
  const body = opts?.body ? JSON.parse(opts.body) : null
  calls.push({ path, body })
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data })
  if (path === '/farm/status') return reply(200, { status: 'running' })
  if (path === '/runs/alive') return reply(200, { alive: Object.fromEntries((body.run_ids || []).map((id) => [id, true])) })
  return reply(200, { ok: true })
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} }
after(async () => {
  for (const { item_id: id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(id)
  await app.close()
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const posted = (itemId) => calls.filter((c) => c.path === '/steps/run' && c.body.item.id === itemId)
const row = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
const view = (id, scope) => store.listItems({ scope, stepOutputs: false }).find((it) => it.id === id)
async function until(predicate, what) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
    await wait(10)
  }
}

const UNLINKED = unlinkedProjectId(db)
let HORIZON

test('the demo seed made `Unlinked items`, and init() never makes it the active project', async () => {
  assert.ok(UNLINKED, 'the demo seed created it')
  assert.equal(settings.getActiveProjectId(), null)
  await orchestrator.init(silentLog)
  assert.equal(settings.getActiveProjectId(), null, 'a demo box keeps no active project')
  // So the first real project still becomes the active one.
  HORIZON = store.createProject('Horizon').id
  assert.equal(settings.getActiveProjectId(), HORIZON)
})

test('POST /api/items with no repo creates a local item in `Unlinked items`; the API still reads it as no project, in every scope', async () => {
  const res = await inject({
    method: 'POST',
    url: '/api/items',
    payload: { title: 'Local work', outcome: 'An outcome long enough', metric: 'A metric', priority: 'Medium' },
  })
  assert.equal(res.statusCode, 200, res.body)
  const { id } = res.json()
  assert.equal(row(id).project_id, UNLINKED)
  for (const scope of ['active', 'enabled']) assert.equal(view(id, scope)?.project_id, null, `${scope} scope`)
  const api = (await inject({ method: 'GET', url: '/api/items' })).json()
  assert.equal(api.items.find((it) => it.id === id).project_id, null)
  assert.ok(api.projects.find((p) => p.id === UNLINKED).unlinked)
  assert.ok(!api.projects.find((p) => p.id === HORIZON).unlinked)

  // The farm payload carries no project, as a NULL item's did.
  await until(() => posted(id).length === 1, 'its first step')
  assert.equal(Object.hasOwn(posted(id)[0].body, 'project'), false)
})

test('project definitions, defaults and Autopilot never apply to an unlinked item, even switched on', () => {
  db.prepare("UPDATE project SET definitions_enabled = 1, autopilot = 'on', provider_defaults_json = ? WHERE id = ?").run(JSON.stringify({ 6: 'muse' }), UNLINKED)
  const acme = store.createProject('Acme').id
  store.setProjectEnabled(acme, true)
  db.prepare("UPDATE project SET definitions_enabled = 1, autopilot = 'on', provider_defaults_json = ? WHERE id = ?").run(JSON.stringify({ 6: 'muse' }), acme)
  const gate = requiredStepIndex('Approve & prioritize this work')
  const substeps = JSON.stringify([{ id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: gate, persona: null, output: 'golden_cases', applies: { labels: [], repos: [], paths: [] } }])
  const insert = db.prepare("INSERT INTO work_item (id, title, priority, cursor, paused, project_id, substeps_json) VALUES (?, 'Golden', 'Medium', ?, 1, ?, ?)")
  insert.run('UNL-G', gate, UNLINKED, substeps)
  insert.run('ACME-G', gate, acme, substeps)
  try {
    assert.equal(golden.goldenCasesRequired(row('ACME-G')), true, 'control: a real project with the switch on requires them')
    assert.equal(golden.goldenCasesRequired(row('UNL-G')), false)

    assert.ok(store.projectOverlayFor(acme), 'control: a real project reads its personas.json')
    assert.equal(store.projectOverlayFor(UNLINKED), null)

    const acmeView = view('ACME-G', 'enabled')
    assert.equal(acmeView.projectAutopilot, 'on', 'control')
    const unlinkedView = view('UNL-G', 'enabled')
    assert.equal(unlinkedView.projectAutopilot, 'off')
    assert.deepEqual(unlinkedView.projectProviderDefaults, store.providerDefaultsFromRow(null), 'what a NULL item reads')
    assert.notDeepEqual(acmeView.projectProviderDefaults, store.providerDefaultsFromRow(null), 'control')
    assert.deepEqual(unlinkedView.personaBadges, {})
  } finally {
    db.prepare("UPDATE project SET definitions_enabled = 0, autopilot = 'off', provider_defaults_json = NULL WHERE id = ?").run(UNLINKED)
  }
})

test('productivity lists no `Unlinked items` project, as items with no project were in none', () => {
  const report = productivityReport({ range: '7d', project: 'all' })
  const names = JSON.stringify(report)
  assert.ok(names.includes('Horizon'), 'control: real projects are listed')
  assert.ok(!names.includes('Unlinked items'))
})

test('a disabled `Unlinked items`: its items are listed but not dispatched; enabled again, they dispatch', async () => {
  assert.deepEqual(orchestrator.setProjectEnabled(UNLINKED, false, silentLog), { ok: true, enabled: false })
  const id = store.createLocalItem({ title: 'Held', outcome: 'An outcome long enough', metric: 'A metric', priority: 'Medium' })
  assert.equal(row(id).project_id, UNLINKED)
  orchestrator.kick(id)
  orchestrator.setProjectEnabled(HORIZON, true, silentLog) // another project's enable-kick pass
  await wait(50)
  assert.equal(posted(id).length, 0, 'not dispatched')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ?').get(id).n, 0)
  assert.ok(view(id, 'active'), 'listed in the active scope')
  assert.ok(view(id, 'enabled'), 'listed in the enabled scope')

  orchestrator.setProjectEnabled(UNLINKED, true, silentLog)
  await until(() => posted(id).length === 1, 'the dispatch after re-enable')
})
