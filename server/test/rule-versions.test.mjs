// HZ-246: project and repo rules saved in Admin as versioned DB rows over the
// farm/rules/*.md defaults. Driven through the real Fastify app (save,
// restore, versions, targets, /api/farm/rules, the preview) and the real
// orchestrator dispatch (the /steps/run payload's rules_override), against a
// temp farm tree. The farm side (claim refresh, the prompt) is
// farm/tests/test_rules_override.py; the Python render is also run here on
// the very override the dispatch carried, so the seam is checked end to end.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs, { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import Database from 'better-sqlite3'
import { loginFixtureUser } from './helpers/session.mjs'

const SERVER_DIR = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(SERVER_DIR, '..')
const farmDir = join(mkdtempSync(join(tmpdir(), 'horizon-rules-farm-')), 'farm')
fs.mkdirSync(join(farmDir, 'roles', 'personas'), { recursive: true })
fs.mkdirSync(join(farmDir, 'rules', 'projects'), { recursive: true })
fs.mkdirSync(join(farmDir, 'rules', 'repos'), { recursive: true })
fs.writeFileSync(join(farmDir, 'roles', 'eng_implement.md'), 'ROLE TEXT\n')
fs.writeFileSync(join(farmDir, 'rules', 'projects', 'acme.md'), 'ACME FILE\n')
fs.writeFileSync(join(farmDir, 'rules', 'projects', 'blank-co.md'), 'BLANK CO FILE\n')
fs.writeFileSync(join(farmDir, 'rules', 'projects', 'tamper-co.md'), 'TAMPER CO FILE\n')
fs.writeFileSync(join(farmDir, 'rules', 'repos', 'acme__demo.md'), 'DEMO FILE\n')

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-rules-db-')), 'test.db')
process.env.HORIZON_FARM_DIR = farmDir
process.env.RULES_HMAC_SECRET = 'test-rules-hmac-secret'
process.env.FARM_SHARED_SECRET = 'test-farm-secret'
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
delete process.env.GITHUB_WEBHOOK_SECRET

const dispatches = []
globalThis.fetch = async (url, opts) => {
  dispatches.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  return { ok: true, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { resolveRules, renderRulesSection } = await import('../src/definitions.js')

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {} })

const logs = []
const app = buildApp({ logger: { level: 'trace', stream: { write: (line) => logs.push(line) } } })
await app.ready()
const { pin: PIN, cookie } = loginFixtureUser(auth, config, { name: 'Rules Owner' })
const WRONG_PIN = 'not-the-pin-918273'

const warnings = []
const realWarn = console.warn
console.warn = (...args) => warnings.push(args.join(' '))
process.on('exit', () => {
  console.warn = realWarn
})

const VERBATIM = '  \n use {{x}} and ${x} literally\n\n\t'

// Projects and repos the tests dispatch for. Fileless/acme-none has neither a
// rules file nor a DB version.
const insertProject = db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)')
const insertRepo = db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)')
const acme = insertProject.run('Acme').lastInsertRowid
insertRepo.run(acme, 'acme/demo', 'AD')
const fileless = insertProject.run('Fileless').lastInsertRowid
insertRepo.run(fileless, 'acme/none', 'AN')
const restoreCo = insertProject.run('Restore Co').lastInsertRowid
insertRepo.run(restoreCo, 'acme/restore', 'AR')
const verbatimCo = insertProject.run('Verbatim Co').lastInsertRowid
insertRepo.run(verbatimCo, 'acme/verbatim', 'AV')
// HZ-304: these implement dispatches need check commands on each repo.
const { connectReadyRepo } = await import('./helpers/readyRepo.mjs')
for (const repo of ['acme/demo', 'acme/none', 'acme/restore', 'acme/verbatim']) connectReadyRepo(db, repo)

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, project_id) VALUES (?, ?, ?, 11, ?, ?)')

async function dispatchFor(id, repo, projectId) {
  insertItem.run(id, `Rules dispatch ${id}`, 'Medium', repo, projectId)
  orchestrator.kick(id)
  await new Promise((r) => setTimeout(r, 20)) // dispatch is fire-and-forget
  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === id)
  assert.ok(dispatch, `no /steps/run dispatch captured for ${id}`)
  orchestrator.cancel(id)
  return dispatch.body
}

