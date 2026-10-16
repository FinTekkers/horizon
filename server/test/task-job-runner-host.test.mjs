// HZ-416 metric 4 (server leg): a plan with `runner: host` is dispatched
// exactly as a plan was before HZ-416 — the same repo_dir and venv_dir, the
// approved artifact verbatim with `runner: host` inside it — so the farm runs
// it on the host with the same cwd, env and log (the farm leg is
// farm/tests/test_container_runner.py). A container plan's dispatch differs
// only in its artifact. item.runPlan.runner says which, on every load.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-job-runner-host-')), 'test.db')
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

store.purgeDemoItems()

const app = buildApp({ logger: false })
await app.ready()
after(async () => {
  await app.close()
})

const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice' })
const cookie = { cookie: alice.cookie }
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const MDI = 'FinTekkers/market-data-inputs'
const IMAGE = `docker.io/library/python@sha256:${'e'.repeat(64)}`

const planOf = (extra) =>
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: 'equity', commands: ['python3 load.py'], budget_minutes: 20, env: { API_KEY: '$API_KEY' }, ...extra }, null, 2) +
  '\n```'
const HOST_PLAN = planOf({ runner: 'host' })
const CONTAINER_PLAN = planOf({})

const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Runner project', 1)").run().lastInsertRowid)

// HZ-491: approved with the effective runner — the plan's own, else MDI's
// default at seed time.
function seedStoppedTask(id, plan) {
  const runner = plan === HOST_PLAN ? 'host' : store.defaultRunnerFor(MDI)
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, paused, approved_plan_hash, approved_runner, repo) VALUES (?, ?, 'High', ?, 'task', ?, 1, ?, ?, ?)",
  ).run(id, `Task ${id}`, EXECUTE_STEP_INDEX, projectId, sha256(plan), runner, MDI)
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
  ).run(id, RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, plan)
}

async function resume(id) {
  const res = await app.inject({ method: 'POST', url: `/api/items/${id}/job/resume`, headers: cookie, payload: {} })
  assert.equal(res.statusCode, 200, res.body)
  await new Promise((r) => setTimeout(r, 30))
  const [dispatch] = dispatches.filter((d) => d.url.includes('/steps/run') && d.body?.item?.id === id)
  orchestrator.cancel(id)
  return dispatch.body
}

test('a runner: host plan dispatches with the same repo_dir, venv_dir and step as a container plan, its artifact verbatim', async () => {
  db.prepare("UPDATE deploy_target SET container_image = ?, venv_dir = '.venv' WHERE repo = ?").run(IMAGE, MDI)
  try {
    seedStoppedTask('T-HOST-416', HOST_PLAN)
    seedStoppedTask('T-CONT-416', CONTAINER_PLAN)
    const host = await resume('T-HOST-416')
    const container = await resume('T-CONT-416')

    assert.equal(host.step.index, EXECUTE_STEP_INDEX)
    assert.equal(host.repo_dir, '/opt/fintekkers/market-data-inputs')
    assert.equal(host.venv_dir, '.venv')
    assert.equal(host.plan_artifact, HOST_PLAN)
    assert.equal(host.approved_hash, sha256(HOST_PLAN))
    assert.match(host.plan_artifact, /"runner": "host"/)
    assert.equal(Object.hasOwn(host, 'env'), false, 'the server sends no env values; the farm resolves them as before')

    // HZ-491: the effective runner rides in the job; the image stays pinned.
    assert.equal(host.runner, 'host')
    assert.equal(container.runner, 'container')
    const sameKeys = Object.keys(host).filter((k) => !['item', 'plan_artifact', 'approved_hash', 'run_id', 'attempt', 'runner'].includes(k))
    for (const key of sameKeys) assert.deepEqual(container[key], host[key], key)
    assert.doesNotMatch(container.plan_artifact, /"runner"/)
  } finally {
    db.prepare('UPDATE deploy_target SET container_image = NULL, venv_dir = NULL WHERE repo = ?').run(MDI)
  }
})

// HZ-491: a plan with no runner follows the repo's image — container while
// one is pinned, host once it is cleared. `runner: host` stays host.
test('item.runPlan.runner is host for the host plan and follows the image otherwise, on every load', async () => {
  const load = async (id) =>
    (await app.inject({ method: 'GET', url: '/api/items', headers: cookie })).json().items.find((it) => it.id === id)
  db.prepare('UPDATE deploy_target SET container_image = ? WHERE repo = ?').run(IMAGE, MDI)
  try {
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await load('T-HOST-416')).runPlan.runner, 'host')
      assert.equal((await load('T-CONT-416')).runPlan.runner, 'container')
    }
  } finally {
    db.prepare('UPDATE deploy_target SET container_image = NULL WHERE repo = ?').run(MDI)
  }
  assert.equal((await load('T-HOST-416')).runPlan.runner, 'host')
  assert.equal((await load('T-CONT-416')).runPlan.runner, 'host')
})
