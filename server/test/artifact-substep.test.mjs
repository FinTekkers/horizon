// HZ-540 metric 4 and guardrail 2: an artifact lookup by (kind, label) takes a
// substep_id. A global step and its sub-step share the kind and label, and
// each lookup returns its own artifact — through latestArtifactByLabel and
// through the artifact pages' ?substep=. Without a substep_id every lookup
// returns the global step's artifact, as before, and the Task's run plan is
// read from Run plan's own run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-artifact-substep-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL
delete process.env.HORIZON_REPO

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { STEPS, IMPLEMENT_STEP_INDEX, RUN_PLAN_STEP_INDEX, APPROVE_RUN_GATE_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
const get = (url) => app.inject({ method: 'GET', url, headers: { cookie } })

const IMPL_LABEL = STEPS[IMPLEMENT_STEP_INDEX].label
const insertRun = db.prepare(
  "INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, output, artifact, started_at, ended_at) VALUES (?, ?, ?, ?, 'Eng', 'done', 'summary', ?, '2026-10-01 10:00:00', '2026-10-01 10:05:00')",
)

const ID = 'A-1'
db.prepare("INSERT INTO work_item (id, title, priority, cursor, substeps_json) VALUES (?, 'Artifacts', 'Medium', ?, ?)").run(
  ID,
  ACCEPT_GATE_INDEX,
  JSON.stringify([
    { id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: 1 },
    { id: 'impl-audit', label: 'Audit the change', kind: 'audit', anchor: IMPLEMENT_STEP_INDEX },
  ]),
)
insertRun.run(ID, IMPLEMENT_STEP_INDEX, null, 1, 'anchor plan v1')
insertRun.run(ID, IMPLEMENT_STEP_INDEX, 'impl-audit', 1, 'audit findings v1')
insertRun.run(ID, IMPLEMENT_STEP_INDEX, null, 2, 'anchor plan v2')
insertRun.run(ID, IMPLEMENT_STEP_INDEX, 'impl-audit', 2, 'audit findings v2')

test('by (kind, label), the step and its sub-step each return their own artifact', () => {
  assert.equal(store.latestArtifactByLabel(ID, 'change', IMPL_LABEL), 'anchor plan v2')
  assert.equal(store.latestArtifactByLabel(ID, 'change', IMPL_LABEL, 'impl-audit'), 'audit findings v2')
  assert.equal(store.latestArtifact(ID, IMPLEMENT_STEP_INDEX, 'impl-audit'), 'audit findings v2')
  // A sub-step is never read under a step that is not its own.
  assert.equal(store.latestArtifact(ID, 1, 'impl-audit'), null)
})

test('the artifact pages: no ?substep is the step’s own, ?substep= is the sub-step’s', async () => {
  const anchor = await get(`/api/items/${ID}/artifacts/${IMPLEMENT_STEP_INDEX}`)
  assert.equal(anchor.statusCode, 200)
  assert.match(anchor.body, /anchor plan v2/)
  assert.doesNotMatch(anchor.body, /audit findings/)

  const sub = await get(`/api/items/${ID}/artifacts/${IMPLEMENT_STEP_INDEX}?substep=impl-audit`)
  assert.equal(sub.statusCode, 200)
  assert.match(sub.body, /audit findings v2/)
  assert.match(sub.body, /<title>A-1 · Audit the change<\/title>/)
  assert.match(sub.body, /attempt 2 of 2/)
  assert.match(sub.body, /href="[^"]*\/artifacts\/11\/1\?substep=impl-audit"/)

  const first = await get(`/api/items/${ID}/artifacts/${IMPLEMENT_STEP_INDEX}/1?substep=impl-audit`)
  assert.equal(first.statusCode, 200)
  assert.match(first.body, /audit findings v1/)
  const anchorFirst = await get(`/api/items/${ID}/artifacts/${IMPLEMENT_STEP_INDEX}/1`)
  assert.match(anchorFirst.body, /anchor plan v1/)
})

test('a ?substep= the item has no sub-step for at that step is a 404', async () => {
  for (const url of [
    `/api/items/${ID}/artifacts/${IMPLEMENT_STEP_INDEX}?substep=not-there`,
    `/api/items/${ID}/artifacts/${IMPLEMENT_STEP_INDEX}?substep=golden-cases`,
    `/api/items/${ID}/artifacts/${IMPLEMENT_STEP_INDEX}/1?substep=not-there`,
  ]) {
    assert.equal((await get(url)).statusCode, 404, url)
  }
})

test('main-shaped runs (substep_id NULL only): every lookup without a substep_id is unchanged', () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('A-2', 'Main-shaped', 'Medium', ?)").run(ACCEPT_GATE_INDEX)
  insertRun.run('A-2', IMPLEMENT_STEP_INDEX, null, 1, 'first')
  insertRun.run('A-2', IMPLEMENT_STEP_INDEX, null, 2, 'second')
  assert.equal(store.latestArtifact('A-2', IMPLEMENT_STEP_INDEX), 'second')
  assert.equal(store.latestArtifactByLabel('A-2', 'change', IMPL_LABEL), 'second')
  assert.deepEqual(store.listStepAttempts('A-2', IMPLEMENT_STEP_INDEX).map((a) => a.attempt), [1, 2])
})

test('a Task’s run plan is read from Run plan’s own run, never a later sub-step row there', () => {
  const plan = (commands, minutes) => `## Run plan\n\n\`\`\`json run-plan\n${JSON.stringify({ cwd: '.', commands, budget_minutes: minutes })}\n\`\`\``
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind) VALUES ('T-1', 'A task', 'Medium', ?, 'task')").run(APPROVE_RUN_GATE_INDEX)
  insertRun.run('T-1', RUN_PLAN_STEP_INDEX, null, 1, plan(['echo anchor'], 5))
  insertRun.run('T-1', RUN_PLAN_STEP_INDEX, 'plan-audit', 1, plan(['echo one', 'echo two'], 9))
  assert.deepEqual(
    (({ commands, budgetMinutes }) => ({ commands, budgetMinutes }))(store.itemViewById('T-1').runPlan),
    { commands: 1, budgetMinutes: 5 },
  )
})
