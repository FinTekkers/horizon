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
import { preflightPass } from './helpers/preflight.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-job-resume-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const dispatches = []
// HZ-415: item ids whose job dispatch farmd answers with this 400 body.
const farmRefusals = {}
// HO-842: item id -> (request) => farmd's /preflight answer (a fetch-shaped
// reply, a promise of one, or a throw). Absent: the clean pass. Every
// /preflight request is recorded, by item.
const preflightAnswers = {}
const preflightCalls = []
globalThis.fetch = async (url, opts) => {
  const preflight = preflightPass(url)
  if (preflight) {
    const body = opts?.body ? JSON.parse(opts.body) : null
    const itemId = body?.item?.id ?? ''
    preflightCalls.push({ itemId, body })
    if (Object.hasOwn(preflightAnswers, itemId)) return preflightAnswers[itemId](body)
    return preflight
  }
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

// A Task stopped at Execute with the plan approved. HZ-491: PLAN sets no
// runner, so the approved one is the repo's default at seed time.
function seedStoppedTask(id, repo = null) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, paused, approved_plan_hash, approved_runner, repo) VALUES (?, ?, 'High', ?, 'task', ?, 1, ?, ?, ?)",
  ).run(id, `Task ${id}`, EXECUTE_STEP_INDEX, projectId, sha256(PLAN), store.defaultRunnerFor(repo), repo)
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

// HZ-553 metric 4 (server leg): farmd's test-login file refusal is stored on
// the run with its path and cause, and the item waits for Resume.
test("HZ-553: farmd's login_env refusal is stored on the run, and the item does not stay running", async () => {
  const line = 'login_env_refused: test credentials env file /etc/x.env: the file does not exist'
  farmRefusals['T-553-LOGIN'] = { error: line }
  seedStoppedTask('T-553-LOGIN', 'FinTekkers/market-data-inputs')
  const res = await app.inject({ method: 'POST', url: '/api/items/T-553-LOGIN/job/resume', headers: cookie, payload: {} })
  assert.equal(res.statusCode, 200)
  const runId = res.json().runId
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(jobDispatchesFor('T-553-LOGIN').length, 1)
  const run = db.prepare('SELECT status, output FROM step_run WHERE id = ?').get(runId)
  assert.equal(run.status, 'cancelled')
  assert.equal(run.output, `FAILED: the farm refused the job: ${line}`)
  const item = store.getItem('T-553-LOGIN')
  assert.equal(item.activeRun ?? null, null)
  assert.equal(item.paused, true)
})

