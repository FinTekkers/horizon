// HZ-659: the /api/projects routes are scoped to a project's members or the
// owner. A non-member gets 404 from every /api/projects/:id/* and
// /api/projects/:slug/* route — with or without their own valid PIN — and a
// non-owner member gets 404 from the owner-only repo routes. Members change
// their own project with their own PIN; repos/disconnect now needs it too.
// GET /api/projects lists only the caller's projects, and a member's Activate
// writes only their own user.active_project_id.
//
// Through the real app (app.inject), so Fastify's integer coercion of :id runs
// before the guard, exactly as in production. globalThis.fetch throws, so no
// path reaches GitHub; validation's dependencies are stubs.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

// A temp git checkout with a bare origin stands in for the Horizon repo, so a
// member's definitions save goes through the real commit path.
const root = fs.mkdtempSync(join(tmpdir(), 'horizon-project-members-'))
const checkout = join(root, 'checkout')
const farmDir = join(checkout, 'farm')
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
fs.mkdirSync(join(farmDir, 'projects', 'alpha'), { recursive: true })
fs.writeFileSync(join(farmDir, 'projects', 'alpha', '.keep'), '')
git(root, 'init', '-b', 'main', checkout)
git(checkout, 'config', 'user.email', 'test@example.com')
git(checkout, 'config', 'user.name', 'Test')
git(checkout, 'add', '-A')
git(checkout, 'commit', '-m', 'initial')
const origin = join(root, 'origin.git')
execFileSync('git', ['clone', '--bare', '--quiet', checkout, origin])
git(checkout, 'remote', 'add', 'origin', origin)

process.env.HORIZON_FARM_DIR = farmDir
process.env.HORIZON_DB = join(fs.mkdtempSync(join(tmpdir(), 'horizon-project-members-db-')), 'test.db')
process.env.HOME = fs.mkdtempSync(join(tmpdir(), 'horizon-project-members-home-'))
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const realFetch = globalThis.fetch
globalThis.fetch = () => {
  throw new Error('test reached the network: stub this dependency')
}
after(() => {
  globalThis.fetch = realFetch
})

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const pv = await import('../src/projectValidate.js')
const { rulesKey } = await import('../src/definitions.js')
const { getSetting, setSetting } = await import('../src/settings.js')
const { choiceValues } = await import('../../domain/js/providers.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

const app = buildApp({ logger: false })
await app.ready()

const owner = loginFixtureUser(auth, config)
const userA = loginFixtureUser(auth, config, { email: 'a@example.com', name: 'Member A', role: 'member' })
const userB = loginFixtureUser(auth, config, { email: 'b@example.com', name: 'Member B', role: 'member' })
const userC = loginFixtureUser(auth, config, { email: 'c@example.com', name: 'Outsider C', role: 'member' })
const nobody = loginFixtureUser(auth, config, { email: 'n@example.com', name: 'No Projects', role: 'member' })

// The owner's farm project holds the global active setting throughout.
const FARM = store.createProject('Farm home').id
setSetting('active_project_id', String(FARM))
const P1 = store.createProject('Alpha', { isolation: 'tenant', memberId: userA.user.id }).id
const P2 = store.createProject('Beta').id
const P3 = store.createProject('Gamma', { isolation: 'tenant', memberId: userA.user.id }).id
// C's own project: proves C's PIN is real, so the "with a PIN" sweep means something.
const CP = store.createProject('C own', { isolation: 'tenant', memberId: userC.user.id }).id
db.prepare('INSERT INTO project_member (project_id, user_id) VALUES (?, ?)').run(P1, userB.user.id)
// HZ-661: createProject made each member's last new project their active one;
// A starts with none, so metric 5's first Activate is a real switch.
store.setUserActiveProject(userA.user.id, null)
const SLUG = rulesKey('project', 'Alpha')
assert.equal(SLUG, 'alpha')

const R1 = 'acme/alpha-web'
const R2 = 'acme/beta-web'
const addRepo = db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)')
addRepo.run(P1, R1, 'AW')
addRepo.run(P1, 'acme/alpha-api', 'AA')
addRepo.run(P2, R2, 'BW')

const ELIGIBLE_STEP = 0
const PROVIDER = choiceValues()[0]

const send = (who, { method, url, payload, pin }) =>
  app.inject({
    method,
    url,
    headers: { cookie: who.cookie, ...(pin ? { 'x-human-key': pin } : {}) },
    ...(payload === undefined ? {} : { payload }),
  })