// NO_PIN sends no x-human-key header at all.
const NO_PIN = Symbol('no pin')
const headers = (pin) => ({ cookie, ...(pin === NO_PIN ? {} : { 'x-human-key': pin }) })
const save = (scope, key, content, pin = PIN) =>
  app.inject({ method: 'POST', url: `/api/rules/${scope}/${key}`, headers: headers(pin), payload: { content } })
const restore = (scope, key, version, pin = PIN) =>
  app.inject({ method: 'POST', url: `/api/rules/${scope}/${key}/versions/${version}/restore`, headers: headers(pin) })
const versions = async (scope, key) =>
  (await app.inject({ method: 'GET', url: `/api/rules/${scope}/${key}/versions`, headers: { cookie } })).json()
const farmRules = async (project, repo) => {
  const qs = new URLSearchParams(Object.entries({ project, repo }).filter(([, v]) => v))
  const res = await app.inject({ method: 'GET', url: `/api/farm/rules?${qs}`, headers: { 'x-farm-secret': 'test-farm-secret' } })
  assert.equal(res.statusCode, 200)
  return res.json()
}
const preview = async (project, repo) => {
  const qs = new URLSearchParams(Object.entries({ project, repo }).filter(([, v]) => v))
  const res = await app.inject({ method: 'GET', url: `/api/definitions/effective?${qs}`, headers: { cookie } })
  assert.equal(res.statusCode, 200)
  return res.json().prompt
}
const rowsOf = (scope, key) => db.prepare('SELECT * FROM rule_version WHERE scope = ? AND key = ? ORDER BY version').all(scope, key)
const countOf = (scope, key) => rowsOf(scope, key).length

// What the farm renders for this project/repo/override — farm/rules.py, run
// on the same fixture tree.
function pythonRulesSection(project, repo, overrides) {
  const script = [
    'import json, sys',
    'from farm.rules import render_rules_section, resolve_rules',
    'a = json.loads(sys.argv[1])',
    "sys.stdout.write(render_rules_section(resolve_rules(a['project'], a['repo'], a['overrides'])))",
  ].join('\n')
  return execFileSync('python3', ['-c', script, JSON.stringify({ project, repo, overrides })], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, FARM_RULES_DIR: join(farmDir, 'rules') },
  })
}

// ---- guardrail 5: the migration is additive and idempotent ----

test('running the db.js migration twice on a DB with data changes no table and no row', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'horizon-rules-migrate-')), 'm.db')
  const boot = () =>
    execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./src/db.js')"], {
      cwd: SERVER_DIR,
      env: { ...process.env, HORIZON_DB: dbPath },
    })
  boot()
  const raw = new Database(dbPath)
  raw.prepare("INSERT INTO project (name) VALUES ('Migrated')").run()
  raw
    .prepare("INSERT INTO rule_version (scope, key, version, content, actor, created_at, hmac) VALUES ('project', 'migrated', 1, 'X', 'a', 't', 'h')")
    .run()
  const snapshot = () => ({
    schema: raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(),
    projects: raw.prepare('SELECT * FROM project ORDER BY id').all(),
    items: raw.prepare('SELECT * FROM work_item ORDER BY id').all(),
    rules: raw.prepare('SELECT * FROM rule_version ORDER BY id').all(),
  })
  const before = snapshot()
  boot()
  assert.deepEqual(snapshot(), before)
  assert.equal(before.rules.length, 1)
  raw.close()
})

// ---- metric 5: the picker lists file-less targets; /api/definitions is unchanged ----