// HZ-491: the farm applies no runner default — a job it refuses for want of
// one is named on the run, not left running.
test("HZ-491: farmd's job_runner_missing refusal is named on the run", async () => {
  farmRefusals['T-491-NORUNNER'] = { error: 'job_runner_missing' }
  seedStoppedTask('T-491-NORUNNER')
  const res = await app.inject({ method: 'POST', url: '/api/items/T-491-NORUNNER/job/resume', headers: cookie, payload: {} })
  assert.equal(res.statusCode, 200)
  const runId = res.json().runId
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(jobDispatchesFor('T-491-NORUNNER')[0].body.runner, 'host')
  const run = db.prepare('SELECT status, output FROM step_run WHERE id = ?').get(runId)
  assert.equal(run.status, 'cancelled')
  assert.equal(run.output, 'FAILED: the job named no runner (host or container), so the farm refused it')
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

// HZ-416: the target's pinned image and limits ride in both Task dispatches —
// Run plan names the image, Execute runs in it. Unset, they are null and
// (HZ-491) a plan with no runner runs on the host. A change item's dispatch
// carries none of them.
test('HZ-416: the Run plan and Execute dispatches carry the container image and limits; a change item dispatch carries none', async () => {
  const mdi = 'FinTekkers/market-data-inputs'
  const image = `docker.io/library/python@sha256:${'c'.repeat(64)}`
  db.prepare("UPDATE deploy_target SET container_image = ?, cpu_limit = '1.5', memory_limit = '2g' WHERE repo = ?").run(image, mdi)
  try {
    db.prepare(
      "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo) VALUES ('T-416-PLAN', 'Plan', 'High', ?, 'task', ?, ?)",
    ).run(RUN_PLAN_STEP_INDEX, projectId, mdi)
    db.prepare(
      "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo) VALUES ('C-416', 'Change', 'High', ?, 'change', ?, ?)",
    ).run(DRAFT_PLAN_STEP_INDEX, projectId, mdi)
    seedStoppedTask('T-416-EXEC', mdi)
    orchestrator.kick('T-416-PLAN')
    orchestrator.kick('C-416')
    const res = await app.inject({ method: 'POST', url: '/api/items/T-416-EXEC/job/resume', headers: cookie, payload: {} })
    assert.equal(res.statusCode, 200)
    await new Promise((r) => setTimeout(r, 30))

    const plan = jobDispatchesFor('T-416-PLAN').find((d) => d.body.step.index === RUN_PLAN_STEP_INDEX)
    const [execute] = jobDispatchesFor('T-416-EXEC')
    for (const body of [plan.body, execute.body]) {
      assert.equal(body.runner, 'container')
      assert.equal(body.container_image, image)
      assert.equal(body.cpu_limit, '1.5')
      assert.equal(body.memory_limit, '2g')
    }
    const [change] = jobDispatchesFor('C-416')
    for (const key of ['container_image', 'cpu_limit', 'memory_limit', 'runner']) assert.equal(Object.hasOwn(change.body, key), false)
  } finally {
    db.prepare('UPDATE deploy_target SET container_image = NULL, cpu_limit = NULL, memory_limit = NULL WHERE repo = ?').run(mdi)
    for (const id of ['T-416-PLAN', 'C-416', 'T-416-EXEC']) orchestrator.cancel(id)
  }
  const id = 'T-416-UNSET'
  seedStoppedTask(id, mdi)
  const res = await app.inject({ method: 'POST', url: `/api/items/${id}/job/resume`, headers: cookie, payload: {} })
  assert.equal(res.statusCode, 200)
  await new Promise((r) => setTimeout(r, 30))
  const [execute] = jobDispatchesFor(id)
  orchestrator.cancel(id)
  assert.equal(execute.body.container_image, null)
  assert.equal(execute.body.runner, 'host', 'no image pinned: a plan with no runner runs on the host')
})

// ---- HO-842: Re-check and run ----
// After the dispatch re-check (HO-838) refused for a missing env var, the
// fixed host is re-checked and the same approved plan resumes: no PIN, no
// send-back, one dispatch at a time, one Activity entry per click past auth.

const { loginFixtureToken } = await import('./helpers/session.mjs')
const MDI = 'MDI_DB_URL'
const csrfCookie = { ...cookie, 'x-horizon-csrf': '1' }
const recheckRun = (id, headers = csrfCookie) => app.inject({ method: 'POST', url: `/api/items/${id}/job/recheck-run`, headers, payload: {} })
const farmReply = (data, status = 200) => ({ ok: status < 300, status, json: async () => data })
const PREFLIGHT_PASS = { ok: true, failed: [], unmet: [], deferred: [], elapsed_ms: 0 }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await wait(10)
  }
  assert.fail(`never happened: ${what}`)
}
const approval = (id) => db.prepare('SELECT approved_plan_hash, approved_runner FROM work_item WHERE id = ?').get(id)
const eventRows = (id) => db.prepare('SELECT who, text, detail, created_at FROM event WHERE item_id = ? ORDER BY id').all(id)
const recheckEntries = (id) => eventRows(id).filter((e) => e.text.startsWith('Re-check and run by '))
const preflightCallsFor = (id) => preflightCalls.filter((c) => c.itemId === id).length

// The host as the fake farm sees it: item id -> env names missing there.
const hostMissing = {}
function farmChecksHost(id) {
  preflightAnswers[id] = () => {
    const missing = hostMissing[id] ?? []
    if (!missing.length) return farmReply(PREFLIGHT_PASS)
    return farmReply({ ok: false, failed: missing, unmet: missing.map((name) => ({ kind: 'env', name, reason: "not set in the job's environment" })) })
  }
}

