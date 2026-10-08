// HZ-357: the owner's per-step provider choice ("Runs on" on the item page).
// PUT /api/items/:id/steps/:stepIndex/provider saves it per item and step, the
// item carries it as providerChoices, the dispatch payload copies it into the
// farm task, and a finished step's stepOutputs entry names the provider that
// ran. Only steps domain/steps.json marks providerOverrideEligible take one —
// every expectation below is derived from STEPS, not a typed list.
//
// Its own file because config.js reads the environment at import time. FARM_URL
// is set so kick() dispatches to the farm; farm calls go to the stubbed fetch
// below, everything else (the stream test's real socket) to the real one.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-step-provider-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const appModule = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { STEPS, requiredStepIndex, IMPLEMENT_STEP_INDEX, DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

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
const { cookie } = loginFixtureUser(auth, config)
let base
before(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${app.server.address().port}`
})
after(() => app.close())

const inject = (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie } })
const putProvider = (id, stepIndex, provider) =>
  inject({ method: 'PUT', url: `/api/items/${id}/steps/${stepIndex}/provider`, payload: { provider } })
const itemFrom = async (id, query = '') =>
  (await inject({ method: 'GET', url: `/api/items${query}` })).json().items.find((it) => it.id === id)

const ARCH = requiredStepIndex('Architecture review')
const GATE = requiredStepIndex('Review before execution')
const QA = requiredStepIndex('QA reviews the test plan')
const ELIGIBLE = STEPS.flatMap((s, i) => (s.providerOverrideEligible === true ? [i] : []))
const INELIGIBLE = STEPS.flatMap((s, i) => (s.providerOverrideEligible === true ? [] : [i]))

const insertItem = db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, 'Medium', ?)")
const choicesColumn = (id) => db.prepare('SELECT provider_choices_json AS v FROM work_item WHERE id = ?').get(id).v
const eventCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM event WHERE item_id = ?').get(id).n

test('sanity: the indices under test are what the step table says they are', () => {
  assert.ok(ELIGIBLE.includes(ARCH))
  for (const i of [QA, GATE, IMPLEMENT_STEP_INDEX, DEPLOY_STEP_INDEX]) assert.ok(INELIGIBLE.includes(i), `step ${i}`)
  assert.equal(STEPS[GATE].kind, 'gate')
})

test('a Muse choice on an eligible step saves, survives a fresh read, and Default clears it', async () => {
  insertItem.run('SP-1', 'Choose a provider', 3)
  const res = await putProvider('SP-1', ARCH, 'muse')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true })

  // A reload reads the board snapshot fresh, both the v1 and the v2 shape.
  assert.deepEqual((await itemFrom('SP-1')).providerChoices, { [ARCH]: 'muse' })
  assert.deepEqual((await itemFrom('SP-1', '?v=2')).providerChoices, { [ARCH]: 'muse' })
  assert.deepEqual(store.getItem('SP-1').providerChoices, { [ARCH]: 'muse' })
  assert.match((await itemFrom('SP-1')).events[0].text, /set Architecture review to run on Muse/)

  assert.equal((await putProvider('SP-1', ARCH, 'default')).statusCode, 200)
  assert.deepEqual((await itemFrom('SP-1')).providerChoices, {})
  assert.equal(choicesColumn('SP-1'), null)
})

test('every step that is not providerOverrideEligible is refused 400 and nothing is saved', async () => {
  insertItem.run('SP-2', 'Ineligible steps', 3)
  assert.equal((await putProvider('SP-2', ARCH, 'claude')).statusCode, 200)
  const before = choicesColumn('SP-2')
  const events = eventCount('SP-2')
  for (const i of INELIGIBLE) {
    const res = await putProvider('SP-2', i, 'muse')
    assert.equal(res.statusCode, 400, `step ${i} (${STEPS[i].label})`)
    assert.deepEqual(res.json(), { error: 'provider_not_eligible' })
  }
  assert.equal(choicesColumn('SP-2'), before)
  assert.equal(eventCount('SP-2'), events)
})

test('an unknown provider, an unknown item and a closed item are refused', async () => {
  insertItem.run('SP-3', 'Closed', STEPS.length)
  assert.equal((await putProvider('SP-1', ARCH, 'gpt')).statusCode, 400)
  assert.equal((await putProvider('NOPE-1', ARCH, 'muse')).statusCode, 404)
  const closed = await putProvider('SP-3', ARCH, 'muse')
  assert.equal(closed.statusCode, 409)
  assert.deepEqual(closed.json(), { error: 'closed' })
  assert.equal(choicesColumn('SP-3'), null)
})

test('a stored choice for an ineligible step or an unknown provider is never read back', () => {
  insertItem.run('SP-4', 'Junk column', 3)
  db.prepare('UPDATE work_item SET provider_choices_json = ? WHERE id = ?').run(
    JSON.stringify({ [IMPLEMENT_STEP_INDEX]: 'muse', [ARCH]: 'gpt', [ELIGIBLE[0]]: 'muse' }),
    'SP-4',
  )
  assert.deepEqual(store.getItem('SP-4').providerChoices, { [ELIGIBLE[0]]: 'muse' })
})

test('the choice rides in the dispatch payload, and a change after dispatch reaches only the next one', async () => {
  insertItem.run('SP-5', 'Dispatch carries the choice', ARCH)
  db.prepare('UPDATE work_item SET provider_choices_json = ? WHERE id = ?').run(JSON.stringify({ [ARCH]: 'muse' }), 'SP-5')
  const sentFor = () => dispatches.filter((d) => d.url.endsWith('/steps/run') && d.body?.item?.id === 'SP-5')

  orchestrator.kick('SP-5')
  for (let i = 0; i < 100 && sentFor().length === 0; i++) await sleep(10)
  assert.equal(sentFor().length, 1)
  const first = sentFor()[0]
  assert.equal(first.body.step.index, ARCH)
  assert.deepEqual(first.body.item.providerChoices, { [ARCH]: 'muse' })

  // Changed while the run is in flight: the task already sent is untouched.
  assert.equal((await putProvider('SP-5', ARCH, 'claude')).statusCode, 200)
  assert.deepEqual(sentFor()[0].body.item.providerChoices, { [ARCH]: 'muse' })
  assert.equal(sentFor().length, 1)

  // The next dispatch of the step (the run failed, the owner resumes to retry)
  // reads the new value.
  orchestrator.failFarmRun(first.body.run_id, 'test: retry the step')
  db.prepare('UPDATE work_item SET paused = 0 WHERE id = ?').run('SP-5')
  orchestrator.kick('SP-5')
  for (let i = 0; i < 100 && sentFor().length < 2; i++) await sleep(10)
  assert.equal(sentFor().length, 2)
  assert.deepEqual(sentFor()[1].body.item.providerChoices, { [ARCH]: 'claude' })
  orchestrator.cancel('SP-5')
})

test('a finished step records the provider that ran, in step_run and on the item stream', async () => {
  insertItem.run('SP-6', 'Ran on Muse', ARCH)
  db.prepare('UPDATE work_item SET provider_choices_json = ? WHERE id = ?').run(JSON.stringify({ [ARCH]: 'muse' }), 'SP-6')
  const runId = db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)')
    .run('SP-6', ARCH, STEPS[ARCH].agent).lastInsertRowid
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'reviewed',
    artifacts: { artifact_md: '# review', provider: 'muse', command_id: 'cmd-1' },
  })
  assert.deepEqual(result, { ok: true })
  orchestrator.cancel('SP-6')
  assert.equal(db.prepare('SELECT provider FROM step_run WHERE id = ?').get(runId).provider, 'muse')
  assert.equal((await itemFrom('SP-6')).stepOutputs[ARCH].provider, 'muse')

  // What a reloaded item page reads: the item stream's outputs frame for the
  // step's "Ran on", and the v2 board snapshot for the saved choice.
  const controller = new AbortController()
  const res = await fetch(`${base}/api/items/SP-6/stream`, { headers: { cookie }, signal: controller.signal })
  const reader = res.body.getReader()
  let text = ''
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value)
  controller.abort()
  const frame = JSON.parse(text.split('\n').find((line) => line.startsWith('data: ')).slice(6))
  assert.equal(frame.stepOutputs[ARCH].provider, 'muse')
  assert.deepEqual((await itemFrom('SP-6', '?v=2')).providerChoices, { [ARCH]: 'muse' })
})
