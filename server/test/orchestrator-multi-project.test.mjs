// HZ-207: one farm dispatches every enabled project's items. Enabling or
// disabling a project is a flag write: no farm restart, and no step in any
// project is cancelled. Each /steps/run carries its own project and repo.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-multi-project-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire during these tests
process.env.FARM_STEP_TIMEOUT_MS = '600000'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.FARM_RECOVERY_POLL_MS = String(60 * 60 * 1000)
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const settings = await import('../src/settings.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

store.purgeDemoItems()

const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
const inject = (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie } })
await app.ready()

// The fake farm: records every call; /steps/run refuses a task without a
// repo exactly as farmd does.
const calls = []
globalThis.fetch = async (url, opts) => {
  const path = new URL(String(url)).pathname
  const body = opts?.body ? JSON.parse(opts.body) : null
  calls.push({ path, body })
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data })
  if (path === '/farm/status') return reply(200, { status: 'running' })
  if (path === '/runs/alive') return reply(200, { alive: Object.fromEntries((body.run_ids || []).map((id) => [id, true])) })
  if (path === '/steps/run' && !body.item.repo) return reply(400, { error: 'missing item.repo' })
  return reply(200, { ok: true })
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} }

after(async () => {
  // Release the in-flight runs' watchdog timers so the process can exit.
  for (const { item_id: id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) {
    orchestrator.cancel(id)
  }
  await app.close()
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const posted = (itemId) => calls.filter((c) => c.path === '/steps/run' && c.body.item.id === itemId)
const activeRun = (itemId) => db.prepare("SELECT * FROM step_run WHERE item_id = ? AND status = 'active'").get(itemId)
const itemRow = (itemId) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(itemId)
const enabledOf = (projectId) => db.prepare('SELECT enabled FROM project WHERE id = ?').get(projectId).enabled

async function until(predicate, what) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
    await wait(10)
  }
}

// ---- metric 1: the enabled flag's defaults for a new project ----

test('createProject: the first project is enabled, later ones start disabled, and listProjects says so as a boolean', () => {
  const horizon = store.createProject('Horizon')
  const fintekkers = store.createProject('FinTekkers')
  assert.equal(enabledOf(horizon.id), 1)
  assert.equal(enabledOf(fintekkers.id), 0)
  const listed = Object.fromEntries(store.listProjects().map((p) => [p.name, p.enabled]))
  assert.deepEqual(listed, { FinTekkers: false, Horizon: true })
})

const projectId = (name) => store.listProjects().find((p) => p.name === name).id
const HORIZON = () => projectId('Horizon')
const FINTEKKERS = () => projectId('FinTekkers')

function seed() {
  const horizon = HORIZON()
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'FinTekkers/horizon', 'HZ')").run(horizon)
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'FinTekkers/ui-service', 'US')").run(FINTEKKERS())
  const insert = db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo, project_id) VALUES (?, ?, 'Medium', 0, ?, ?)")
  insert.run('HZ-1', 'Horizon work', 'FinTekkers/horizon', horizon)
  insert.run('US-1', 'FinTekkers work', 'FinTekkers/ui-service', FINTEKKERS())
  return horizon
}

// ---- metric 1: both enabled projects dispatch in the same pass ----

test('with Horizon and FinTekkers enabled, one dispatch pass posts both ready items, each with its own project and repo', async () => {
  orchestrator.setProjectEnabled(FINTEKKERS(), true, silentLog)
  const horizon = seed()
  assert.equal(posted('HZ-1').length + posted('US-1').length, 0, 'nothing dispatches before the farm is up')

  // init() brings the farm up and runs exactly one resume pass.
  await orchestrator.init(silentLog)
  await until(() => posted('HZ-1').length && posted('US-1').length, 'both dispatches')

  assert.equal(calls.filter((c) => c.path === '/farm/start').length, 1)
  const [h] = posted('HZ-1')
  const [f] = posted('US-1')
  assert.deepEqual(h.body.project, { id: horizon, name: 'Horizon' })
  assert.equal(h.body.item.repo, 'FinTekkers/horizon')
  assert.deepEqual(f.body.project, { id: FINTEKKERS(), name: 'FinTekkers' })
  assert.equal(f.body.item.repo, 'FinTekkers/ui-service')
  assert.equal(settings.getSetting('farm_project_id'), String(horizon), 'the farm is pinned to the project it started for')
})

