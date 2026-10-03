// HZ-248 metric 4: a 'Validate project' result is stored and survives a
// server restart — POST /api/projects/:id/validate here, then
// GET /api/projects/:id/validation from a second node process on the same
// database FILE, so no module cache or in-memory state can carry it over.
//
// Every external dependency of the run is a stub on projectValidate.deps, and
// globalThis.fetch throws, so nothing reaches GitHub.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginFixtureUser } from './helpers/session.mjs'

const dbPath = join(mkdtempSync(join(tmpdir(), 'horizon-validate-api-')), 'test.db')
process.env.HORIZON_DB = dbPath
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-validate-api-home-'))
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_TOKEN']) delete process.env[key]

const realFetch = globalThis.fetch
globalThis.fetch = () => {
  throw new Error('test reached the network: stub this dependency')
}
after(() => {
  globalThis.fetch = realFetch
})

const pv = await import('../src/projectValidate.js')
const store = await import('../src/store.js')
const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

const REPO = 'acme/validated'
const MAIN = 'c'.repeat(40)

const lines = []
const app = buildApp({ logger: { level: 'trace', stream: { write: (line) => lines.push(line) } } })
const { pin, cookie } = loginFixtureUser(auth, config)

const project = store.createProject('Validated')
db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(project.id, REPO, 'AV')
const neverValidated = store.createProject('Untouched')

let release = null
let pushOk = true
Object.assign(pv.deps, {
  getRepoPermissions: async () => ({ ok: true, status: 200, push: pushOk }),
  inspectWebhook: async () => ({ status: 'ok', lastResponseCode: 200, reason: null }),
  getBranchSha: async () => MAIN,
  spawn: async () => {
    if (release) await release.promise
    return { code: 0, stdout: JSON.stringify({ ok: true, detail: '1 repo check(s) passed' }), stderr: '' }
  },
  checkCommands: () => null,
  resolveRules: () => ['# rules'],
  findTargetByRepo: () => null,
  listTargets: () => [],
  runDryRun: async () => {
    throw new Error('no deploy target, so the Dry run must not be called')
  },
})

const post = (id, headers = { 'x-human-key': pin }) =>
  app.inject({ method: 'POST', url: `/api/projects/${id}/validate`, headers: { cookie, ...headers }, payload: {} })
const get = (id) => app.inject({ method: 'GET', url: `/api/projects/${id}/validation`, headers: { cookie } })

async function waitIdle(id) {
  const deadline = Date.now() + 5000
  for (;;) {
    const view = (await get(id)).json()
    if (!view.running) return view
    assert.ok(Date.now() < deadline, 'validation never finished')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function getInFreshProcess(ids) {
  const env = { ...process.env, HORIZON_DB: dbPath }
  for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_TOKEN']) delete env[key]
  const url = (p) => JSON.stringify(fileURLToPath(new URL(p, import.meta.url)))
  const script = `
    const { buildApp } = await import(${url('../src/app.js')})
    const auth = await import(${url('../src/auth.js')})
    const config = await import(${url('../src/config.js')})
    const { user } = auth.createUser({ email: 'second@example.com', name: 'Second', authMethod: 'password' })
    const cookie = config.SESSION_COOKIE_NAME + '=' + auth.createSession(user.id)
    const app = buildApp({ logger: false })
    const out = []
    for (const id of ${JSON.stringify(ids)}) {
      const res = await app.inject({ method: 'GET', url: '/api/projects/' + id + '/validation', headers: { cookie } })
      out.push({ status: res.statusCode, body: res.json() })
    }
    await app.close()
    process.stdout.write(JSON.stringify(out))
    process.exit(0)
  `
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }))
}

test('a wrong PIN is refused and starts nothing', async () => {
  const res = await post(project.id, { 'x-human-key': 'wrong-pin' })
  assert.equal(res.statusCode, 401)
  assert.equal((await get(project.id)).json().latest, null)
})

test('a result survives a restart and reads back whole; the newer result wins', async () => {
  assert.equal((await get(neverValidated.id)).json().latest, null)

  release = Promise.withResolvers()
  const first = await post(project.id)
  assert.equal(first.statusCode, 202)
  assert.equal(first.json().running, true)
  assert.equal((await get(project.id)).json().running, true)
  assert.equal((await post(project.id)).statusCode, 409, 'a second run while one is in flight')
  release.resolve()
  release = null
  const older = (await waitIdle(project.id)).latest
  assert.equal(older.pass, true, JSON.stringify(older))

  pushOk = false
  assert.equal((await post(project.id)).statusCode, 202)
  const newer = (await waitIdle(project.id)).latest
  assert.ok(newer.id > older.id)
  assert.equal(newer.pass, false)
  assert.match(newer.checks.find((c) => c.check === 'repo_access').detail, /token lacks push/)

  const [validated, untouched] = getInFreshProcess([project.id, neverValidated.id])
  assert.equal(validated.status, 200)
  assert.deepEqual(validated.body, { projectId: project.id, running: false, latest: newer })
  assert.deepEqual(
    validated.body.latest.checks.map((c) => c.check),
    [...pv.VALIDATION_CHECKS],
  )
  for (const c of validated.body.latest.checks) {
    assert.equal(typeof c.detail, 'string')
    assert.ok(c.detail.length > 0)
    assert.equal(typeof c.durationMs, 'number')
  }
  assert.ok(Date.parse(validated.body.latest.startedAt) <= Date.parse(validated.body.latest.finishedAt))
  assert.deepEqual(untouched, { status: 200, body: { projectId: neverValidated.id, running: false, latest: null } })
})

test('G7: the Admin PIN appears in no stored row and no log line', () => {
  const rows = db.prepare('SELECT * FROM project_validation').all()
  assert.ok(rows.length >= 2)
  assert.ok(!JSON.stringify(rows).includes(pin), 'a stored validation holds the PIN')
  const events = db.prepare('SELECT * FROM project_event').all()
  assert.ok(!JSON.stringify(events).includes(pin), 'a project event holds the PIN')
  assert.ok(lines.length > 0)
  assert.ok(!lines.join('\n').includes(pin), 'a log line holds the PIN')
})

test('an unknown project is a 404 on both routes', async () => {
  assert.equal((await post(9999)).statusCode, 404)
  assert.equal((await get(9999)).statusCode, 404)
})