// A schema-valid request for every /api/projects/:id/* and :slug/* route,
// against P1 and its repo, so a 404 can only come from the access guard.
function fixtures(id = P1, slug = SLUG, repo = R1) {
  const p = `/api/projects/${id}`
  const s = `/api/projects/${slug}`
  return {
    'POST /api/projects/:id/repos': { url: `${p}/repos`, payload: { repo: 'acme/new-one' } },
    'GET /api/projects/:id/repos/webhooks': { url: `${p}/repos/webhooks` },
    'POST /api/projects/:id/repos/webhook/fix': { url: `${p}/repos/webhook/fix`, payload: { repo } },
    'POST /api/projects/:id/activate': { url: `${p}/activate` },
    'POST /api/projects/:id/enabled': { url: `${p}/enabled`, payload: { enabled: true } },
    'POST /api/projects/:id/validate': { url: `${p}/validate`, payload: {} },
    'GET /api/projects/:id/validation': { url: `${p}/validation` },
    'POST /api/projects/:id/autopilot': { url: `${p}/autopilot`, payload: { mode: 'on' } },
    'POST /api/projects/:id/definitions-enabled': { url: `${p}/definitions-enabled`, payload: { enabled: false } },
    'PUT /api/projects/:id/isolation': { url: `${p}/isolation`, payload: { runUser: 'tenantx' } },
    'GET /api/projects/:slug/definitions': { url: `${s}/definitions` },
    'GET /api/projects/:slug/definitions/:file/history': { url: `${s}/definitions/steps.json/history` },
    'PUT /api/projects/:slug/definitions/:file': { url: `${s}/definitions/steps.json`, payload: { content: { substeps: [] } } },
    'PUT /api/projects/:id/step-providers/:stepIndex': { url: `${p}/step-providers/${ELIGIBLE_STEP}`, payload: { provider: PROVIDER } },
    'POST /api/projects/:id/repos/disconnect': { url: `${p}/repos/disconnect`, payload: { repo } },
    'PUT /api/projects/:id/repos/checks': { url: `${p}/repos/checks`, payload: { repo, test: 'npm test' } },
    'PUT /api/projects/:id/repos/test-env': { url: `${p}/repos/test-env`, payload: { repo, path: '/srv/env/alpha.env' } },
    'PUT /api/projects/:id/repos/marks': { url: `${p}/repos/marks`, payload: { repo, noChecks: true } },
    'GET /api/projects/:id/repos/check-defaults': { url: `${p}/repos/check-defaults?repo=${encodeURIComponent(repo)}` },
  }
}

// What a project's state looks like, for "nothing changed" asserts.
const projectRow = (id) => db.prepare('SELECT * FROM project WHERE id = ?').get(id)
const repoRows = (id) => db.prepare('SELECT * FROM project_repo WHERE project_id = ? ORDER BY repo').all(id)
const userActive = (who) => db.prepare('SELECT active_project_id FROM user WHERE id = ?').get(who.user.id).active_project_id

test("C's PIN is real: C changes their own project with it", async () => {
  const res = await send(userC, { method: 'POST', url: `/api/projects/${CP}/autopilot`, payload: { mode: 'shadow' }, pin: userC.pin })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(projectRow(CP).autopilot, 'shadow')
})

test('metric 1: a non-member gets exactly 404 from every /api/projects/:id/* and :slug/* route, with and without a PIN', async () => {
  const routes = app
    .routeScopes()
    .filter((r) => r.url.startsWith('/api/projects/:id/') || r.url.startsWith('/api/projects/:slug/'))
  assert.ok(routes.length >= 20, `only ${routes.length} project routes enumerated`)
  const table = fixtures()
  const beforeP1 = projectRow(P1)
  const beforeRepos = repoRows(P1)
  for (const route of routes) {
    const key = `${route.method === 'HEAD' ? 'GET' : route.method} ${route.url}`
    assert.ok(Object.hasOwn(table, key), `no fixture request for ${route.method} ${route.url}`)
    const { url, payload } = table[key]
    for (const pin of [userC.pin, null]) {
      const res = await send(userC, { method: route.method, url, payload, pin })
      assert.equal(res.statusCode, 404, `${route.method} ${route.url} ${pin ? 'with' : 'without'} a PIN: ${res.statusCode} ${res.body}`)
    }
  }
  assert.deepEqual(projectRow(P1), beforeP1)
  assert.deepEqual(repoRows(P1), beforeRepos)
})

test("metric 1: a member cannot reach another project's repo through their own project's URL", async () => {
  const beforeRepos = repoRows(P2)
  const table = fixtures(P1, SLUG, R2)
  for (const key of ['PUT /api/projects/:id/repos/checks', 'PUT /api/projects/:id/repos/marks', 'POST /api/projects/:id/repos/disconnect']) {
    const { url, payload } = table[key]
    const method = key.split(' ')[0]
    const res = await send(userA, { method, url, payload, pin: userA.pin })
    assert.equal(res.statusCode, 404, `${key}: ${res.body}`)
  }
  const query = await send(userA, { method: 'GET', url: table['GET /api/projects/:id/repos/check-defaults'].url })
  assert.equal(query.statusCode, 404, query.body)
  assert.deepEqual(repoRows(P2), beforeRepos)
})

