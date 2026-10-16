// HZ-407: the Execute card's Stop run and Resume, and the live job view they
// act on. Stop ends the job, records the running command `stopped` and pauses
// the item; a late nudge never overwrites that; both buttons need the same
// login as Pause; Resume reruns the approved plan unchanged and approves nothing.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-job-stop-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = 'farm-secret-hz407'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

// The farm: /jobs/stop answers with `stopAnswer` (a status and body, or a throw).
const calls = []
let stopAnswer = null
const LOG_PAGES = ['$ scripts/a.sh\nkey=[redacted]\n', 'exit 0\n']
globalThis.fetch = async (url, opts) => {
  const href = String(url)
  calls.push({ url: href, body: opts?.body ? JSON.parse(opts.body) : null })
  if (href.endsWith('/jobs/stop')) {
    if (stopAnswer instanceof Error) throw stopAnswer
    return { ok: true, status: 200, json: async () => stopAnswer ?? {} }
  }
  const log = /\/jobs\/\d+\/log\?offset=(\d+)/.exec(href)
  if (log) {
    const page = Number(log[1]) === 0 ? 0 : Number(log[1]) === LOG_PAGES[0].length ? 1 : 2
    const content = LOG_PAGES[page] ?? ''
    return { ok: true, status: 200, json: async () => ({ content, next_offset: Number(log[1]) + content.length, active: false }) }
  }
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
const farmHeaders = { 'x-farm-secret': config.FARM_SHARED_SECRET }
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const PLAN =
  '## Commands\n1. three steps\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '/tmp', commands: ['scripts/a.sh', 'scripts/b.sh', 'scripts/c.sh'], budget_minutes: 20 }, null, 2) +
  '\n```'
const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Jobs project', 1)").run().lastInsertRowid)

const view = (statuses, extra = {}) => ({
  status: 'running',
  elapsedS: 42,
  budgetS: 1200,
  startedAt: '2026-10-11T10:00:00+00:00',
  updatedAt: '2026-10-11T10:00:42+00:00',
  commands: ['scripts/a.sh', 'scripts/b.sh', 'scripts/c.sh'].map((command, i) => ({
    command,
    status: statuses[i],
    exit_code: statuses[i] === 'done' ? 0 : null,
  })),
  logTail: ['$ scripts/b.sh', 'working…'],
  ...extra,
})

// A Task running Execute: plan approved, the job dispatched.
async function seedRunningTask(id) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, approved_plan_hash, approved_runner) VALUES (?, ?, 'High', ?, 'task', ?, ?, 'host')",
  ).run(id, `Task ${id}`, EXECUTE_STEP_INDEX, projectId, sha256(PLAN))
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
  ).run(id, RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, PLAN)
  orchestrator.kick(id)
  await wait(20)
  return store.activeJobRun(id).id
}

const progress = (runId, body) => app.inject({ method: 'POST', url: `/api/farm/steps/${runId}/progress`, headers: farmHeaders, payload: body })
const jobOf = (id) => store.itemStepOutputs(id)[EXECUTE_STEP_INDEX]?.job

test('a progress frame is stored on the run and carried in the Execute entry, whitelisted', async () => {
  const runId = await seedRunningTask('T-407-P')
  const res = await progress(runId, { ...view(['done', 'running', 'pending']), env: { SECRET: 'leaky-env-value' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true })
  const job = jobOf('T-407-P')
  assert.deepEqual(
    job.commands.map((c) => c.status),
    ['done', 'running', 'pending'],
  )
  assert.deepEqual(job.logTail, ['$ scripts/b.sh', 'working…'])
  assert.equal(job.budgetS, 1200)
  assert.ok(!('env' in job))
  assert.ok(!JSON.stringify(store.itemStepOutputs('T-407-P')).includes('leaky-env-value'))
  // A running Execute step is not done: its entry carries the job only.
  assert.equal(store.itemStepOutputs('T-407-P')[EXECUTE_STEP_INDEX].output, undefined)

  assert.equal((await progress(runId, { commands: [], logTail: Array(21).fill('x') })).statusCode, 400)
  const unauth = await app.inject({ method: 'POST', url: `/api/farm/steps/${runId}/progress`, payload: view(['done', 'done', 'running']) })
  assert.equal(unauth.statusCode, 401)
})

test('Stop run ends the job, records command 2 stopped, pauses the item; a second Stop is 409', async () => {
  const runId = await seedRunningTask('T-407-S')
  await progress(runId, view(['done', 'running', 'pending']))
  stopAnswer = { ok: true, killed: true, commandsDone: 1, view: view(['done', 'stopped', 'pending'], { status: 'stopped' }) }

  const res = await app.inject({ method: 'POST', url: '/api/items/T-407-S/job/stop', headers: cookie })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().paused, true)
  assert.equal(res.json().commandsDone, 1)
  assert.equal(res.json().item.paused, true)
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status, 'cancelled')
  assert.equal(store.getItem('T-407-S').paused, true)
  const job = jobOf('T-407-S')
  assert.equal(job.status, 'stopped')
  assert.deepEqual(
    job.commands.map((c) => c.status),
    ['done', 'stopped', 'pending'],
  )

  const again = await app.inject({ method: 'POST', url: '/api/items/T-407-S/job/stop', headers: cookie })
  assert.equal(again.statusCode, 409)
  assert.equal(again.json().error, 'no_job')
  assert.equal((await app.inject({ method: 'POST', url: '/api/items/NOPE/job/stop', headers: cookie })).statusCode, 404)
})

