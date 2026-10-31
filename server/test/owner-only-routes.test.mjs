// HZ-660 metric 1: Admin, global definitions, productivity and sync are
// owner-only. Every such route in app.routeScopes() is listed below with a
// schema-valid request, so a member's 404 is the guard's and not Fastify's
// validation 400. A member who belongs to a project still gets 404
// {"error":"not_found"} from each; the owner gets each route's response from
// before HZ-660. A new /api/admin, /api/definitions or /api/sync route that is
// not listed here fails the count checks.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const farmDir = join(mkdtempSync(join(tmpdir(), 'horizon-owner-only-farm-')), 'farm')
fs.mkdirSync(join(farmDir, 'roles', 'personas'), { recursive: true })
fs.mkdirSync(join(farmDir, 'rules', 'projects'), { recursive: true })
fs.mkdirSync(join(farmDir, 'rules', 'repos'), { recursive: true })
fs.writeFileSync(join(farmDir, 'roles', 'eng_implement.md'), 'ROLE TEXT\n')

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-owner-only-')), 'test.db')
process.env.HORIZON_FARM_DIR = farmDir
for (const key of ['FARM_HOME', 'FARM_URL', 'GITHUB_WEBHOOK_SECRET', 'HORIZON_TEST_HOOKS']) delete process.env[key]

// POST /api/sync/token validates against GitHub; nothing here leaves the host.
globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) })

const { db } = await import('../src/db.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { buildApp } = await import('../src/app.js')

const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())

const owner = loginFixtureUser(auth, config, { email: 'owner-only-owner@example.com', role: 'owner' })
const member = loginFixtureUser(auth, config, { email: 'owner-only-member@example.com', role: 'member' })
const project = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Member Co', 1)").run().lastInsertRowid)
db.prepare('INSERT INTO project_member (project_id, user_id) VALUES (?, ?)').run(project, member.user.id)

const TARGET_FIELDS = {
  repo: 'acme/probe',
  script: 'deploy-horizon.sh',
  service: 'horizon-server',
  repoDir: '/tmp/probe',
  stateKey: 'probe',
  healthUrl: 'http://127.0.0.1:1/api/health',
  healthCheckType: 'json-health',
}

// `${method} ${url}` → the request to send and the owner's pre-HZ-660 answer.
// `error` pins the owner's error body, so a 404 there is the handler's own.
const OWNER_ONLY = {
  'GET /api/admin/deploy-targets': { expect: 200 },
  'GET /api/admin/farm-health': { expect: 503, error: 'farm_health_warming' },
  'GET /api/admin/check-flakes': { expect: 200 },
  'GET /api/admin/productivity': { expect: 200 },
  'GET /api/admin/test-history': { url: '/api/admin/test-history?repo=acme/probe', expect: 200 },
  'POST /api/admin/deploy-targets/:key/dry-run': {
    url: '/api/admin/deploy-targets/no-such-target/dry-run',
    payload: {},
    expect: 404,
    error: 'deploy_target_not_found',
  },
  'GET /api/admin/deploy-targets/config': { expect: 200 },
  'POST /api/admin/deploy-targets': { payload: { key: 'probe', ...TARGET_FIELDS, script: '../../etc/passwd' }, expect: 400, error: 'deploy_target_invalid' },
  'PUT /api/admin/deploy-targets/:key': { url: '/api/admin/deploy-targets/no-such-target', payload: TARGET_FIELDS, expect: 404, error: 'deploy_target_not_found' },
  'DELETE /api/admin/deploy-targets/:key': { url: '/api/admin/deploy-targets/no-such-target', expect: 404, error: 'deploy_target_not_found' },
  'GET /api/definitions': { expect: 200 },
  'GET /api/definitions/:kind/:name': { url: '/api/definitions/role/eng_implement', expect: 200 },
  // A real save commits to the farm's git tree; a wrong PIN stops the owner
  // before that, and the member's 404 comes before the PIN is even read.
  'PUT /api/definitions/:kind/:name': {
    url: '/api/definitions/role/eng_implement',
    payload: { content: 'x' },
    pin: 'wrong-pin-660',
    expect: 401,
    error: 'human_gate_key_required',
  },
  'GET /api/sync/status': { expect: 200 },
  'POST /api/sync/token': { payload: { token: 'ghp_not-a-real-token' }, expect: 400, error: 'GitHub rejected the token' },
}

const ownerOnlyRoute = (url) => /^\/api\/(admin|definitions|sync)(\/|$)/.test(url) && url !== '/api/definitions/effective'
const routes = app.routeScopes().filter((r) => r.method !== 'HEAD' && ownerOnlyRoute(r.url))

function send(name, who) {
  const spec = OWNER_ONLY[name]
  const [method, pattern] = name.split(' ')
  return app.inject({
    method,
    url: spec.url ?? pattern,
    headers: { cookie: who.cookie, 'x-human-key': spec.pin ?? who.pin },
    ...(spec.payload ? { payload: spec.payload } : {}),
  })
}

test('the owner-only list is exact: 10 admin routes, 3 global definitions routes, 2 sync routes, all scoped owner', () => {
  const names = routes.map((r) => `${r.method} ${r.url}`)
  assert.deepEqual(names.sort(), Object.keys(OWNER_ONLY).sort())
  assert.equal(routes.filter((r) => r.url.startsWith('/api/admin/')).length, 10)
  assert.equal(routes.filter((r) => r.url.startsWith('/api/definitions')).length, 3)
  assert.equal(routes.filter((r) => r.url.startsWith('/api/sync/')).length, 2)
  for (const r of routes) assert.equal(r.scope, 'owner', `${r.method} ${r.url}`)
})

test('a member of a project gets 404 not_found from every owner-only route', async () => {
  for (const name of Object.keys(OWNER_ONLY)) {
    const res = await send(name, member)
    assert.equal(res.statusCode, 404, `${name}: ${res.body}`)
    assert.deepEqual(res.json(), { error: 'not_found' }, name)
  }
})

test('the owner gets each owner-only route’s own response', async () => {
  for (const [name, spec] of Object.entries(OWNER_ONLY)) {
    const res = await send(name, owner)
    assert.equal(res.statusCode, spec.expect, `${name}: ${res.body}`)
    if (spec.error) assert.equal(res.json().error, spec.error, name)
    else assert.notDeepEqual(res.json(), { error: 'not_found' }, name)
  }
})
