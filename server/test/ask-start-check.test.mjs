// HZ-731: the start check. Before Implement (a Task's Execute), every
// blocking ask must be dismissed, or filed with its item merged or closed;
// until then the item is not dispatched, reads blocked, and its startHold
// names the ask or the item it waits for.
//
// Mock mode (FARM_URL unset), like dependency-orchestrator.test.mjs: a
// dispatch is a step_run row. File it and Dismiss go through the owner's real
// routes; items have no repo, so File it files a local item and no case
// reaches GitHub.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('ask-start-check test: no network')
}

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-ask-start-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '600000'
for (const key of ['FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, IMPLEMENT_STEP_INDEX, IMPLEMENT_ITEM_KIND, EXECUTE_STEP_INDEX, requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
// What orchestrator.init() registers, so a merge's wakeDependents kicks.
store.registerAgentRunner({ kick: orchestrator.kick, cancel: orchestrator.cancel })
const app = buildApp({ logger: false })
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Owner Example' })
await app.ready()
after(async () => {
  // Each dispatched mock step, filed items' included, holds a long timer;
  // stop them so the file exits.
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
  await app.close()
})

const ARCH = requiredStepIndex('Architecture review')
const REPO = 'Acme/start-check'
const project = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Start check', 1)").run().lastInsertRowid)
db.prepare("INSERT INTO project_repo (repo, prefix, project_id) VALUES (?, 'SC', ?)").run(REPO, project)
const TASK_KIND = STEPS[EXECUTE_STEP_INDEX].itemKind

const newItem = (id, cursor, kind = IMPLEMENT_ITEM_KIND) =>
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id) VALUES (?, ?, 'High', ?, ?, ?)").run(id, `fixture ${id}`, cursor, kind, project)
function seedAsk(itemId, { kind = 'blocking', title = 'Prerequisite fix', verdict = 'accept' } = {}) {
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact) VALUES (?, ?, 1, 'Architect', 'done', 'x', 'x')")
    .run(itemId, ARCH).lastInsertRowid
  const d = {
    title,
    repo: REPO,
    outcome: 'The prerequisite lands first.',
    metric: '1. It lands.\n2. It is tested.\n3. It is documented.',
    guardrails: '1. Nothing else changes.',
  }
  const askId = Number(
    db
      .prepare("INSERT INTO ask (item_id, step_run_id, step_index, kind, status, draft_json, why) VALUES (?, ?, ?, ?, 'open', ?, 'needed first')")
      .run(itemId, runId, ARCH, kind, JSON.stringify(d)).lastInsertRowid,
  )
  db.prepare("INSERT INTO ask_review (ask_id, provider, status, verdict, reasons_json) VALUES (?, 'muse', 'done', ?, '[]')").run(askId, verdict)
  return askId
}

const ownerHeaders = { cookie: owner.cookie, 'x-human-key': owner.pin }
const fileIt = (itemId, askId) => app.inject({ method: 'POST', url: `/api/items/${itemId}/asks/${askId}/file`, headers: ownerHeaders, payload: {} })
const dismiss = (itemId, askId) =>
  app.inject({ method: 'POST', url: `/api/items/${itemId}/asks/${askId}/dismiss`, headers: ownerHeaders, payload: { reason: 'Not needed here.' } })
// The item as the board's feed serves it.
const apiItem = async (id) => {
  const res = await app.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie: owner.cookie } })
  assert.equal(res.statusCode, 200, res.body)
  const item = res.json().items.find((it) => it.id === id)
  assert.ok(item, `${id} is in the feed`)
  return item
}
const runsAt = (id, step) => db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ?').get(id, step).n
const STEP_NUMBER = /\bstep \d+\b/i
const IMPLEMENT = STEPS[IMPLEMENT_STEP_INDEX].label
const EXECUTE = STEPS[EXECUTE_STEP_INDEX].label