test('metric 2: a non-owner member gets 404 from add repos, repos/webhooks, repos/webhook/fix and repos/test-env', async () => {
  const table = fixtures()
  const beforeRepos = repoRows(P1)
  for (const key of [
    'POST /api/projects/:id/repos',
    'GET /api/projects/:id/repos/webhooks',
    'POST /api/projects/:id/repos/webhook/fix',
    'PUT /api/projects/:id/repos/test-env',
  ]) {
    const { url, payload } = table[key]
    const res = await send(userA, { method: key.split(' ')[0], url, payload, pin: userA.pin })
    assert.equal(res.statusCode, 404, `${key}: ${res.body}`)
  }
  assert.deepEqual(repoRows(P1), beforeRepos)
})

test('metric 3 and guardrail 4: a user with no projects lists none; after creating one, it is their only project', async () => {
  // Signed out, the session gate refuses before any scope runs.
  const signedOut = await app.inject({ method: 'GET', url: '/api/projects' })
  assert.equal(signedOut.statusCode, 401)
  assert.ok(!Object.hasOwn(signedOut.json(), 'projects'))

  const empty = await send(nobody, { method: 'GET', url: '/api/projects' })
  assert.equal(empty.statusCode, 200)
  assert.deepEqual(empty.json(), { projects: [] })

  const created = await send(nobody, { method: 'POST', url: '/api/projects', payload: { name: 'Nobody Co' } })
  assert.equal(created.statusCode, 200, created.body)
  const id = created.json().id
  assert.ok(db.prepare('SELECT 1 FROM project_member WHERE project_id = ? AND user_id = ?').get(id, nobody.user.id))

  const listed = (await send(nobody, { method: 'GET', url: '/api/projects' })).json().projects
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, id)
  for (const other of [FARM, P1, P2, P3, CP]) assert.ok(!listed.some((p) => p.id === other))
  // A member's rows carry their board's fields, never Admin's isolation refs.
  assert.ok(!Object.hasOwn(listed[0], 'githubTokenRef'))
})

test('metric 4: repos/disconnect without a valid PIN is 401 and the repo stays connected', async () => {
  const { url, payload } = fixtures()['POST /api/projects/:id/repos/disconnect']
  for (const pin of [null, 'wrong-pin']) {
    const res = await send(userA, { method: 'POST', url, payload, pin })
    assert.equal(res.statusCode, 401, res.body)
    assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
    assert.ok(repoRows(P1).some((r) => r.repo === R1), 'the repo was disconnected')
  }
})

test("metric 5: A's activate sets only A's own active project; B's and the global one are unchanged", async () => {
  const bBefore = userActive(userB)
  const res = await send(userA, { method: 'POST', url: `/api/projects/${P3}/activate` })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true, restarting: false })
  assert.equal(userActive(userA), P3)
  assert.equal(userActive(userB), bBefore)
  assert.equal(getSetting('active_project_id'), String(FARM))
  // Again on the same project: already active for A.
  assert.deepEqual((await send(userA, { method: 'POST', url: `/api/projects/${P3}/activate` })).json(), { ok: true, alreadyActive: true })
})

// Validation's dependencies: every token-backed one records a call.
const tokenCalls = []
Object.assign(pv.deps, {
  getRepoPermissions: async (repo) => (tokenCalls.push(['getRepoPermissions', repo]), { ok: true, status: 200, push: true }),
  inspectWebhook: async (repo) => (tokenCalls.push(['inspectWebhook', repo]), { status: 'ok', lastResponseCode: 200, reason: null }),
  getBranchSha: async (repo) => (tokenCalls.push(['getBranchSha', repo]), 'c'.repeat(40)),
  runDryRun: async (target) => (tokenCalls.push(['runDryRun', target.key]), [{ check: 'x', pass: true }]),
  spawn: async () => (tokenCalls.push(['spawn']), { code: 0, stdout: JSON.stringify({ ok: true, detail: 'ok' }), stderr: '' }),
  checkCommands: () => null,
  resolveRules: () => ['# rules'],
  loadSubsteps: () => ({ substeps: [], errors: [] }),
  findTargetByRepo: (repo) => ({ key: `target-${repo}` }),
  listTargets: () => [],
  targetState: () => ({ lastCommit: 'c'.repeat(40), lastTag: 'v1' }),
  tryBeginDryRun: () => true,
  endDryRun: () => {},
})

