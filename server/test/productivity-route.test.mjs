// HZ-549 guardrails on GET /api/admin/productivity, hooks off (production):
// read-only and session-gated, API tokens rejected, and (HZ-550) the body is
// the live report with range/project echoed — null costs kept, never
// serialized as 0. productivity-test-env.test.mjs covers the screenshot
// login on a hooks-on server; its own file because config.js reads the flag at
// import.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'
import { loginFixtureUser } from './helpers/session.mjs'
import { validate } from '../../domain/validate.mjs'

const KEY = 'hz549-screenshot-k3y'
const scratch = mkdtempSync(join(tmpdir(), 'horizon-productivity-route-'))
process.env.HORIZON_DB = join(scratch, 'test.db')
process.env.HOME = join(scratch, 'home')
delete process.env.HORIZON_TEST_HOOKS
process.env.SCREENSHOT_LOGIN_KEY = KEY
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { TEST_ENV_LOGIN_HEADER } = await import('../src/testEnvLogin.js')

const { endIndex } = await import('../../domain/js/lifecycle.js')

const readJson = (rel) => JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
const schema = readJson('domain/productivity.schema.json')

const URL_PATH = '/api/admin/productivity'

store.purgeDemoItems()
const registered = []
const app = buildApp({ logger: false, onRoute: (route) => registered.push(route) })
await app.ready()
after(() => app.close())

const admin = loginFixtureUser(auth, config, { email: config.ADMIN_EMAIL, name: 'Admin' })
const get = (url, headers = {}) => app.inject({ method: 'GET', url, headers })

test('a session gets 200: the live report, range/project echoed, valid against the schema', async () => {
  const res = await get(`${URL_PATH}?range=7d&project=horizon`, { cookie: admin.cookie })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.deepEqual(validate(schema, body), [])
  assert.equal(body.range, '7d')
  assert.equal(body.project, 'horizon')
  // HZ-550: aggregated from the DB, no longer the checked-in fixture.
  assert.equal(body.source, 'live')
})

test('null costs survive serialization rather than becoming 0', async () => {
  // HZ-550: an item closed today whose one run is from before cost capture.
  const projectId = db.prepare("INSERT INTO project (name) VALUES ('Uncaptured')").run().lastInsertRowid
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES ('NC-1', 'Uncaptured', 'Medium', ?, ?)").run(endIndex(), projectId)
  db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, ended_at) VALUES ('NC-1', 4, 'Ensemble', 'done', datetime('now'))").run()
  db.prepare("INSERT INTO gate_decision (item_id, step_index, decision) VALUES ('NC-1', ?, 'approved')").run(endIndex() - 1)

  const res = await get(`${URL_PATH}?project=${projectId}`, { cookie: admin.cookie })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.summary.cost, null)
  assert.equal(body.summary.costPerItem, null)
  assert.deepEqual(body.costPerDay.at(-1).byProject[0], { project: String(projectId), cost: null, inputTokens: null, outputTokens: null })
  assert.equal(body.topItems[0].tokens, null)
  assert.equal(body.topItems[0].cost, null)
  assert.doesNotMatch(res.body, /"(cost|costPerItem|tokens|inputTokens|outputTokens)":0/)
})

test('no range or project gives the defaults 14d and all', async () => {
  const res = await get(URL_PATH, { cookie: admin.cookie })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().range, '14d')
  assert.equal(res.json().project, 'all')
})

test('an unknown range is a 400', async () => {
  const res = await get(`${URL_PATH}?range=90d`, { cookie: admin.cookie })
  assert.equal(res.statusCode, 400, res.body)
  assert.match(res.json().message, /range/)
})

test('a valid, unexpired API token of the admin user gets 403 session_required', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie: admin.cookie }, payload: { name: 'hz549-bot' } })
  assert.equal(created.statusCode, 201, created.body)
  const bearer = { authorization: `Bearer ${created.json().token}` }
  // Control: the token itself is good, so the 403 below is the gate's doing.
  const items = await get('/api/items', bearer)
  assert.equal(items.statusCode, 200, items.body)

  const res = await get(URL_PATH, bearer)
  assert.equal(res.statusCode, 403, res.body)
  assert.deepEqual(res.json(), { error: 'session_required' })
})

test('a non-owner session gets 404 not_found (HZ-660)', async () => {
  const member = loginFixtureUser(auth, config, { email: 'hz549-member@example.com', name: 'Member', role: 'member' })
  const res = await get(URL_PATH, { cookie: member.cookie })
  assert.equal(res.statusCode, 404, res.body)
  assert.deepEqual(res.json(), { error: 'not_found' })
})

test('no login gets 401 login_required', async () => {
  const res = await get(URL_PATH)
  assert.equal(res.statusCode, 401, res.body)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('hooks off: the screenshot login header gets 401, not the report', async () => {
  const res = await get(URL_PATH, { [TEST_ENV_LOGIN_HEADER]: KEY })
  assert.equal(res.statusCode, 401, res.body)
  assert.deepEqual(res.json(), { error: 'login_required' })
})

test('read-only: GET (and its HEAD) is the only method registered on the path', () => {
  const methods = registered.filter((r) => r.url === URL_PATH).flatMap((r) => [r.method].flat()).sort()
  assert.deepEqual(methods, ['GET', 'HEAD'])
})
