// HZ-453 metric 3: every gate-PIN route an e2e spec drives through Admin or
// the item page refuses a missing or a wrong PIN, in one table. The e2e specs
// (10-abandon, 23-project-enabled, 26-project-autopilot, 27-rules-versions,
// 28-deploy-target-overrides, 30-repo-marks, 36-project-step-provider) now
// walk only the right-PIN path; 10-gate-key.spec.js keeps the full
// wrong / cancelled / right prompt flow in the browser.
//
// Each call carries a valid browser session, so the 401 body must be
// human_gate_key_required, never login_required. Each body is a valid one, so
// schema validation never answers 400 first. Bodies are copied from the
// per-route tests, which stay the detailed home of each route's PIN check:
//   abandon       app.test.mjs
//   enabled       projects-ui-scope.test.mjs
//   autopilot     project-autopilot.test.mjs
//   rules         rule-versions.test.mjs
//   deploy CRUD   admin-deploy-target-crud.test.mjs
//   dry-run       deploy-dry-run.test.mjs
//   marks         repo-marks-api.test.mjs
//   step provider project-step-provider.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-gate-pin-routes-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-gate-pin-routes-home-'))
process.env.RULES_HMAC_SECRET = 'test-rules-hmac-secret'
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

await useDeployTargetRows([{ key: 'pin-site', repo: 'pin-co/site', stateKey: 'pin-site' }])

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')

const app = buildApp({ logger: false })
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Gate Owner' })
await app.ready()

const ITEM = 'PIN-1'
const project = store.createProject('Pin Co').id
db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(project, 'pin-co/site', 'PIN')
db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo, project_id) VALUES (?, ?, 'Medium', 3, ?, ?)").run(
  ITEM,
  'Gate PIN routes fixture',
  'pin-co/site',
  project,
)

// A real saved version, so the restore route has something to restore.
const saved = await app.inject({
  method: 'POST',
  url: '/api/rules/project/pin-co',
  headers: { cookie: owner.cookie, 'x-human-key': owner.pin },
  payload: { content: 'PIN CO RULES V1' },
})
assert.equal(saved.statusCode, 200, saved.body)

const DEPLOY_FIELDS = {
  repo: 'pin-co/site',
  script: 'stub.sh',
  service: 'stub-service',
  repoDir: '/opt/pin-co/site',
  stateKey: 'pin-site',
  healthUrl: 'https://pin-co.example.invalid/',
  healthCheckType: 'http-200',
}

const ROUTES = [
  { spec: '10-abandon', method: 'POST', url: `/api/items/${ITEM}/abandon`, payload: { reason: 'nope' } },
  { spec: '23-project-enabled', method: 'POST', url: `/api/projects/${project}/enabled`, payload: { enabled: false } },
  { spec: '26-project-autopilot', method: 'POST', url: `/api/projects/${project}/autopilot`, payload: { mode: 'shadow' } },
  { spec: '27-rules-versions', method: 'POST', url: '/api/rules/project/pin-co', payload: { content: 'ATTACKER TEXT' } },
  { spec: '27-rules-versions', method: 'POST', url: '/api/rules/project/pin-co/versions/1/restore' },
  { spec: '28-deploy-target-overrides', method: 'POST', url: '/api/admin/deploy-targets', payload: { key: 'pin-new', ...DEPLOY_FIELDS } },
  { spec: '28-deploy-target-overrides', method: 'PUT', url: '/api/admin/deploy-targets/pin-site', payload: { ...DEPLOY_FIELDS, healthCheckType: 'json-health' } },
  { spec: '28-deploy-target-overrides', method: 'DELETE', url: '/api/admin/deploy-targets/pin-site' },
  { spec: '28-deploy-target-overrides', method: 'POST', url: '/api/admin/deploy-targets/pin-site/dry-run', payload: {} },
  { spec: '30-repo-marks', method: 'PUT', url: `/api/projects/${project}/repos/marks`, payload: { repo: 'pin-co/site', noChecks: true, noDeploy: true } },
  { spec: '36-project-step-provider', method: 'PUT', url: `/api/projects/${project}/step-providers/0`, payload: { provider: 'muse' } },
]

const SPECS = [
  '10-abandon',
  '23-project-enabled',
  '26-project-autopilot',
  '27-rules-versions',
  '28-deploy-target-overrides',
  '30-repo-marks',
  '36-project-step-provider',
]

// Every row of every table, so "nothing stored" covers audit and event rows
// too. Sessions are left out: an authenticated request may touch its own.
function snapshot() {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'session'")
    .all()
    .map((t) => t.name)
  return Object.fromEntries(tables.map((name) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}

test('the table names every route of every trimmed e2e spec', () => {
  assert.equal(ROUTES.length, 11)
  assert.deepEqual([...new Set(ROUTES.map((r) => r.spec))], SPECS)
})

for (const [name, headers] of [
  ['a missing PIN', { cookie: owner.cookie }],
  ['a wrong PIN', { cookie: owner.cookie, 'x-human-key': 'not-the-pin' }],
]) {
  test(`${name} is 401 human_gate_key_required on every route, and nothing is stored`, async () => {
    const before = snapshot()
    for (const { spec, method, url, payload } of ROUTES) {
      const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) })
      assert.equal(res.statusCode, 401, `${spec} ${method} ${url}: ${res.body}`)
      assert.deepEqual(res.json(), { error: 'human_gate_key_required' }, `${spec} ${method} ${url}`)
    }
    assert.deepEqual(snapshot(), before)
  })
}

// Control: the same calls with the right PIN get past the gate, so each body
// above is one the route would act on. Runs last; it changes state.
test('the right PIN gets past the gate on every route', async () => {
  for (const { spec, method, url, payload } of ROUTES) {
    const res = await app.inject({
      method,
      url,
      headers: { cookie: owner.cookie, 'x-human-key': owner.pin },
      ...(payload === undefined ? {} : { payload }),
    })
    assert.notEqual(res.statusCode, 401, `${spec} ${method} ${url}: ${res.body}`)
    assert.notEqual(res.json().code, 'FST_ERR_VALIDATION', `${spec} ${method} ${url}: ${res.body}`)
  }
})