// ---- metric 1 / guardrail: a disabled project is never dispatched or changed ----

test('a disabled project: its ready items are never dispatched and their rows are left byte-identical', async () => {
  assert.deepEqual(orchestrator.setProjectEnabled(FINTEKKERS(), false, silentLog), { ok: true, enabled: false })
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo, project_id) VALUES ('US-2', 'Ready', 'Medium', 0, 'FinTekkers/ui-service', ?)").run(FINTEKKERS())
  const before = itemRow('US-2')

  orchestrator.kick('US-2')
  orchestrator.setProjectEnabled(HORIZON(), true, silentLog) // another project's enable-kick pass
  await wait(50)

  assert.equal(posted('US-2').length, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ?').get('US-2').n, 0)
  assert.deepEqual(itemRow('US-2'), before)
})

// ---- metric 2: toggling never restarts the farm or cancels a step ----

test('toggling FinTekkers and activating it while a Horizon step is in flight: no restart, no cancel, and the step completes', async () => {
  const run = activeRun('HZ-1')
  assert.ok(run, 'a Horizon step is in flight')
  const from = calls.length
  const statuses = []
  const off = store.onChange(() => statuses.push(orchestrator.getFarmState().status))

  for (const enabled of [true, false, true]) {
    const res = await inject({ method: 'POST', url: `/api/projects/${FINTEKKERS()}/enabled`, payload: { enabled } })
    assert.deepEqual(res.json(), { ok: true, enabled })
  }
  const activate = await inject({ method: 'POST', url: `/api/projects/${FINTEKKERS()}/activate` })
  assert.equal(activate.statusCode, 200)
  assert.deepEqual(activate.json(), { ok: true, restarting: false })
  // The recovery probe sees the board on FinTekkers: still no restart.
  orchestrator.ensureFarm(silentLog)
  await wait(50)
  off()

  const farmCalls = calls.slice(from).map((c) => c.path)
  assert.ok(!farmCalls.includes('/farm/stop') && !farmCalls.includes('/farm/start'), farmCalls.join(', '))
  assert.ok(!calls.slice(from).some((c) => c.path === '/steps/cancel' && c.body.run_id === run.id))
  assert.ok(statuses.length > 0 && !statuses.includes('restarting'), statuses.join(', '))
  assert.equal(orchestrator.getFarmState().status, 'running')
  assert.equal(enabledOf(HORIZON()), 1, 'activating FinTekkers leaves Horizon enabled')
  assert.equal(activeRun('HZ-1').id, run.id)

  await orchestrator.completeFarmRun(run.id, { summary: 'outcome defined' })
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(run.id).status, 'done')
  assert.equal(itemRow('HZ-1').cursor, 1)
})

// ---- guardrail: disabling never kills the disabled project's own step ----

test('disabling FinTekkers while its own step is in flight: no cancel, no farm call, the step completes, nothing new starts', async () => {
  const run = activeRun('US-1')
  assert.ok(run, 'a FinTekkers step is in flight')
  const from = calls.length
  const res = await inject({ method: 'POST', url: `/api/projects/${FINTEKKERS()}/enabled`, payload: { enabled: false } })
  assert.deepEqual(res.json(), { ok: true, enabled: false })
  await wait(50)
  assert.deepEqual(calls.slice(from), [], 'a disable makes no farm call at all')
  assert.equal(activeRun('US-1').id, run.id)

  const dispatched = posted('US-1').length
  await orchestrator.completeFarmRun(run.id, { summary: 'outcome defined' })
  await wait(50)
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(run.id).status, 'done')
  assert.equal(itemRow('US-1').cursor, 1)
  assert.equal(posted('US-1').length, dispatched, 'no new FinTekkers step is posted')
})

