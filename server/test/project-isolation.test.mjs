// HZ-662: a project's isolation. Existing projects are `internal`; one a
// non-owner creates is `tenant`. The orchestrator holds a tenant project's
// items — no run, no farm call — until the owner sets both its $NAME credential
// reference and its run user, and the item carries the reason the board shows.
// The owner's own projects dispatch exactly as before, plus the three fields.
// The job lane is farm/tests/test_farmd_isolation.py and
// project-isolation-job.test.mjs.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-project-isolation-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire during these tests
process.env.FARM_STEP_TIMEOUT_MS = '600000'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.FARM_RECOVERY_POLL_MS = String(60 * 60 * 1000)
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_HOME

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { isolationRefusal } = await import('../src/projectIsolation.js')
const { ensureUnlinkedProject } = await import('../src/membership.js')

store.purgeDemoItems()

// The fake farm records every call and accepts every task.
const calls = []
globalThis.fetch = async (url, opts) => {
  const path = new URL(String(url)).pathname
  const body = opts?.body ? JSON.parse(opts.body) : null
  calls.push({ path, body })
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data })
  if (path === '/farm/status') return reply(200, { status: 'running' })
  if (path === '/runs/alive') return reply(200, { alive: Object.fromEntries((body.run_ids || []).map((id) => [id, true])) })
  return reply(200, { ok: true })
}

const app = buildApp({ logger: false })
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Owner' })
const member = loginFixtureUser(auth, config, { email: 'member@example.com', name: 'Member', role: 'member' })
const ownerToken = auth.createApiToken(owner.user.id, 'owner cli').token
const memberToken = auth.createApiToken(member.user.id, 'member cli').token
await app.ready()

const silentLog = { info: () => {}, warn: () => {}, error: () => {} }
const FARM = { 'x-farm-secret': config.FARM_SHARED_SECRET }
const REF = '$ACME_GITHUB_TOKEN'

after(async () => {
  for (const { item_id: id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) {
    orchestrator.cancel(id)
  }
  await app.close()
})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const projectRow = (id) => db.prepare('SELECT * FROM project WHERE id = ?').get(id)
const runsOf = (itemId) => db.prepare('SELECT * FROM step_run WHERE item_id = ?').all(itemId)
const posted = (itemId) => calls.filter((c) => c.path === '/steps/run' && c.body.item.id === itemId)
const snapshotItem = async (itemId) => {
  const res = await app.inject({ method: 'GET', url: '/api/farm/snapshot?scope=enabled', headers: FARM })
  assert.equal(res.statusCode, 200, res.body)
  return res.json().items.find((it) => it.id === itemId)
}
const putIsolation = (projectId, who, payload, pin = who.pin) =>
  app.inject({
    method: 'PUT',
    url: `/api/projects/${projectId}/isolation`,
    headers: { cookie: who.cookie, 'x-human-key': pin },
    payload,
  })

async function until(predicate, what) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
    await wait(10)
  }
}

function seedItem(id, projectId, repo) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo, project_id) VALUES (?, ?, 'Medium', 0, ?, ?)").run(
    id,
    `Item ${id}`,
    repo,
    projectId,
  )
}

// ---- the shared rule: JS and Python run the same table ----

test('isolationRefusal matches every shared case in domain/fixtures/isolation-cases.json', () => {
  const cases = JSON.parse(readFileSync(join(REPO_ROOT, 'domain/fixtures/isolation-cases.json'), 'utf8'))
  assert.ok(cases.shared.length >= 10)
  for (const { id, project, refusal } of cases.shared) assert.equal(isolationRefusal(project), refusal, id)
})

// ---- metric 1: the boot migration makes every existing project internal ----