// A stopped Task whose Execute dispatch HO-838's re-check refused for a
// missing MDI_DB_URL: the real refusal, run through refuseUnapprovedRun.
async function seedRefusedTask(id, { jobView = null } = {}) {
  seedStoppedTask(id)
  if (jobView) {
    db.prepare(
      "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, job_view, ended_at) VALUES (?, ?, 1, ?, 'cancelled', 'STOPPED: the run was stopped with 1 command(s) done', ?, datetime('now'))",
    ).run(id, EXECUTE_STEP_INDEX, STEPS[EXECUTE_STEP_INDEX].agent, JSON.stringify(jobView))
  }
  hostMissing[id] = [MDI]
  farmChecksHost(id)
  const runId = Number(
    db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 2, ?, 'active')").run(id, EXECUTE_STEP_INDEX, STEPS[EXECUTE_STEP_INDEX].agent).lastInsertRowid,
  )
  const refused = await orchestrator.refuseUnapprovedRun(runId, id, EXECUTE_STEP_INDEX)
  assert.equal(refused?.error, REASON.PREREQ_DRIFT)
  assert.equal(store.getItem(id).paused, true)
}

// Metric 5: exactly one entry for the item's clicks so far — Alice's name as
// who, her login in the text, and a timestamp from the last minute.
function assertRecheckEntries(id, patterns) {
  const entries = recheckEntries(id)
  assert.equal(entries.length, patterns.length, JSON.stringify(entries))
  entries.forEach((entry, i) => {
    assert.equal(entry.who, 'Alice')
    assert.ok(entry.text.startsWith('Re-check and run by alice@example.com: '), entry.text)
    assert.match(entry.text, patterns[i])
    const at = Date.parse(`${entry.created_at.replace(' ', 'T')}Z`)
    assert.ok(Number.isFinite(at) && Math.abs(Date.now() - at) < 60_000, `recent created_at: ${entry.created_at}`)
  })
}

test('HO-842 metric 1: once the var is back, Re-check and run with no PIN dispatches the stored approved_plan_hash on the stored approved_runner', async () => {
  const id = 'T-842-M1'
  await seedRefusedTask(id)
  const before = approval(id)
  assert.match(alice.pin, /^\d{6}$/, 'alice has a gate PIN, and is not asked for it')

  hostMissing[id] = []
  const res = await recheckRun(id)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().ok, true)
  assert.equal(typeof res.json().runId, 'number')
  assert.equal(res.json().item.paused, false)
  await until(() => jobDispatchesFor(id).length === 1, 'the job dispatch')
  const [dispatch] = jobDispatchesFor(id)
  assert.equal(dispatch.body.approved_hash, before.approved_plan_hash)
  assert.equal(dispatch.body.runner, before.approved_runner)
  assert.equal(dispatch.body.step.index, EXECUTE_STEP_INDEX)
  // The refusal, the route's re-check, then dispatch's own (refuseUnapprovedRun).
  assert.equal(preflightCallsFor(id), 3)
  assertRecheckEntries(id, [/re-check passed — run \d+ started$/])
  orchestrator.cancel(id)
})

test('HO-842 metric 1: after the 200 the item is still at Execute — no send-back, approved hash and runner unchanged', async () => {
  const id = 'T-842-M1-STAY'
  await seedRefusedTask(id)
  const before = approval(id)
  hostMissing[id] = []
  assert.equal((await recheckRun(id)).statusCode, 200)
  await until(() => jobDispatchesFor(id).length === 1, 'the job dispatch')
  assert.equal(store.getItem(id).cursor, EXECUTE_STEP_INDEX)
  assert.deepEqual(approval(id), before)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_move WHERE item_id = ?').get(id).n, 0)
  assert.ok(!eventRows(id).some((e) => /moved this item back|sent back|returned/i.test(e.text)), JSON.stringify(eventRows(id)))
  orchestrator.cancel(id)
})

