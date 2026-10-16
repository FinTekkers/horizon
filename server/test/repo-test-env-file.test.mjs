// HZ-494: a repo's test-login env file. Admin stores the HOST PATH behind the
// gate PIN; the server never opens the file. The path rides to the farm with
// the configured repo's tasks (implement, deploy, conflict resolve) and its
// pre-merge run, and with no other repo's. The values written into the file
// appear in no DB row, no task payload and no snapshot.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'horizon-test-env-file-'))
process.env.HORIZON_DB = join(scratch, 'test.db')
process.env.HOME = join(scratch, 'home') // deploy.js derives state dirs from it
process.env.FARM_HOME = join(scratch, 'farm-home')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire here
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const premerge = await import('../src/premerge.js')
const { IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
await app.ready()
after(() => app.close())

const PASSWORD = 'Hz494-server-pa55word'
const hostDir = join(scratch, 'etc', 'fintekkers')
mkdirSync(hostDir, { recursive: true })
const HOST_FILE = join(hostDir, 'ui-e2e.env')
writeFileSync(HOST_FILE, `FT_E2E_USER=e2e-user@example.test\nFT_E2E_PASSWORD=${PASSWORD}\n`, { mode: 0o600 })

const projectId = db.prepare("INSERT INTO project (name, enabled) VALUES ('Login env', 1)").run().lastInsertRowid
const otherProject = db.prepare("INSERT INTO project (name, enabled) VALUES ('Other', 1)").run().lastInsertRowid
const connect = (pid, repo, prefix) =>
  db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(pid, repo, prefix)
connect(projectId, 'acme/ui', 'AU') // gets the file
connect(projectId, 'acme/api', 'AA') // never does
store.setRepoCheckCommands(projectId, 'acme/ui', { test: 'npm test' })
store.setRepoCheckCommands(projectId, 'acme/api', { test: 'npm test' })

const rowOf = (repo) => db.prepare('SELECT * FROM project_repo WHERE repo = ?').get(repo)
const put = (pid, payload, headers = { cookie: alice.cookie, 'x-human-key': alice.pin }) =>
  app.inject({ method: 'PUT', url: `/api/projects/${pid}/repos/test-env`, payload, headers })

// ---- metric 5: the route stores the path, and only the path ----

test('a valid PIN stores the path; the row, the reply and the snapshot hold the path and no value', async () => {
  const res = await put(projectId, { repo: 'acme/ui', path: HOST_FILE })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true, repo: 'acme/ui', testEnvFile: HOST_FILE })
  assert.equal(rowOf('acme/ui').test_env_file, HOST_FILE)
  assert.ok(!JSON.stringify(rowOf('acme/ui')).includes(PASSWORD))
  assert.equal(rowOf('acme/api').test_env_file, null)

  const snapshot = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: alice.cookie } })
  assert.equal(snapshot.statusCode, 200)
  assert.ok(!snapshot.body.includes(PASSWORD), 'no value in the snapshot')
  const repos = snapshot.json().projects.flatMap((p) => p.repos)
  assert.equal(repos.find((r) => r.repo === 'acme/ui').testEnvFile, HOST_FILE)
  assert.equal(repos.find((r) => r.repo === 'acme/api').testEnvFile, null)
})

for (const [name, headers] of [
  ['a missing PIN', { cookie: alice.cookie }],
  ['a wrong PIN', { cookie: alice.cookie, 'x-human-key': '0000-wrong' }],
]) {
  test(`${name} is 401 and stores nothing`, async () => {
    const res = await put(projectId, { repo: 'acme/api', path: HOST_FILE }, headers)
    assert.equal(res.statusCode, 401)
    assert.equal(rowOf('acme/api').test_env_file, null)
  })
}

test('a repo of another project, or an unknown repo, is 404 and stores nothing', async () => {
  for (const payload of [
    { repo: 'acme/api', path: HOST_FILE },
    { repo: 'acme/nope', path: HOST_FILE },
  ]) {
    const res = await put(otherProject, payload)
    assert.equal(res.statusCode, 404)
    assert.deepEqual(res.json(), { error: 'That repository is not connected to this project' })
  }
  assert.equal(rowOf('acme/api').test_env_file, null)
})