// ---- the /api/projects/:id/enabled contract ----

test('POST /api/projects/:id/enabled: 400 on a missing or non-boolean value, 404 on no project, 409 on the farm project', async () => {
  const url = `/api/projects/${FINTEKKERS()}/enabled`
  const missing = await inject({ method: 'POST', url, payload: {} })
  assert.equal(missing.statusCode, 400)
  assert.ok(missing.json().error)
  const yes = await inject({ method: 'POST', url, payload: { enabled: 'yes' } })
  assert.equal(yes.statusCode, 400)
  assert.ok(yes.json().error)
  // Pinned: Fastify's default coercion reads the string "true" as true.
  const coerced = await inject({ method: 'POST', url, payload: { enabled: 'true' } })
  assert.deepEqual(coerced.json(), { ok: true, enabled: true })
  const again = await inject({ method: 'POST', url, payload: { enabled: true } })
  assert.deepEqual(again.json(), { ok: true, enabled: true }, 're-enabling is idempotent')

  const none = await inject({ method: 'POST', url: '/api/projects/999999/enabled', payload: { enabled: true } })
  assert.equal(none.statusCode, 404)
  assert.deepEqual(none.json(), { error: 'Project not found' })

  const pinned = await inject({ method: 'POST', url: `/api/projects/${HORIZON()}/enabled`, payload: { enabled: false } })
  assert.equal(pinned.statusCode, 409)
  assert.deepEqual(pinned.json(), { error: 'farm_project_cannot_be_disabled' })
  assert.equal(enabledOf(HORIZON()), 1)

  const anonymous = await app.inject({ method: 'POST', url, payload: { enabled: false } })
  assert.equal(anonymous.statusCode, 401)
  assert.equal(enabledOf(FINTEKKERS()), 1)
})

// ---- guardrail: a task without a repo is refused, with the real reason ----

test('a repo-less item refused by the farm fails as "missing repo", not as an unreachable farm, and is not retried', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES ('HZ-NOREPO', 'No repo', 'Medium', 0, ?)").run(HORIZON())
  orchestrator.kick('HZ-NOREPO')
  await until(() => !activeRun('HZ-NOREPO'), 'the refused run to fail')
  await wait(20)

  const runs = db.prepare('SELECT output FROM step_run WHERE item_id = ?').all('HZ-NOREPO')
  assert.equal(runs.length, 1, 'no auto-retry')
  assert.match(runs[0].output, /^FAILED: missing repo/)
  assert.equal(posted('HZ-NOREPO').length, 1)
  const events = db.prepare('SELECT text FROM event WHERE item_id = ?').all('HZ-NOREPO').map((e) => e.text)
  assert.ok(!events.some((t) => /unreachable|transient/.test(t)), events.join(' | '))
})

// ---- metric 6: the farm project falls back to the board's project ----

test('getFarmProjectId falls back to active_project_id when it was never pinned', () => {
  const pinned = settings.getSetting('farm_project_id')
  db.prepare("DELETE FROM setting WHERE key = 'farm_project_id'").run()
  try {
    assert.equal(settings.getFarmProjectId(), settings.getActiveProjectId())
    settings.setSetting('farm_project_id', String(HORIZON()))
    settings.setSetting('active_project_id', String(FINTEKKERS()))
    assert.equal(settings.getFarmProjectId(), HORIZON())
  } finally {
    settings.setSetting('farm_project_id', pinned)
  }
})

// ---- metric 2: the cancel-everything switch path is gone ----

test('no switchProject remains in the server or farmd source', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const hits = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__pycache__') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(js|mjs|py)$/.test(name) && readFileSync(path, 'utf8').includes('switchProject')) hits.push(path)
    }
  }
  walk(join(root, 'server/src'))
  walk(join(root, 'farm'))
  assert.deepEqual(hits, [])
})