test('GET /api/rules/targets lists DB projects and connected repos that have no rules file', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/rules/targets', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  const { projects, repos } = res.json()
  assert.deepEqual(projects.find((p) => p.key === 'fileless'), { scope: 'project', key: 'fileless', label: 'Fileless', file: false, versions: 0 })
  assert.deepEqual(projects.find((p) => p.key === 'acme'), { scope: 'project', key: 'acme', label: 'Acme', file: true, versions: 0 })
  assert.ok(projects.some((p) => p.key === 'blank-co' && p.file)) // a file with no DB project
  assert.deepEqual(repos.find((r) => r.key === 'acme__none'), { scope: 'repo', key: 'acme__none', label: 'acme/none', file: false, versions: 0 })
  assert.deepEqual(repos.find((r) => r.key === 'acme__demo'), { scope: 'repo', key: 'acme__demo', label: 'acme/demo', file: true, versions: 0 })

  const defs = (await app.inject({ method: 'GET', url: '/api/definitions', headers: { cookie } })).json()
  assert.deepEqual(defs.projects.map((d) => d.name), ['acme', 'blank-co', 'tamper-co'])
  assert.deepEqual(defs.repos.map((d) => d.name), ['acme__demo'])
})

// ---- metric 3 / guardrail 4: a missing or wrong PIN stores nothing ----

test('save and restore with a missing or wrong PIN are 401, store nothing, and never echo or log the PIN', async () => {
  assert.equal((await save('project', 'acme', 'ACME BASELINE')).statusCode, 200)
  const before = rowsOf('project', 'acme')
  assert.equal(before.length, 1)

  const attempts = [
    await save('project', 'acme', 'ATTACKER TEXT', NO_PIN),
    await save('project', 'acme', 'ATTACKER TEXT', WRONG_PIN),
    await save('project', 'acme', 'ATTACKER TEXT', ''),
    await restore('project', 'acme', 1, NO_PIN),
    await restore('project', 'acme', 1, WRONG_PIN),
  ]
  for (const [i, res] of attempts.entries()) {
    assert.equal(res.statusCode, 401, `attempt ${i}: ${res.body}`)
    assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
    assert.ok(!res.body.includes(WRONG_PIN) && !res.body.includes(PIN))
  }
  assert.deepEqual(rowsOf('project', 'acme'), before)
  assert.equal((await farmRules('Acme', 'acme/demo')).project, 'ACME BASELINE')

  // A successful save's and restore's bodies don't echo it either.
  const ok = await save('project', 'acme', 'ACME BASELINE 2')
  assert.equal(ok.statusCode, 200)
  assert.ok(!ok.body.includes(PIN))
  const restored = await restore('project', 'acme', 1)
  assert.equal(restored.statusCode, 200)
  assert.ok(!restored.body.includes(PIN))

  const logged = logs.join('') + warnings.join('\n')
  assert.ok(logs.length > 0, 'the logger captured nothing — the assertion below would be vacuous')
  assert.ok(!logged.includes(PIN) && !logged.includes(WRONG_PIN))
})

// ---- metric 2: a save reaches the next step, for a project and a repo ----

test('saved project and repo rules ride the next dispatch and reach the prompt', async () => {
  assert.equal((await save('project', 'acme', 'ACME SAVED RULES')).statusCode, 200)
  assert.equal((await save('repo', 'acme__demo', 'DEMO SAVED RULES')).statusCode, 200)

  const body = await dispatchFor('RV-2', 'acme/demo', acme)
  assert.deepEqual(body.rules_override, { project: 'ACME SAVED RULES', repo: 'DEMO SAVED RULES' })
  assert.deepEqual(await farmRules('Acme', 'acme/demo'), { project: 'ACME SAVED RULES', repo: 'DEMO SAVED RULES' })
  const expected = '## Project rules\nACME SAVED RULES\n\nDEMO SAVED RULES'
  assert.equal(pythonRulesSection('Acme', 'acme/demo', body.rules_override), expected)
  assert.ok((await preview('Acme', 'acme/demo')).endsWith(expected))
})

// ---- guardrail 6: no caching across steps ----

test('a save between two dispatches reaches the second and not the first', async () => {
  assert.equal((await save('project', 'acme', 'BEFORE')).statusCode, 200)
  const a = await dispatchFor('RV-3A', 'acme/demo', acme)
  assert.equal((await save('project', 'acme', 'AFTER')).statusCode, 200)
  const b = await dispatchFor('RV-3B', 'acme/demo', acme)
  assert.equal(a.rules_override.project, 'BEFORE')
  assert.equal(b.rules_override.project, 'AFTER')
})

// ---- metric 4 / guardrail 3: restore appends a copy ----

