// HZ-662, the job lane: an Execute step of a tenant project missing its run
// user is held like any other step — no run row, nothing sent to the farm's
// /steps/run. Once the project is complete the job's `project` carries the same
// three isolation fields the agent lane sends (orchestrator.taskProject), the
// credential as its $NAME reference only. The farm leg is
// farm/tests/test_farmd_isolation.py.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-project-isolation-job-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED', 'FARM_HOME']) delete process.env[key]

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

store.purgeDemoItems()

const app = buildApp({ logger: false })
await app.ready()
after(async () => {
  orchestrator.cancel('T-ISO-1')
  await app.close()
})

const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Owner' })
const MDI = 'FinTekkers/market-data-inputs'
const REF = '$ACME_GITHUB_TOKEN'
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const PLAN =
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: 'equity', commands: ['python3 load.py'], budget_minutes: 20, env: {}, runner: 'host' }, null, 2) +
  '\n```'

// A tenant project with its credential reference set but no run user.
const projectId = Number(
  db.prepare("INSERT INTO project (name, enabled, isolation, github_token_ref) VALUES ('Acme Jobs', 1, 'tenant', ?)").run(REF).lastInsertRowid,
)

db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, paused, approved_plan_hash, approved_runner, repo) VALUES ('T-ISO-1', 'Tenant task', 'High', ?, 'task', ?, 1, ?, 'host', ?)",
).run(EXECUTE_STEP_INDEX, projectId, sha256(PLAN), MDI)
db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES ('T-ISO-1', ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
).run(RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, PLAN)

const executeRuns = () => db.prepare("SELECT * FROM step_run WHERE item_id = 'T-ISO-1' AND step_index = ?").all(EXECUTE_STEP_INDEX)
const jobPosts = () => dispatches.filter((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'T-ISO-1')

test('a tenant job with run_user missing creates no run and never reaches /steps/run', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/items/T-ISO-1/job/resume', headers: { cookie: owner.cookie }, payload: {} })
  assert.equal(res.statusCode, 200, res.body)
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(executeRuns(), [])
  assert.deepEqual(jobPosts(), [])
  assert.equal(store.itemViewById('T-ISO-1').isolationRefusal, 'tenant project needs run_user before the farm runs it')
})

test('once the run user is set the job dispatches, its project carrying all three isolation fields', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/projects/${projectId}/isolation`,
    headers: { cookie: owner.cookie, 'x-human-key': owner.pin },
    payload: { runUser: 'acme' },
  })
  assert.equal(res.statusCode, 200, res.body)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(executeRuns().length, 1)
  const [job] = jobPosts()
  assert.ok(job, 'the job was posted to the farm')
  assert.deepEqual(job.body.project, { id: projectId, name: 'Acme Jobs', isolation: 'tenant', githubTokenRef: REF, runUser: 'acme' })
  assert.equal(job.body.plan_artifact, PLAN)
})