test('HO-842 metric 2: a changed run plan is 409 plan_changed with a reason — zero re-checks, zero dispatches, nothing moves', async () => {
  const id = 'T-842-M2'
  await seedRefusedTask(id)
  hostMissing[id] = []
  doneRun(id, RUN_PLAN_STEP_INDEX, PLAN.replace('scripts/a.sh', 'scripts/edited.sh'))
  const before = approval(id)
  const checks = preflightCallsFor(id)

  const res = await recheckRun(id)
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'plan_changed')
  assert.match(res.json().message, /changed since it was approved/)
  await wait(30)
  assert.equal(preflightCallsFor(id), checks, 'no re-check ran')
  assert.equal(jobDispatchesFor(id).length, 0)
  const item = store.getItem(id)
  assert.equal(item.cursor, EXECUTE_STEP_INDEX)
  assert.equal(item.paused, true)
  assert.deepEqual(approval(id), before)
  assertRecheckEntries(id, [/refused — plan_changed$/])
})

test('HO-842 metric 3: the var still missing is 409 prerequisites_unmet listing it by name, and zero commands dispatch', async () => {
  const id = 'T-842-M3'
  await seedRefusedTask(id)
  const res = await recheckRun(id)
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'prerequisites_unmet')
  assert.deepEqual(res.json().unmet, [{ kind: 'env', name: MDI }])
  await wait(30)
  assert.equal(jobDispatchesFor(id).length, 0)
  assert.equal(store.getItem(id).paused, true)
  assertRecheckEntries(id, [/refused — prerequisites_unmet — unmet: env MDI_DB_URL$/])
})

test('HO-842 metric 4: the re-run dispatch equals a plain Resume dispatch on approved_hash, runner, step index and plan — the keys task_job.py skips passed commands on', async () => {
  const view = {
    status: 'stopped',
    elapsedS: 5,
    budgetS: 1200,
    commands: [
      { command: 'scripts/a.sh', status: 'done', exit_code: 0 },
      { command: 'scripts/b.sh', status: 'stopped', exit_code: null },
    ],
    logTail: [],
  }
  const id = 'T-842-M4'
  const twin = 'T-842-M4-RESUME'
  await seedRefusedTask(id, { jobView: view })
  seedStoppedTask(twin)
  hostMissing[id] = []
  assert.equal((await recheckRun(id)).statusCode, 200)
  assert.equal((await app.inject({ method: 'POST', url: `/api/items/${twin}/job/resume`, headers: cookie, payload: {} })).statusCode, 200)
  await until(() => jobDispatchesFor(id).length === 1 && jobDispatchesFor(twin).length === 1, 'both dispatches')

  const [rerun] = jobDispatchesFor(id)
  const [resumed] = jobDispatchesFor(twin)
  assert.equal(rerun.body.item.id, id)
  const keys = ({ run_id: _r, attempt: _a, item: _i, ...rest }) => rest
  assert.deepEqual(keys(rerun.body), keys(resumed.body))
  assert.equal(rerun.body.approved_hash, approval(id).approved_plan_hash)
  assert.equal(rerun.body.runner, approval(id).approved_runner)
  assert.equal(rerun.body.step.index, EXECUTE_STEP_INDEX)
  orchestrator.cancel(id)
  orchestrator.cancel(twin)
})

test('HO-842 metric 5: a refused click and then a dispatched click each write one entry with the login and a timestamp', async () => {
  const id = 'T-842-M5'
  await seedRefusedTask(id)
  assert.equal((await recheckRun(id)).statusCode, 409)
  hostMissing[id] = []
  assert.equal((await recheckRun(id)).statusCode, 200)
  await until(() => jobDispatchesFor(id).length === 1, 'the job dispatch')
  assertRecheckEntries(id, [/refused — prerequisites_unmet/, /re-check passed — run \d+ started$/])
  orchestrator.cancel(id)
})

