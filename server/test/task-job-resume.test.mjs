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
// HZ-415: item ids whose job dispatch farmd answers with this 400 body.
const farmRefusals = {}
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  dispatches.push({ url: String(url), body })
  const refusal = String(url).includes('/steps/run') && Object.hasOwn(farmRefusals, body?.item?.id ?? '') && farmRefusals[body.item.id]
  if (refusal) return { ok: false, status: 400, json: async () => refusal }
  return { ok: true, status: 200, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX, requiredStepIndex } = await import('../../domain/js/lifecycle.js')
const { REASON } = await import('../../domain/js/reasons.js')
const DRAFT_PLAN_STEP_INDEX = requiredStepIndex('Draft implementation plan')

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
function seedStoppedTask(id, repo = null) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, paused, approved_plan_hash, repo) VALUES (?, ?, 'High', ?, 'task', ?, 1, ?, ?)",
  ).run(id, `Task ${id}`, EXECUTE_STEP_INDEX, projectId, sha256(PLAN), repo)
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

// HZ-415: the plan's cwd resolves inside the Task repo's deploy-target
// checkout, so every dispatch (Resume included) carries that directory.
test('HZ-415: the job dispatch carries the repo deploy target repo_dir, and null for a repo with none', async () => {
  seedStoppedTask('T-415-MDI', 'FinTekkers/market-data-inputs')
  seedStoppedTask('T-415-NONE')
  for (const id of ['T-415-MDI', 'T-415-NONE']) {
    const res = await app.inject({ method: 'POST', url: `/api/items/${id}/job/resume`, headers: cookie, payload: {} })
    assert.equal(res.statusCode, 200)
  }
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(jobDispatchesFor('T-415-MDI')[0].body.repo_dir, '/opt/fintekkers/market-data-inputs')
  const none = jobDispatchesFor('T-415-NONE')[0].body
  assert.ok(Object.hasOwn(none, 'repo_dir'))
  assert.equal(none.repo_dir, null)
  orchestrator.cancel('T-415-MDI')
  orchestrator.cancel('T-415-NONE')
})

test("HZ-415: farmd's cwd refusal is stored on the run, and the item does not stay running", async () => {
  const line = 'cwd refused: cwd resolves outside the repo directory'
  farmRefusals['T-415-OUT'] = { error: line }
  seedStoppedTask('T-415-OUT', 'FinTekkers/market-data-inputs')
  const res = await app.inject({ method: 'POST', url: '/api/items/T-415-OUT/job/resume', headers: cookie, payload: {} })
  assert.equal(res.statusCode, 200)
  const runId = res.json().runId
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(jobDispatchesFor('T-415-OUT').length, 1)
  const run = db.prepare('SELECT status, output FROM step_run WHERE id = ?').get(runId)
  assert.equal(run.status, 'cancelled')
  assert.equal(run.output, `FAILED: the farm refused the job: ${line}`)
  const item = store.getItem('T-415-OUT')
  assert.equal(item.activeRun ?? null, null)
  assert.equal(item.paused, true)
})

// HZ-431: Run plan's prompt and Execute's runner both read the deploy
// target's venv setting, so both dispatches carry it; a change item's has
// neither key.
test('HZ-431: the Run plan and Execute dispatches carry venv_dir; a change item dispatch carries neither key', async () => {
  const mdi = 'FinTekkers/market-data-inputs'
  db.prepare("UPDATE deploy_target SET venv_dir = '.venv-prod' WHERE repo = ?").run(mdi)
  try {
    db.prepare(
      "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo) VALUES ('T-431-PLAN', 'Plan', 'High', ?, 'task', ?, ?)",
    ).run(RUN_PLAN_STEP_INDEX, projectId, mdi)
    db.prepare(
      "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo) VALUES ('C-431', 'Change', 'High', ?, 'change', ?, ?)",
    ).run(DRAFT_PLAN_STEP_INDEX, projectId, mdi)
    seedStoppedTask('T-431-EXEC', mdi)
    orchestrator.kick('T-431-PLAN')
    orchestrator.kick('C-431')
    const res = await app.inject({ method: 'POST', url: '/api/items/T-431-EXEC/job/resume', headers: cookie, payload: {} })
    assert.equal(res.statusCode, 200)
    await new Promise((r) => setTimeout(r, 30))

    const plan = jobDispatchesFor('T-431-PLAN').find((d) => d.body.step.index === RUN_PLAN_STEP_INDEX)
    assert.ok(plan, 'Run plan was dispatched')
    assert.equal(plan.body.repo_dir, '/opt/fintekkers/market-data-inputs')
    assert.equal(plan.body.venv_dir, '.venv-prod')
    const [execute] = jobDispatchesFor('T-431-EXEC')
    assert.equal(execute.body.step.index, EXECUTE_STEP_INDEX)
    assert.equal(execute.body.venv_dir, '.venv-prod')
    const [change] = jobDispatchesFor('C-431')
    assert.ok(change, 'the change step was dispatched')
    assert.equal(Object.hasOwn(change.body, 'repo_dir'), false)
    assert.equal(Object.hasOwn(change.body, 'venv_dir'), false)
  } finally {
    db.prepare('UPDATE deploy_target SET venv_dir = NULL WHERE repo = ?').run(mdi)
    for (const id of ['T-431-PLAN', 'C-431', 'T-431-EXEC']) orchestrator.cancel(id)
  }
})

// HZ-440: a target's taskDir replaces repoDir in both dispatches, with
// task_clone set; with no taskDir the payload is exactly as before.
test('HZ-440: a taskDir is dispatched as repo_dir with task_clone; without one repo_dir is repoDir and task_clone is absent', async () => {
  const mdi = 'FinTekkers/market-data-inputs'
  const dispatchesFor = async (suffix) => {
    const planId = `T-440-PLAN-${suffix}`
    const execId = `T-440-EXEC-${suffix}`
    db.prepare(
      "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo) VALUES (?, 'Plan', 'High', ?, 'task', ?, ?)",
    ).run(planId, RUN_PLAN_STEP_INDEX, projectId, mdi)
    seedStoppedTask(execId, mdi)
    orchestrator.kick(planId)
    const res = await app.inject({ method: 'POST', url: `/api/items/${execId}/job/resume`, headers: cookie, payload: {} })
    assert.equal(res.statusCode, 200)
    await new Promise((r) => setTimeout(r, 30))
    const plan = jobDispatchesFor(planId).find((d) => d.body.step.index === RUN_PLAN_STEP_INDEX)
    assert.ok(plan, 'Run plan was dispatched')
    const [execute] = jobDispatchesFor(execId)
    assert.equal(execute.body.step.index, EXECUTE_STEP_INDEX)
    orchestrator.cancel(planId)
    orchestrator.cancel(execId)
    return [plan.body, execute.body]
  }
  db.prepare("UPDATE deploy_target SET task_dir = '/opt/fintekkers/market-data-inputs-tasks' WHERE repo = ?").run(mdi)
  try {
    for (const body of await dispatchesFor('SET')) {
      assert.equal(body.repo_dir, '/opt/fintekkers/market-data-inputs-tasks')
      assert.equal(body.task_clone, true)
    }
  } finally {
    db.prepare('UPDATE deploy_target SET task_dir = NULL WHERE repo = ?').run(mdi)
  }
  for (const body of await dispatchesFor('UNSET')) {
    assert.equal(body.repo_dir, '/opt/fintekkers/market-data-inputs')
    assert.equal(Object.hasOwn(body, 'task_clone'), false)
  }
})