test('booting the migration on a pre-HZ-662 database makes both existing projects internal', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-project-isolation-migration-')), 'test.db')
  const old = new Database(path)
  old.exec('CREATE TABLE project (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)')
  old.prepare('INSERT INTO project (name) VALUES (?), (?)').run('Old One', 'Old Two')
  old.close()
  const dbModule = fileURLToPath(new URL('../src/db.js', import.meta.url))
  const env = { ...process.env, HORIZON_DB: path }
  delete env.HORIZON_REPO
  delete env.FARM_HOME
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(dbModule)})`], { env, timeout: 60_000 })

  const booted = new Database(path, { readonly: true })
  // Boot's demo seed may add `Unlinked items`; the two old rows are what count.
  const rows = booted
    .prepare("SELECT name, isolation, github_token_ref, run_user FROM project WHERE name IN ('Old One', 'Old Two') ORDER BY name")
    .all()
  booted.close()
  assert.deepEqual(rows, [
    { name: 'Old One', isolation: 'internal', github_token_ref: null, run_user: null },
    { name: 'Old Two', isolation: 'internal', github_token_ref: null, run_user: null },
  ])
})

// ---- metric 5: who creates the project decides its isolation ----

async function createAs(name, headers) {
  const res = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name } })
  assert.equal(res.statusCode, 200, res.body)
  return res.json()
}

let ownerProject
let tenantProject
test('POST /api/projects: the owner creates internal, a member creates tenant, by session and by API token', async () => {
  ownerProject = await createAs('Owner Co', { cookie: owner.cookie })
  assert.equal(ownerProject.isolation, 'internal')
  assert.equal(projectRow(ownerProject.id).isolation, 'internal')

  tenantProject = await createAs('Acme', { cookie: member.cookie })
  assert.equal(tenantProject.isolation, 'tenant')
  assert.equal(projectRow(tenantProject.id).isolation, 'tenant')
  // The member can see the project they made.
  assert.ok(db.prepare('SELECT 1 FROM project_member WHERE project_id = ? AND user_id = ?').get(tenantProject.id, member.user.id))

  const byOwnerToken = await createAs('Owner Token Co', { authorization: `Bearer ${ownerToken}` })
  assert.equal(projectRow(byOwnerToken.id).isolation, 'internal')
  const byMemberToken = await createAs('Member Token Co', { authorization: `Bearer ${memberToken}` })
  assert.equal(projectRow(byMemberToken.id).isolation, 'tenant')
})

// ---- metric 3: only a $NAME reference is ever stored ----

test('PUT .../isolation with a non-$NAME ref is 400, stores nothing and echoes nothing', async () => {
  const before = projectRow(tenantProject.id)
  const events = db.prepare('SELECT COUNT(*) AS n FROM project_event').get().n
  for (const githubTokenRef of ['ghp_abc123', 'ACME_TOKEN', '$acme']) {
    const res = await putIsolation(tenantProject.id, owner, { githubTokenRef })
    assert.equal(res.statusCode, 400, githubTokenRef)
    assert.ok(!res.body.includes(githubTokenRef), `the 400 body echoed the value: ${res.body}`)
  }
  assert.deepEqual(projectRow(tenantProject.id), before)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_event').get().n, events)
})

// ---- metric 4: only the owner sets the fields ----

test('a member, by session or API token and with a valid PIN, is refused and the row is unchanged', async () => {
  const before = projectRow(tenantProject.id)
  for (const payload of [{ githubTokenRef: REF }, { runUser: 'acme' }]) {
    const bySession = await putIsolation(tenantProject.id, member, payload)
    assert.ok([403, 404].includes(bySession.statusCode), `session: ${bySession.statusCode} ${bySession.body}`)
    const byToken = await app.inject({
      method: 'PUT',
      url: `/api/projects/${tenantProject.id}/isolation`,
      headers: { authorization: `Bearer ${memberToken}`, 'x-human-key': member.pin },
      payload,
    })
    assert.ok([403, 404].includes(byToken.statusCode), `token: ${byToken.statusCode} ${byToken.body}`)
  }
  assert.deepEqual(projectRow(tenantProject.id), before)
})

// ---- metric 2: a held tenant item gets no run, and the reason is visible ----

test('a tenant item missing github_token_ref is held: no run, no farm call, and the snapshot carries the reason', async () => {
  await orchestrator.init(silentLog)
  const run = await putIsolation(tenantProject.id, owner, { runUser: 'acme' })
  assert.equal(run.statusCode, 200, run.body)
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/site', 'AC')").run(tenantProject.id)
  seedItem('AC-1', tenantProject.id, 'acme/site')
  orchestrator.setProjectEnabled(tenantProject.id, true, silentLog)
  orchestrator.kick('AC-1')
  await wait(50)

  assert.deepEqual(runsOf('AC-1'), [])
  assert.equal(posted('AC-1').length, 0)
  const item = await snapshotItem('AC-1')
  assert.equal(item.isolationRefusal, 'tenant project needs github_token_ref before the farm runs it')
  const project = (await app.inject({ method: 'GET', url: '/api/farm/snapshot?scope=enabled', headers: FARM }))
    .json()
    .projects.find((p) => p.id === tenantProject.id)
  assert.deepEqual(
    { isolation: project.isolation, githubTokenRef: project.githubTokenRef, runUser: project.runUser },
    { isolation: 'tenant', githubTokenRef: null, runUser: 'acme' },
  )
  // One event for the hold, not one per kick.
  orchestrator.kick('AC-1')
  orchestrator.kick('AC-1')
  const held = db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = 'AC-1' AND text LIKE 'held:%'").get().n
  assert.equal(held, 1)
})

// ---- metric 2 / outcome: the hold clears once the owner completes both ----

test('the owner completing both fields clears the hold: exactly one run, the ref only in the payload', async () => {
  const res = await putIsolation(tenantProject.id, owner, { githubTokenRef: REF })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true, projectId: tenantProject.id, isolation: 'tenant', githubTokenRef: REF, runUser: 'acme' })
  assert.equal(projectRow(tenantProject.id).github_token_ref, REF)

  await until(() => posted('AC-1').length > 0, 'the tenant item to dispatch')
  assert.equal(runsOf('AC-1').length, 1)
  assert.equal(posted('AC-1').length, 1)
  assert.deepEqual(posted('AC-1')[0].body.project, {
    id: tenantProject.id,
    name: 'Acme',
    isolation: 'tenant',
    githubTokenRef: REF,
    runUser: 'acme',
  })
  assert.equal((await snapshotItem('AC-1')).isolationRefusal, null)
})

// ---- guardrail 1: the owner's items dispatch as today ----

test('an internal item and an Unlinked item dispatch today’s payload; the internal one adds isolation: internal', async () => {
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'owner/app', 'OW')").run(ownerProject.id)
  orchestrator.setProjectEnabled(ownerProject.id, true, silentLog)
  seedItem('OW-1', ownerProject.id, 'owner/app')
  const unlinked = ensureUnlinkedProject(db)
  seedItem('UN-1', unlinked, 'owner/app')
  orchestrator.kick('OW-1')
  orchestrator.kick('UN-1')
  await until(() => posted('OW-1').length && posted('UN-1').length, 'both dispatches')

  assert.deepEqual(posted('OW-1')[0].body.project, {
    id: ownerProject.id,
    name: 'Owner Co',
    isolation: 'internal',
    githubTokenRef: null,
    runUser: null,
  })
  assert.equal(Object.hasOwn(posted('UN-1')[0].body, 'project'), false, 'an Unlinked item is still sent with no project')
  assert.equal((await snapshotItem('OW-1')).isolationRefusal, null)
  assert.equal((await snapshotItem('UN-1')).isolationRefusal, null)
})