test('HO-842 guardrail 2: a token, a cross-site request, a request with no CSRF header and a non-member are refused, write no entry and dispatch nothing; a Change item is 409 not_task', async () => {
  const id = 'T-842-AUTH'
  await seedRefusedTask(id)
  hostMissing[id] = []
  const checks = preflightCallsFor(id)
  const token = loginFixtureToken(auth, alice.user, 'ho-842 token')
  const outsider = loginFixtureUser(auth, config, { email: 'outsider-842@example.com', name: 'Outsider', role: 'member' })
  const cases = [
    ['token', { ...token.headers, 'x-horizon-csrf': '1' }, 403, 'session_required'],
    ['cross-site', { ...csrfCookie, origin: 'https://evil.example' }, 403, 'cross_site_refused'],
    ['no csrf header', cookie, 403, 'csrf_required'],
    ['non-member', { cookie: outsider.cookie, 'x-horizon-csrf': '1' }, 404, 'not_found'],
  ]
  for (const [name, headers, status, error] of cases) {
    const res = await recheckRun(id, headers)
    assert.equal(res.statusCode, status, `${name}: ${res.body}`)
    assert.equal(res.json().error, error, name)
  }
  await wait(30)
  assert.equal(recheckEntries(id).length, 0)
  assert.equal(preflightCallsFor(id), checks)
  assert.equal(jobDispatchesFor(id).length, 0)
  assert.equal(store.getItem(id).paused, true)

  const change = 'C-842-AUTH'
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, paused) VALUES (?, 'Change', 'High', ?, 'change', ?, 1)").run(
    change,
    DRAFT_PLAN_STEP_INDEX,
    projectId,
  )
  const res = await recheckRun(change)
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'not_task')
  assert.equal(preflightCallsFor(change), 0)
  assert.equal(jobDispatchesFor(change).length, 0)
  assertRecheckEntries(change, [/refused — not_task$/])
})

// Plain Resume after a refusal stays open (to tokens too): it reaches
// dispatch only through refuseUnapprovedRun, whose re-check still refuses
// while the host misses the var.
test('HO-842 guardrail 2: a plain Resume after the refusal is accepted, and the dispatch re-check still gates it', async () => {
  const id = 'T-842-PLAIN'
  await seedRefusedTask(id)
  const token = loginFixtureToken(auth, alice.user, 'ho-842 resume token')
  const res = await app.inject({ method: 'POST', url: `/api/items/${id}/job/resume`, headers: token.headers, payload: {} })
  assert.equal(res.statusCode, 200, res.body)
  await until(() => store.getItem(id).paused, 'the dispatch re-check refuses again')
  assert.equal(jobDispatchesFor(id).length, 0, 'no command dispatched while MDI_DB_URL is missing')
  assert.equal(eventRows(id).filter((e) => e.text.includes(`(${REASON.PREREQ_DRIFT})`)).length, 2)
})

test('HO-842 guardrail 1: a re-check that cannot run is 502 recheck_unavailable — fail closed, zero dispatches, one entry', async () => {
  const id = 'T-842-DOWN'
  await seedRefusedTask(id)
  preflightAnswers[id] = () => {
    throw new TypeError('fetch failed')
  }
  const res = await recheckRun(id)
  assert.equal(res.statusCode, 502)
  assert.equal(res.json().error, 'recheck_unavailable')
  await wait(30)
  assert.equal(jobDispatchesFor(id).length, 0)
  assert.equal(store.getItem(id).paused, true)
  assertRecheckEntries(id, [/refused — recheck_unavailable$/])
})

// The route's re-check is held open until `release()`; dispatch's own re-check after it passes.
function holdRecheck(id) {
  let release
  let calls = 0
  preflightAnswers[id] = () => (++calls === 1 ? new Promise((resolve) => (release = () => resolve(farmReply(PREFLIGHT_PASS)))) : farmReply(PREFLIGHT_PASS))
  return { release: () => release(), started: () => calls >= 1 }
}

test('HO-842 guardrail 3: two clicks at once — one 200, one 409 already_running, one dispatch, two entries', async () => {
  const id = 'T-842-DOUBLE'
  await seedRefusedTask(id)
  const held = holdRecheck(id)
  const first = recheckRun(id)
  await until(held.started, 'the first re-check started')
  const second = await recheckRun(id)
  assert.equal(second.statusCode, 409)
  assert.equal(second.json().error, 'already_running')
  held.release()
  assert.equal((await first).statusCode, 200)
  await until(() => jobDispatchesFor(id).length === 1, 'the job dispatch')
  await wait(30)
  assert.equal(jobDispatchesFor(id).length, 1)
  assertRecheckEntries(id, [/refused — already_running$/, /re-check passed — run \d+ started$/])
  orchestrator.cancel(id)
})