async function validateAs(who) {
  const res = await send(who, { method: 'POST', url: `/api/projects/${P1}/validate`, payload: {}, pin: who.pin })
  assert.equal(res.statusCode, 202, res.body)
  const deadline = Date.now() + 5000
  for (;;) {
    const view = (await send(who, { method: 'GET', url: `/api/projects/${P1}/validation` })).json()
    if (!view.running) return view.latest
    assert.ok(Date.now() < deadline, 'validation never finished')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("guardrail 1: a member's validate never uses the shared token, and its result is stored as partial", async () => {
  tokenCalls.length = 0
  const latest = await validateAs(userA)
  assert.deepEqual(tokenCalls, [])
  assert.equal(latest.partial, true)
  for (const check of pv.OWNER_ONLY_CHECKS) {
    const row = latest.checks.find((c) => c.check === check)
    assert.equal(row.skipped, true, check)
    assert.equal(row.detail, 'skipped: owner only')
  }
  assert.equal(latest.checks.find((c) => c.check === 'rules').skipped, undefined)
})

test('guardrail 2: every PIN route a member may use refuses them without a PIN and works with their own', async () => {
  const table = fixtures()
  const pinRoutes = [
    ['POST /api/projects/:id/enabled', () => projectRow(P1).enabled === 1],
    ['POST /api/projects/:id/autopilot', () => projectRow(P1).autopilot === 'on'],
    ['PUT /api/projects/:slug/definitions/:file', () => fs.existsSync(join(farmDir, 'projects', 'alpha', 'steps.json'))],
    ['POST /api/projects/:id/definitions-enabled', () => projectRow(P1).definitions_enabled === 0],
    ['PUT /api/projects/:id/step-providers/:stepIndex', () => store.listProjects().find((p) => p.id === P1).providerDefaults[ELIGIBLE_STEP] === PROVIDER],
    ['PUT /api/projects/:id/repos/checks', () => repoRows(P1).find((r) => r.repo === R1).check_test === 'npm test'],
    ['PUT /api/projects/:id/repos/marks', () => store.getRepoConfig(R1)?.noChecks === true],
    ['POST /api/projects/:id/repos/disconnect', () => !repoRows(P1).some((r) => r.repo === R1)],
  ]
  for (const [key, changed] of pinRoutes) {
    const { url, payload } = table[key]
    const method = key.split(' ')[0]
    const refused = await send(userA, { method, url, payload })
    assert.equal(refused.statusCode, 401, `${key} without a PIN: ${refused.body}`)
    assert.ok(!changed(), `${key} changed state without a PIN`)
    const res = await send(userA, { method, url, payload, pin: userA.pin })
    assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${key} with A's PIN: ${res.statusCode} ${res.body}`)
    assert.ok(changed(), `${key} did not change state`)
  }
  // The member reads too: definitions, history, validation, check defaults.
  for (const key of [
    'GET /api/projects/:slug/definitions',
    'GET /api/projects/:slug/definitions/:file/history',
    'GET /api/projects/:id/validation',
  ]) {
    const res = await send(userA, { method: 'GET', url: table[key].url })
    assert.equal(res.statusCode, 200, `${key}: ${res.body}`)
  }
  const defaults = await send(userA, { method: 'GET', url: fixtures(P1, SLUG, 'acme/alpha-api')['GET /api/projects/:id/repos/check-defaults'].url })
  assert.equal(defaults.statusCode, 200, defaults.body)
})

test("guardrail 3: the owner's activate moves the global setting, the owner lists every project, and the owner's validate skips nothing", async () => {
  const res = await send(owner, { method: 'POST', url: `/api/projects/${P2}/activate` })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(getSetting('active_project_id'), String(P2))
  assert.equal(userActive(owner), P2)
  assert.equal((await send(owner, { method: 'POST', url: `/api/projects/${P2}/activate` })).json().alreadyActive, true)
  setSetting('active_project_id', String(FARM))

  const listed = (await send(owner, { method: 'GET', url: '/api/projects' })).json().projects
  assert.deepEqual(
    listed.map((p) => p.id).sort((a, b) => a - b),
    store.listProjects().map((p) => p.id).sort((a, b) => a - b),
  )
  assert.ok(listed.every((p) => Object.hasOwn(p, 'isolation')), "the owner's rows keep every field")

  tokenCalls.length = 0
  const latest = await validateAs(owner)
  assert.equal(latest.partial, false)
  assert.ok(latest.checks.every((c) => c.skipped === undefined))
  assert.ok(tokenCalls.some(([name]) => name === 'getRepoPermissions'))
})