test('restoring version 1 adds exactly one version with its text and leaves the history untouched', async () => {
  assert.equal((await save('project', 'restore-co', 'VERSION ONE')).statusCode, 200)
  assert.equal((await save('project', 'restore-co', 'VERSION TWO')).statusCode, 200)
  const before = rowsOf('project', 'restore-co')

  const res = await restore('project', 'restore-co', 1)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().version.version, 3)
  assert.equal(res.json().version.restored_from, 1)

  const after = rowsOf('project', 'restore-co')
  assert.equal(after.length, before.length + 1)
  assert.deepEqual(after.slice(0, 2), before) // byte-identical, hmac included
  assert.equal(after[2].content, 'VERSION ONE')
  assert.equal(after[2].restored_from, 1)

  const listed = await versions('project', 'restore-co')
  assert.deepEqual(listed.versions.map((v) => [v.version, v.content, v.restored_from, v.verified]), [
    [3, 'VERSION ONE', 1, true],
    [2, 'VERSION TWO', null, true],
    [1, 'VERSION ONE', null, true],
  ])
  assert.equal(listed.served_version, 3)
  assert.equal(listed.default.exists, false)
  assert.equal((await dispatchFor('RV-4', 'acme/restore', restoreCo)).rules_override.project, 'VERSION ONE')

  assert.equal((await restore('project', 'restore-co', 99)).statusCode, 404)
  assert.equal(countOf('project', 'restore-co'), 3)
})

// ---- metric 5 / guardrail 8: no file and no DB version is empty rules ----

test('a project and a repo with no file and no DB version get empty rules and still dispatch', async () => {
  assert.deepEqual(await farmRules('No Such Project', 'acme/none'), { project: null, repo: null })
  assert.ok(!(await preview('No Such Project', 'acme/none')).includes('## Project rules'))
  assert.equal(pythonRulesSection('No Such Project', 'acme/none', {}), '')
  const body = await dispatchFor('RV-5', 'acme/none', fileless)
  assert.equal(Object.hasOwn(body, 'rules_override'), false)
  const listed = await versions('repo', 'acme__none')
  assert.deepEqual([listed.default.exists, listed.served_version, listed.versions], [false, null, []])
})

// ---- operator ruling at gate 10: blank saved text means "no DB rules" ----

test('an empty or whitespace-only saved version serves the file default, in JS and Python', async () => {
  assert.equal((await save('project', 'blank-co', 'REAL RULES')).statusCode, 200)
  assert.equal((await farmRules('Blank Co')).project, 'REAL RULES')
  for (const blank of ['', ' \n\t ']) {
    assert.equal((await save('project', 'blank-co', blank)).statusCode, 200)
    assert.equal((await farmRules('Blank Co')).project, null)
    assert.equal((await versions('project', 'blank-co')).served_version, null)
    assert.ok((await preview('Blank Co')).endsWith('## Project rules\nBLANK CO FILE'))
    assert.deepEqual(resolveRules('Blank Co', null, { project: blank }), ['BLANK CO FILE'])
    assert.equal(pythonRulesSection('Blank Co', null, { project: blank }), '## Project rules\nBLANK CO FILE')
  }
})

// ---- metric 6 / guardrail 2: byte-for-byte, nothing expanded ----

test('saved text reaches the payload and the prompt exactly as typed: no trim, no {{x}} or ${x} expansion', async () => {
  assert.equal((await save('project', 'verbatim-co', VERBATIM)).statusCode, 200)
  assert.equal((await save('repo', 'acme__verbatim', VERBATIM)).statusCode, 200)
  assert.equal((await versions('project', 'verbatim-co')).versions[0].content, VERBATIM)
  assert.deepEqual(await farmRules('Verbatim Co', 'acme/verbatim'), { project: VERBATIM, repo: VERBATIM })

  const body = await dispatchFor('RV-6', 'acme/verbatim', verbatimCo)
  assert.deepEqual(body.rules_override, { project: VERBATIM, repo: VERBATIM })
  const expected = `## Project rules\n${VERBATIM}\n\n${VERBATIM}`
  assert.equal(renderRulesSection(resolveRules('Verbatim Co', 'acme/verbatim', body.rules_override)), expected)
  assert.equal(pythonRulesSection('Verbatim Co', 'acme/verbatim', body.rules_override), expected)
  assert.ok((await preview('Verbatim Co', 'acme/verbatim')).endsWith(expected))
})