test('HO-842 guardrail 3: a plain Resume while the re-check is open is 409 already_running — one dispatch in total', async () => {
  const id = 'T-842-RACE'
  await seedRefusedTask(id)
  const held = holdRecheck(id)
  const first = recheckRun(id)
  await until(held.started, 'the re-check started')
  const resume = await app.inject({ method: 'POST', url: `/api/items/${id}/job/resume`, headers: cookie, payload: {} })
  assert.equal(resume.statusCode, 409)
  assert.equal(resume.json().error, 'already_running')
  held.release()
  assert.equal((await first).statusCode, 200)
  await until(() => jobDispatchesFor(id).length === 1, 'the job dispatch')
  await wait(30)
  assert.equal(jobDispatchesFor(id).length, 1)
  orchestrator.cancel(id)
})

test('HO-842 guardrail 3: with an Execute run already active, Re-check and run is 409 already_running — zero re-checks, zero dispatches', async () => {
  const id = 'T-842-ACTIVE'
  await seedRefusedTask(id)
  hostMissing[id] = []
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 3, ?, 'active')").run(id, EXECUTE_STEP_INDEX, STEPS[EXECUTE_STEP_INDEX].agent)
  const checks = preflightCallsFor(id)
  const res = await recheckRun(id)
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'already_running')
  await wait(30)
  assert.equal(preflightCallsFor(id), checks)
  assert.equal(jobDispatchesFor(id).length, 0)
  assertRecheckEntries(id, [/refused — already_running$/])
  orchestrator.cancel(id)
})

test('HO-842 guardrail 4: a secret value and file content never reach the log, the response, an entry or a run output', async () => {
  const MARKER = 'hz842-secret-value-7f3a'
  const logs = []
  const logged = buildApp({ logger: { level: 'trace', stream: { write: (line) => logs.push(line) } } })
  await logged.ready()
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  for (const name of Object.keys(original)) console[name] = (...args) => logs.push(args.map(String).join(' '))
  process.env.MDI_DB_URL = MARKER
  try {
    const id = 'T-842-SECRET'
    await seedRefusedTask(id)
    const unmetWithValues = [
      { kind: 'env', name: MDI, reason: "not set in the job's environment", value: MARKER },
      { kind: 'file', name: '/etc/fintekkers/creds.json', reason: 'not readable by the run user', content: MARKER },
    ]
    preflightAnswers[id] = () => farmReply({ ok: false, failed: [MDI, '/etc/fintekkers/creds.json'], unmet: unmetWithValues, value: MARKER })
    const post = () => logged.inject({ method: 'POST', url: `/api/items/${id}/job/recheck-run`, headers: csrfCookie, payload: {} })
    const refused = await post()
    assert.equal(refused.statusCode, 409)
    assert.deepEqual(refused.json().unmet, [
      { kind: 'env', name: MDI },
      { kind: 'file', name: '/etc/fintekkers/creds.json' },
    ])
    farmChecksHost(id)
    hostMissing[id] = []
    const passed = await post()
    assert.equal(passed.statusCode, 200)
    await until(() => jobDispatchesFor(id).length === 1, 'the job dispatch')
    orchestrator.cancel(id)

    assert.ok(logs.length > 0, 'the capture logger saw the requests')
    const outputs = db.prepare('SELECT output FROM step_run WHERE item_id = ?').all(id).map((r) => r.output ?? '')
    const seen = [
      ...logs,
      refused.body,
      passed.body,
      ...eventRows(id).flatMap((e) => [e.text, e.detail ?? '']),
      ...outputs,
      JSON.stringify(jobDispatchesFor(id)),
    ]
    for (const text of seen) assert.ok(!String(text).includes(MARKER), `the marker leaked: ${String(text).slice(0, 300)}`)
  } finally {
    Object.assign(console, original)
    delete process.env.MDI_DB_URL
    await logged.close()
  }
})
