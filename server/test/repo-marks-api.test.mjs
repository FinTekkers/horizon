// HZ-304: a repo's 'no checks' / 'no deploy' marks, driven through the real
// Fastify app. Writing one is gate-grade, like the HZ-245 check commands: a
// browser session plus a valid gate PIN. A missing PIN, a wrong PIN and an API
// token all get 401 and store nothing, and the PIN never reaches a response
// or a log line. The database is created in the pre-HZ-304 shape first, so the
// migration runs on real existing rows: they are flagged (unmarked, stamped
// enforced_since), never waved through.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-repo-marks-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

// The pre-HZ-304 schema (HZ-245's check columns, no marks), with the two
// repos the guardrail names already connected.
const old = new Database(process.env.HORIZON_DB)
old.exec(`
  CREATE TABLE project (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
  CREATE TABLE project_repo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES project(id),
    repo TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL UNIQUE,
    check_install TEXT, check_test TEXT, check_lint TEXT, check_e2e TEXT
  );
  INSERT INTO project (name) VALUES ('Horizon'), ('FinTekkers');
  INSERT INTO project_repo (project_id, repo, prefix) VALUES (1, 'FinTekkers/horizon', 'HZ'), (2, 'FinTekkers/ui-service', 'US');
`)
old.close()

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const settings = await import('../src/settings.js')

const logs = []
const app = buildApp({ logger: { level: 'trace', stream: { write: (line) => logs.push(line) } } })
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
await app.ready()

const HORIZON_PROJECT = 1
const FINTEKKERS_PROJECT = 2
const WRONG_PIN = '0000-wrong-pin-5150'
const marksOf = (repo) => db.prepare('SELECT no_checks, no_deploy FROM project_repo WHERE repo = ?').get(repo)
const put = (projectId, payload, headers = {}) =>
  app.inject({ method: 'PUT', url: `/api/projects/${projectId}/repos/marks`, payload, headers })
const asSession = (pin) => ({ cookie: alice.cookie, ...(pin === undefined ? {} : { 'x-human-key': pin }) })
const reset = () => store.setRepoMarks(FINTEKKERS_PROJECT, 'FinTekkers/ui-service', { noChecks: false, noDeploy: false })

// ---- guardrail 6: existing repos are flagged, not marked ----

test('after migration every existing repo is unmarked and stamped enforced_since', () => {
  const rows = db.prepare('SELECT repo, no_checks, no_deploy, enforced_since FROM project_repo ORDER BY repo').all()
  assert.deepEqual(rows.map((r) => [r.repo, r.no_checks, r.no_deploy]), [
    ['FinTekkers/horizon', 0, 0],
    ['FinTekkers/ui-service', 0, 0],
  ])
  for (const row of rows) assert.match(row.enforced_since, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, row.repo)
  assert.deepEqual(store.getRepoConfig('FinTekkers/horizon'), {
    checks: null,
    noChecks: false,
    noDeploy: false,
    enforcedSince: rows[0].enforced_since,
  })
})

// ---- guardrail 1: who may write ----

test('a valid PIN saves a mark; a mark left out keeps its value', async () => {
  reset()
  const res = await put(FINTEKKERS_PROJECT, { repo: 'FinTekkers/ui-service', noChecks: true }, asSession(alice.pin))
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true, repo: 'FinTekkers/ui-service', marks: { noChecks: true, noDeploy: false } })
  assert.deepEqual(marksOf('FinTekkers/ui-service'), { no_checks: 1, no_deploy: 0 })

  const second = await put(FINTEKKERS_PROJECT, { repo: 'FinTekkers/ui-service', noDeploy: true }, asSession(alice.pin))
  assert.deepEqual(second.json().marks, { noChecks: true, noDeploy: true })
  assert.deepEqual(marksOf('FinTekkers/ui-service'), { no_checks: 1, no_deploy: 1 })

  const cleared = await put(FINTEKKERS_PROJECT, { repo: 'FinTekkers/ui-service', noChecks: false, noDeploy: false }, asSession(alice.pin))
  assert.deepEqual(cleared.json().marks, { noChecks: false, noDeploy: false })
  assert.deepEqual(marksOf('FinTekkers/ui-service'), { no_checks: 0, no_deploy: 0 })
})

for (const [name, headers] of [
  ['a missing PIN', asSession()],
  ['a wrong PIN', asSession(WRONG_PIN)],
]) {
  test(`${name} is 401 human_gate_key_required and stores nothing`, async () => {
    reset()
    const res = await put(FINTEKKERS_PROJECT, { repo: 'FinTekkers/ui-service', noChecks: true, noDeploy: true }, headers)
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
    assert.deepEqual(marksOf('FinTekkers/ui-service'), { no_checks: 0, no_deploy: 0 })
  })
}

test('an API token is 401 even with the right PIN, and stores nothing', async () => {
  reset()
  const created = await app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { cookie: alice.cookie },
    payload: { name: 'agent-bot' },
  })
  assert.equal(created.statusCode, 201, created.body)
  const res = await put(FINTEKKERS_PROJECT, { repo: 'FinTekkers/ui-service', noChecks: true }, {
    authorization: `Bearer ${created.json().token}`,
    'x-human-key': alice.pin,
  })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
  assert.deepEqual(marksOf('FinTekkers/ui-service'), { no_checks: 0, no_deploy: 0 })
})

test('a non-boolean mark or an unknown key is 400 and stores nothing', async () => {
  reset()
  for (const payload of [
    { repo: 'FinTekkers/ui-service', noChecks: 'maybe' },
    { repo: 'FinTekkers/ui-service', noChecks: { yes: true } },
    { repo: 'FinTekkers/ui-service', noChecks: true, checks: 'npm test' },
  ]) {
    const res = await put(FINTEKKERS_PROJECT, payload, asSession(alice.pin))
    assert.equal(res.statusCode, 400, JSON.stringify(payload))
  }
  assert.deepEqual(marksOf('FinTekkers/ui-service'), { no_checks: 0, no_deploy: 0 })
})