// ---- metric 1: the override path is parity-tested too ----

test('JS resolveRules/renderRulesSection and farm/rules.py agree with and without overrides', () => {
  const cases = [
    ['Acme', 'acme/demo', null],
    ['Acme', 'acme/demo', {}],
    ['Acme', 'acme/demo', { project: 'P OVERRIDE' }],
    ['Acme', 'acme/demo', { repo: 'R OVERRIDE' }],
    ['Acme', 'acme/demo', { project: VERBATIM, repo: '  ' }],
    ['No Such Project', 'acme/none', { project: 'ONLY DB', repo: 'ONLY DB REPO' }],
    ['Acme', null, { project: 42, repo: 'unused without a repo' }],
  ]
  for (const [project, repo, overrides] of cases) {
    const js = renderRulesSection(resolveRules(project, repo, overrides))
    assert.equal(js, pythonRulesSection(project, repo, overrides), JSON.stringify([project, repo, overrides]))
  }
})

// ---- guardrail 3: append-only at the DB ----

test('a direct UPDATE or DELETE on rule_version is refused', () => {
  assert.throws(() => db.prepare("UPDATE rule_version SET content = 'x' WHERE key = 'acme'").run(), /append-only/)
  assert.throws(() => db.prepare("DELETE FROM rule_version WHERE key = 'acme'").run(), /append-only/)
})

test('bad scopes and keys are refused before anything is stored', async () => {
  for (const [scope, key] of [['role', 'eng_implement'], ['project', 'Acme'], ['project', '-x'], ['repo', '..__x'], ['repo', 'noslash']]) {
    const res = await save(scope, key, 'x')
    assert.equal(res.statusCode, 400, `${scope}/${key}: ${res.body}`)
    assert.equal(res.json().error, scope === 'role' ? 'bad_scope' : 'bad_key')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rule_version WHERE key = ?').get(key).n, 0)
  }
})

// ---- operator ruling (2026-10-02): a row edited straight in SQLite is never served ----

test('a row edited directly in SQLite is not served: the last verified version is, then the file', async () => {
  assert.equal((await save('project', 'tamper-co', 'GOOD ONE')).statusCode, 200)
  assert.equal((await save('project', 'tamper-co', 'GOOD TWO')).statusCode, 200)
  assert.equal((await farmRules('Tamper Co')).project, 'GOOD TWO')

  const raw = new Database(process.env.HORIZON_DB)
  raw.exec('DROP TRIGGER rule_version_no_update')
  const tamper = (version) =>
    raw.prepare("UPDATE rule_version SET content = 'EVIL' WHERE scope = 'project' AND key = 'tamper-co' AND version = ?").run(version)
  tamper(2)

  warnings.length = 0
  assert.equal((await farmRules('Tamper Co')).project, 'GOOD ONE')
  assert.ok(warnings.some((w) => /rules: TAMPER scope=project key="tamper-co" version=2/.test(w)), warnings.join('\n'))
  assert.ok(!warnings.join('\n').includes('EVIL'))
  const listed = await versions('project', 'tamper-co')
  assert.deepEqual(listed.versions.map((v) => [v.version, v.verified]), [[2, false], [1, true]])
  assert.equal(listed.served_version, 1)

  // A tampered row is never re-signed into a trusted one.
  const res = await restore('project', 'tamper-co', 2)
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'unverified_version')
  assert.equal(countOf('project', 'tamper-co'), 2)

  tamper(1)
  raw.close()
  assert.equal((await farmRules('Tamper Co')).project, null)
  assert.ok((await preview('Tamper Co')).endsWith('## Project rules\nTAMPER CO FILE'))
  const tamperCo = insertProject.run('Tamper Co').lastInsertRowid
  insertRepo.run(tamperCo, 'acme/tamper', 'AT')
  connectReadyRepo(db, 'acme/tamper')
  assert.equal(Object.hasOwn(await dispatchFor('RV-7', 'acme/tamper', tamperCo), 'rules_override'), false)
})
