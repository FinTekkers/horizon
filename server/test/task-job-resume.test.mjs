// HZ-378 R3: Resume after the plan was edited is refused — 409 plan_changed
// with zero farm dispatches — and the item shows the plan no longer matches
// the approval. The unchanged-plan Resume dispatches the Execute job again.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-job-resume-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const dispatches = []
globalThis.fetch = async (url, opts) => {
  dispatches.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  return { ok: true, status: 200, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { REASON } = await import('../../domain/js/reasons.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })
await app.ready()
after(async () => {
  await app.close()
})

const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice' })
const cookie = { cookie: alice.cookie }
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

const PLAN =
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '/tmp', commands: ['scripts/a.sh'], budget_minutes: 20 }, null, 2) +
  '\n```'

const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Jobs project', 1)").run().lastInsertRowid)

const doneRun = (itemId, stepIndex, artifact) =>
  db
    .prepare(
      "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
    )
    .run(itemId, stepIndex, STEPS[stepIndex].agent, artifact)

// A Task stopped at Execute with the plan approved.
function seedStoppedTask(id) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, paused, approved_plan_hash) VALUES (?, ?, 'High', ?, 'task', ?, 1, ?)",
  ).run(id, `Task ${id}`, EXECUTE_STEP_INDEX, projectId, sha256(PLAN))
  doneRun(id, RUN_PLAN_STEP_INDEX, PLAN)
}

const jobDispatchesFor = (id) => dispatches.filter((d) => d.url.includes('/steps/run') && d.body?.item?.id === id)

test('R3: Resume after the plan changed is 409 plan_changed with zero dispatches, and the item asks for re-approval', async () => {
  seedStoppedTask('T-R3')
  doneRun('T-R3', RUN_PLAN_STEP_INDEX, PLAN.replace('scripts/a.sh', 'scripts/edited.sh'))
  const before = jobDispatchesFor('T-R3').length

  const res = await app.inject({ method: 'POST', url: '/api/items/T-R3/job/resume', headers: cookie, payload: {} })
  assert.equal(res.statusCode, 409)
  const body = res.json()
  assert.equal(body.error, 'plan_changed')
  assert.match(body.message, /approve it again/)
  assert.equal(jobDispatchesFor('T-R3').length, before, 'no dispatch may reach the farm')

  // The item asks for re-approval: the recorded plan no longer matches it.
  assert.equal(store.approvedPlanCheck('T-R3').error, REASON.PLAN_CHANGED_SINCE_APPROVAL)
  const shown = (await app.inject({ method: 'GET', url: '/api/items', headers: cookie }))
    .json()
    .items.find((it) => it.id === 'T-R3')
  assert.notEqual(shown.runPlan.hash, shown.approvedPlanHash)
})

test('Resume with the approved plan dispatches the Execute job again', async () => {
  seedStoppedTask('T-R3-OK')
  const res = await app.inject({ method: 'POST', url: '/api/items/T-R3-OK/job/resume', headers: cookie, payload: {} })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(typeof res.json().runId, 'number')
  await new Promise((r) => setTimeout(r, 30))
  const [dispatch] = jobDispatchesFor('T-R3-OK')
  assert.ok(dispatch, 'Resume dispatched the job to the farm')
  assert.equal(dispatch.body.step.index, EXECUTE_STEP_INDEX)
  assert.equal(store.getItem('T-R3-OK').paused, false)
  orchestrator.cancel('T-R3-OK')
})