test('metric 4: Implement waits for an open blocking ask, then for its filed item, and starts when that item merges', async () => {
  const id = 'SC-CHANGE'
  newItem(id, IMPLEMENT_STEP_INDEX)
  const askId = seedAsk(id)

  orchestrator.kick(id)
  assert.equal(runsAt(id, IMPLEMENT_STEP_INDEX), 0, 'not dispatched while the ask is open')
  let view = await apiItem(id)
  assert.deepEqual(view.startHold, { askId, title: 'Prerequisite fix', filedItem: null, step: IMPLEMENT })
  assert.equal(view.blocked, true)
  assert.doesNotMatch(view.startHold.step, STEP_NUMBER)

  const filed = await fileIt(id, askId)
  assert.equal(filed.statusCode, 200, filed.body)
  const childId = filed.json().itemId
  orchestrator.kick(id)
  assert.equal(runsAt(id, IMPLEMENT_STEP_INDEX), 0, 'not dispatched while the filed item is unmerged')
  view = await apiItem(id)
  assert.deepEqual(view.startHold, { askId, title: 'Prerequisite fix', filedItem: { id: childId, title: 'Prerequisite fix' }, step: IMPLEMENT })
  assert.equal(view.blocked, true)

  // The merge wakes it: no manual kick.
  assert.equal(store.markMerged(childId), true)
  assert.equal(runsAt(id, IMPLEMENT_STEP_INDEX), 1, 'Implement starts once the filed item merges')
  view = await apiItem(id)
  assert.equal(Object.hasOwn(view, 'startHold'), false)
  assert.equal(view.blocked, false)
})

test('metric 4: with the dependency edge removed, the filed item still holds Implement, and its merge still wakes the item', async () => {
  const id = 'SC-NO-EDGE'
  newItem(id, IMPLEMENT_STEP_INDEX)
  const askId = seedAsk(id, { title: 'Edge-less prerequisite' })
  const childId = (await fileIt(id, askId)).json().itemId
  assert.equal(store.removeDependency(id, childId, 'Owner').ok, true)
  orchestrator.kick(id)
  assert.equal(runsAt(id, IMPLEMENT_STEP_INDEX), 0)
  assert.equal((await apiItem(id)).startHold.filedItem.id, childId)

  store.markMerged(childId)
  assert.equal(runsAt(id, IMPLEMENT_STEP_INDEX), 1)
})

test('metric 4: a Task’s Execute waits for an open blocking ask and starts as soon as the owner dismisses it', async () => {
  const id = 'SC-TASK'
  newItem(id, EXECUTE_STEP_INDEX, TASK_KIND)
  const askId = seedAsk(id, { title: 'Owner decides first', verdict: 'escalate' })

  orchestrator.kick(id)
  assert.equal(runsAt(id, EXECUTE_STEP_INDEX), 0)
  const view = await apiItem(id)
  assert.deepEqual(view.startHold, { askId, title: 'Owner decides first', filedItem: null, step: EXECUTE })
  assert.equal(view.blocked, true)

  const res = await dismiss(id, askId)
  assert.equal(res.statusCode, 200, res.body)
  // The Dismiss route kicks the item; nothing waits for a re-sweep.
  assert.equal(runsAt(id, EXECUTE_STEP_INDEX), 1, 'Execute starts right after the Dismiss')
  assert.equal(Object.hasOwn(await apiItem(id), 'startHold'), false)
})

test('guardrail 2: an open soft ask never holds Implement', async () => {
  const id = 'SC-SOFT'
  newItem(id, IMPLEMENT_STEP_INDEX)
  seedAsk(id, { kind: 'soft' })
  orchestrator.kick(id)
  assert.equal(runsAt(id, IMPLEMENT_STEP_INDEX), 1)
  const view = await apiItem(id)
  assert.equal(Object.hasOwn(view, 'startHold'), false)
  assert.equal(view.blocked, false)
})

test('only the start step is held: an item before Implement plans past an open blocking ask', async () => {
  const id = 'SC-EARLY'
  newItem(id, ARCH + 1)
  seedAsk(id)
  assert.equal(STEPS[ARCH + 1].kind, 'agent')
  orchestrator.kick(id)
  assert.equal(runsAt(id, ARCH + 1), 1)
  assert.equal(Object.hasOwn(await apiItem(id), 'startHold'), false)
})