test('a path that is relative, not normalised, or inside the farm state is 400 and leaves the stored path', async () => {
  const farmHome = process.env.FARM_HOME
  mkdirSync(join(farmHome, 'workspaces', 'acme__ui__items', 'au-1'), { recursive: true })
  const link = join(hostDir, 'into-workspace.env')
  symlinkSync(join(farmHome, 'workspaces', 'acme__ui__items', 'au-1', '.env'), link)
  const cases = [
    ['relative/path.env', 'Path must be absolute and normalised'],
    ['/etc/fintekkers/../ui-e2e.env', 'Path must be absolute and normalised'],
    [join(farmHome, 'state', 'login.env'), "Path must be outside the farm's state and workspaces"],
    [join(farmHome, 'workspaces', 'acme__ui__items', 'au-1', '.env'), "Path must be outside the farm's state and workspaces"],
    [link, "Path must be outside the farm's state and workspaces"],
  ]
  for (const [path, error] of cases) {
    const res = await put(projectId, { repo: 'acme/ui', path })
    assert.equal(res.statusCode, 400, path)
    assert.deepEqual(res.json(), { error }, path)
    assert.equal(rowOf('acme/ui').test_env_file, HOST_FILE, path)
  }
  const tooLong = await put(projectId, { repo: 'acme/ui', path: `/${'x'.repeat(600)}` })
  assert.equal(tooLong.statusCode, 400)
})

test('a blank path clears the setting', async () => {
  const res = await put(projectId, { repo: 'acme/ui', path: '' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().testEnvFile, null)
  assert.equal(rowOf('acme/ui').test_env_file, null)
  assert.equal((await put(projectId, { repo: 'acme/ui', path: HOST_FILE })).statusCode, 200)
})

// ---- metric 3 / guardrail 2: only the configured repo's runs get it ----

const calls = []
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  return { ok: true, status: 200, json: async () => ({}) }
}
const stepRunFor = (id) => calls.find((c) => c.url.includes('/steps/run') && c.body?.item?.id === id)?.body

async function dispatchedImplement(id, repo) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'Login env',
    'Medium',
    IMPLEMENT_STEP_INDEX,
    repo,
    1,
    projectId,
  )
  orchestrator.kick(id)
  for (let i = 0; i < 50 && !stepRunFor(id); i++) await new Promise((r) => setTimeout(r, 10))
  orchestrator.cancel(id)
  return stepRunFor(id)
}

test('the configured repo’s implement task carries test_env_file; the other repo’s does not', async () => {
  const ui = await dispatchedImplement('AU-1', 'acme/ui')
  assert.equal(ui.test_env_file, HOST_FILE)
  assert.ok(!JSON.stringify(ui).includes(PASSWORD), 'the payload holds the path, never a value')
  const api = await dispatchedImplement('AA-1', 'acme/api')
  assert.equal(Object.hasOwn(api, 'test_env_file'), false)
})

test('every dispatch that uses checkCommandsField (implement, deploy, conflict resolve) follows the repo', () => {
  assert.deepEqual(orchestrator.checkCommandsField({ id: 'AU-2', repo: 'acme/ui' }), {
    check_commands: { install: null, test: 'npm test', lint: null, e2e: null },
    test_env_file: HOST_FILE,
  })
  assert.equal(Object.hasOwn(orchestrator.checkCommandsField({ id: 'AA-2', repo: 'acme/api' }), 'test_env_file'), false)
  assert.equal(Object.hasOwn(orchestrator.checkCommandsField({ id: 'X-1', repo: 'acme/unknown' }), 'test_env_file'), false)
})

test('the pre-merge run gets --test-env-file for the configured repo only, on argv and never env', async () => {
  const realSpawn = premerge.runner.spawn
  const runs = []
  premerge.runner.spawn = async (args, opts) => {
    runs.push({ args, opts })
    return { code: 1, stdout: JSON.stringify({ ok: false, reason: 'crash' }) + '\n', stderr: '' }
  }
  try {
    for (const repo of ['acme/ui', 'acme/api']) {
      await premerge.runPreMergeChecks(
        { id: 'PM-1', repo },
        { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), timeoutMs: 60_000, testEnvFile: store.getRepoTestEnvFile(repo) },
      )
    }
  } finally {
    premerge.runner.spawn = realSpawn
  }
  const [ui, api] = runs
  const at = ui.args.indexOf('--test-env-file')
  assert.deepEqual(ui.args.slice(at, at + 2), ['--test-env-file', HOST_FILE])
  assert.ok(!Object.values(ui.opts.env ?? {}).some((v) => String(v).includes(HOST_FILE)), 'argv only')
  assert.equal(api.args.includes('--test-env-file'), false)
})