test("a repo of another project, or an unknown one, is 404 and no row changes", async () => {
  reset()
  const res = await put(HORIZON_PROJECT, { repo: 'FinTekkers/ui-service', noChecks: true }, asSession(alice.pin))
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'That repository is not connected to this project' })
  assert.deepEqual(marksOf('FinTekkers/ui-service'), { no_checks: 0, no_deploy: 0 })
  assert.deepEqual(marksOf('FinTekkers/horizon'), { no_checks: 0, no_deploy: 0 })
  assert.equal((await put(HORIZON_PROJECT, { repo: 'acme/nope', noChecks: true }, asSession(alice.pin))).statusCode, 404)
})

// ---- guardrail 3: the PIN never leaks ----

test('neither a response nor a log line carries the PIN, accepted or rejected', async () => {
  reset()
  logs.length = 0
  const bodies = []
  for (const pin of [alice.pin, WRONG_PIN]) {
    const res = await put(FINTEKKERS_PROJECT, { repo: 'FinTekkers/ui-service', noDeploy: true }, asSession(pin))
    bodies.push(res.body)
  }
  assert.ok(logs.length > 0, 'the logger captured the requests')
  for (const text of [...bodies, ...logs]) {
    assert.ok(!text.includes(alice.pin), text)
    assert.ok(!text.includes(WRONG_PIN), text)
  }
  reset()
})

// ---- reading needs only a login ----

test('the snapshot carries each repo’s marks next to its checks', async () => {
  store.setRepoMarks(FINTEKKERS_PROJECT, 'FinTekkers/ui-service', { noDeploy: true })
  settings.setSetting('active_project_id', String(FINTEKKERS_PROJECT))
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: alice.cookie } })
  const repos = res.json().projects.flatMap((p) => p.repos)
  assert.deepEqual(repos.find((r) => r.repo === 'FinTekkers/ui-service').marks, { noChecks: false, noDeploy: true })
  assert.deepEqual(repos.find((r) => r.repo === 'FinTekkers/horizon').marks, { noChecks: false, noDeploy: false })
  reset()
})

// ---- guardrail 1: one writer, and it is the PIN-gated route ----

test('setRepoMarks is called from exactly one place in server/src: the PIN-gated PUT handler', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const callers = []
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
    const lines = readFileSync(join(srcDir, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (/\bsetRepoMarks\(/.test(line) && !/export function setRepoMarks/.test(line)) callers.push({ file, line: i })
    })
  }
  assert.equal(callers.length, 1, JSON.stringify(callers))
  assert.equal(callers[0].file, 'app.js')
  const appLines = readFileSync(join(srcDir, 'app.js'), 'utf8').split('\n')
  const handler = appLines.slice(0, callers[0].line + 1).join('\n')
  const route = handler.lastIndexOf("'/api/projects/:id/repos/marks'")
  assert.ok(route > 0, 'the caller sits after the PUT route registration')
  assert.match(handler.slice(route), /security: HUMAN_GATE_SECURITY/)
  assert.match(handler.slice(route), /if \(!humanAuthorized\(request, reply\)\) return/)
  // No other write of the mark columns anywhere in server/src.
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
    const writes = readFileSync(join(srcDir, file), 'utf8').match(/\bno_(checks|deploy) = \?/g) || []
    assert.equal(writes.length, file === 'store.js' ? 2 : 0, file) // setRepoMarks' one UPDATE sets both
  }
})

// ---- guardrail 6: the enforced_since stamp runs once ----

const DB_MODULE = fileURLToPath(new URL('../src/db.js', import.meta.url))
function boot(path) {
  const env = { ...process.env, HORIZON_DB: path }
  delete env.HORIZON_REPO
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(DB_MODULE)})`], { env })
}

test('a repo connected between two boots keeps enforced_since NULL; the old rows keep their stamp', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-readiness-boots-')), 'test.db')
  boot(path)
  const raw = new Database(path)
  // Back to the pre-HZ-304 shape, with one repo already connected.
  for (const column of ['enforced_since', 'no_checks', 'no_deploy']) raw.exec(`ALTER TABLE project_repo DROP COLUMN ${column}`)
  raw.exec("INSERT INTO project (name) VALUES ('Old')")
  raw.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES ((SELECT id FROM project WHERE name = 'Old'), 'acme/old', 'AO')").run()
  raw.close()

  boot(path) // adds the columns and stamps acme/old
  const mid = new Database(path)
  const stamped = mid.prepare("SELECT no_checks, no_deploy, enforced_since FROM project_repo WHERE repo = 'acme/old'").get()
  assert.equal(stamped.no_checks, 0)
  assert.equal(stamped.no_deploy, 0)
  assert.ok(stamped.enforced_since)
  mid.prepare("UPDATE project_repo SET enforced_since = '2026-10-04 08:00:00' WHERE repo = 'acme/old'").run()
  mid.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES ((SELECT id FROM project WHERE name = 'Old'), 'acme/new', 'AW')").run()
  mid.close()

  boot(path) // a later boot stamps nothing
  const after = new Database(path, { readonly: true })
  const rows = Object.fromEntries(after.prepare('SELECT repo, enforced_since FROM project_repo').all().map((r) => [r.repo, r.enforced_since]))
  after.close()
  assert.equal(rows['acme/new'], null)
  assert.equal(rows['acme/old'], '2026-10-04 08:00:00')
})