test('a progress frame that lands after Stop is stale and leaves the stopped view alone', async () => {
  const runId = await seedRunningTask('T-407-L')
  stopAnswer = { ok: true, commandsDone: 1, view: view(['done', 'stopped', 'pending'], { status: 'stopped' }) }
  assert.equal((await app.inject({ method: 'POST', url: '/api/items/T-407-L/job/stop', headers: cookie })).statusCode, 200)
  const before = JSON.stringify(jobOf('T-407-L'))

  const late = await progress(runId, view(['done', 'running', 'pending'], { logTail: ['late line'] }))
  assert.equal(late.statusCode, 200)
  assert.deepEqual(late.json(), { ok: true, stale: true })
  assert.equal(JSON.stringify(jobOf('T-407-L')), before)
})

test('with the farm unreachable, Stop still settles the last stored view: running becomes stopped', async () => {
  const runId = await seedRunningTask('T-407-U')
  await progress(runId, view(['done', 'running', 'pending']))
  stopAnswer = new TypeError('fetch failed')
  const res = await app.inject({ method: 'POST', url: '/api/items/T-407-U/job/stop', headers: cookie })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().commandsDone, 1)
  const job = jobOf('T-407-U')
  assert.equal(job.status, 'stopped')
  assert.deepEqual(
    job.commands.map((c) => c.status),
    ['done', 'stopped', 'pending'],
  )
  stopAnswer = null
})

test('Stop run and Resume need the same login as Pause and Resume work', async () => {
  await seedRunningTask('T-407-A')
  for (const [url, payload] of [
    ['/api/items/T-407-A/job/stop', undefined],
    ['/api/items/T-407-A/job/resume', undefined],
    ['/api/items/T-407-A/pause', { paused: true }],
    ['/api/items/T-407-A/pause', { paused: false }],
  ]) {
    const res = await app.inject({ method: 'POST', url, payload })
    assert.equal(res.statusCode, 401, url)
  }
  assert.ok(store.activeJobRun('T-407-A'), 'nothing was stopped without a login')
  orchestrator.cancel('T-407-A')
})

test('Resume after Stop reruns the approved plan byte for byte and records no approval', async () => {
  await seedRunningTask('T-407-R')
  stopAnswer = { ok: true, commandsDone: 1, view: view(['done', 'stopped', 'pending'], { status: 'stopped' }) }
  await app.inject({ method: 'POST', url: '/api/items/T-407-R/job/stop', headers: cookie })
  const approvalEvents = () =>
    db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = ? AND text LIKE '%approv%'").get('T-407-R').n
  const eventsBefore = approvalEvents()
  const dispatchesBefore = calls.filter((c) => c.url.includes('/steps/run') && c.body?.item?.id === 'T-407-R').length

  const res = await app.inject({ method: 'POST', url: '/api/items/T-407-R/job/resume', headers: cookie })
  assert.equal(res.statusCode, 200)
  await wait(30)
  const dispatches = calls.filter((c) => c.url.includes('/steps/run') && c.body?.item?.id === 'T-407-R')
  assert.equal(dispatches.length, dispatchesBefore + 1)
  const sent = dispatches.at(-1).body
  assert.equal(sent.plan_artifact, PLAN)
  assert.equal(sent.approved_hash, sha256(PLAN))
  assert.equal(db.prepare('SELECT approved_plan_hash FROM work_item WHERE id = ?').get('T-407-R').approved_plan_hash, sha256(PLAN))
  assert.equal(approvalEvents(), eventsBefore)
  // The new run starts with no view of its own; the card shows the stopped
  // one only until the runner's first nudge.
  assert.equal(db.prepare('SELECT job_view FROM step_run WHERE id = ?').get(store.activeJobRun('T-407-R').id).job_view, null)
  orchestrator.cancel('T-407-R')
  stopAnswer = null
})

test('the full log is served after Stop as plain text, and only with a login', async () => {
  await seedRunningTask('T-407-G')
  stopAnswer = { ok: true, commandsDone: 1, view: view(['done', 'stopped', 'pending'], { status: 'stopped' }) }
  await app.inject({ method: 'POST', url: '/api/items/T-407-G/job/stop', headers: cookie })
  assert.equal(store.activeJobRun('T-407-G'), null)

  const res = await app.inject({ method: 'GET', url: '/api/items/T-407-G/job/log?format=text', headers: cookie })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8')
  assert.equal(res.body, LOG_PAGES.join(''))
  const logCall = calls.filter((c) => c.url.includes('/log?')).at(-1)
  assert.match(logCall.url, /item_id=T-407-G/)

  const anon = await app.inject({ method: 'GET', url: '/api/items/T-407-G/job/log?format=text' })
  assert.equal(anon.statusCode, 401)
  stopAnswer = null
})
