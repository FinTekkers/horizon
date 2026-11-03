// HZ-697: a member of a tenant project connects their own GitHub repo through
// POST /api/tenant/projects/:id/repos, with their own fine-grained token.
//
// GitHub is a stubbed globalThis.fetch: every call is recorded with its
// Authorization header, and anything the stub does not know THROWS (recorded
// in `unexpected`). The root helper is buildApp's provisionRunUser seam, and
// the token root is a temp dir (HORIZON_TENANT_TOKEN_ROOT), so nothing here
// runs sudo or touches /etc/horizon. Every log line the app writes is
// captured, so the token can be looked for there too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const GLOBAL_TOKEN = 'ghp_OWNERGLOBALTOKENhz697ABCDEFGHIJKLMNOP'
const TENANT_TOKEN = `github_pat_11TENANT_${'t'.repeat(60)}`
const TOKEN_ROOT = mkdtempSync(join(tmpdir(), 'horizon-tenant-tokens-'))

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-tenant-connect-')), 'test.db')
process.env.HORIZON_TENANT_TOKEN_ROOT = TOKEN_ROOT
process.env.HORIZON_UI_URL = 'https://horizon.test/horizon'
process.env.GITHUB_WEBHOOK_SECRET = 'hz697-webhook-secret'
process.env.GITHUB_TOKEN = GLOBAL_TOKEN
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const github = await import('../src/github.js')
const { REQUIRED_PERMISSIONS } = await import('../src/tokenCheck.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

// ---- the GitHub stub ----

const GH = 'https://api.github.com'
const REPO = 'acme/widgets'
let calls = []
let unexpected = []
let gh = {}
function resetGithub(over = {}) {
  calls = []
  unexpected = []
  gh = {
    repo: REPO,
    // Pages of /user/repos; each but the last carries Link rel="next".
    pages: [[{ full_name: REPO }]],
    // `${method} ${suffix}` -> status for one probe, suffix as in REQUIRED_PERMISSIONS.
    status: {},
    throwAll: false,
    ...over,
  }
}
resetGithub()

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

globalThis.fetch = async (input, opts = {}) => {
  const url = String(input)
  const method = (opts.method || 'GET').toUpperCase()
  const authz = opts.headers?.Authorization ?? null
  calls.push({ method, url, authz, body: opts.body ?? null })
  if (gh.throwAll) throw new TypeError('fetch failed')
  const fail = () => {
    unexpected.push(`${method} ${url}`)
    throw new Error(`unexpected GitHub call: ${method} ${url}`)
  }
  if (!url.startsWith(GH)) return fail()
  const { pathname, search } = new URL(url)
  if (method === 'GET' && pathname === '/user/repos') {
    const page = Number(new URL(url).searchParams.get('page'))
    const body = gh.pages[page - 1] ?? []
    return json(body, 200, page < gh.pages.length ? { link: `<${GH}/user/repos?page=${page + 1}>; rel="next"` } : {})
  }
  const prefix = `/repos/${gh.repo}`
  if (!pathname.startsWith(prefix)) return fail()
  const suffix = pathname.slice(prefix.length) + search
  const override = gh.status[`${method} ${suffix}`]
  if (override) return json({ message: 'Resource not accessible by personal access token' }, override)
  if (method === 'GET' && suffix === '') return json({ full_name: gh.repo, default_branch: 'main' })
  if (method === 'GET' && ['/contents/', '/issues?per_page=1', '/pulls?per_page=1', '/hooks?per_page=1', '/actions/runs?per_page=1'].includes(suffix)) {
    return json([])
  }
  if (method === 'POST' && opts.body === '{}' && ['/git/refs', '/issues', '/pulls', '/hooks'].includes(suffix)) {
    return json({ message: 'Invalid request.' }, 422)
  }
  // webhooks.ensure: the classify read, then the one real hook POST.
  if (method === 'GET' && suffix === '/hooks?per_page=100') return json([])
  if (method === 'POST' && suffix === '/hooks') return json({ id: 77, config: { url: 'x' } }, 201)
  // pollRepo: one open issue, so the repo syncs an item.
  if (method === 'GET' && suffix.startsWith('/issues?state=all')) {
    return json([{ number: 5, title: 'Tenant issue', body: '', labels: [], state: 'open', updated_at: '2026-11-01T00:00:00Z' }])
  }
  return fail()
}

// ---- the app, users and projects ----

const logs = []
let provisionCalls = []
let provisionFails = false
const app = buildApp({
  logger: { level: 'trace', stream: { write: (line) => logs.push(line) } },
  provisionRunUser: async (projectId) => {
    provisionCalls.push(projectId)
    if (provisionFails) throw new Error('helper exited 1')
  },
})
await app.ready()

loginFixtureUser(auth, config) // the owner exists, and is nobody below
const member = loginFixtureUser(auth, config, { email: 'm@example.com', name: 'Tenant Member', role: 'member' })
const otherMember = loginFixtureUser(auth, config, { email: 'o@example.com', name: 'Other Tenant', role: 'member' })
const outsider = loginFixtureUser(auth, config, { email: 'n@example.com', name: 'No Projects', role: 'member' })
const internalMember = loginFixtureUser(auth, config, { email: 'i@example.com', name: 'Internal Member', role: 'member' })

// T is connected by the success case; R takes every refusal and stays bare.
const T = store.createProject('Tenant T', { isolation: 'tenant', memberId: member.user.id }).id
const R = store.createProject('Tenant R', { isolation: 'tenant', memberId: member.user.id }).id
store.createProject('Tenant O', { isolation: 'tenant', memberId: otherMember.user.id })
const INTERNAL = store.createProject('Internal').id
db.prepare('INSERT INTO project_member (project_id, user_id) VALUES (?, ?)').run(INTERNAL, internalMember.user.id)
store.addRepoToProject(INTERNAL, 'owner/internal-app')

const connect = (who, projectId, payload, { pin = who.pin } = {}) =>
  app.inject({
    method: 'POST',
    url: `/api/tenant/projects/${projectId}/repos`,
    headers: { cookie: who.cookie, ...(pin ? { 'x-human-key': pin } : {}) },
    payload,
  })
const good = (over = {}) => ({ repo: REPO, token: TENANT_TOKEN, ...over })

// ---- "nothing saved" and "token never shown" ----

const projectRow = (id) => db.prepare('SELECT * FROM project WHERE id = ?').get(id)
const repoRows = (id) => db.prepare('SELECT * FROM project_repo WHERE project_id = ?').all(id)
const projectEvents = (id) => db.prepare('SELECT * FROM project_event WHERE project_id = ? ORDER BY id').all(id)
const hookCreates = () => calls.filter((c) => c.method === 'POST' && /\/hooks$/.test(c.url) && c.body !== '{}')

function assertNothingSaved(projectId, label) {
  assert.deepEqual(readdirSync(TOKEN_ROOT).filter((f) => f !== String(T)), [], `${label}: no token file or temp file`)
  assert.equal(projectRow(projectId).github_token_ref, null, `${label}: github_token_ref stays unset`)
  assert.equal(projectRow(projectId).run_user, null, `${label}: run_user stays unset`)
  assert.deepEqual(repoRows(projectId), [], `${label}: no project_repo row`)
  assert.deepEqual(projectEvents(projectId), [], `${label}: no project_event row`)
  assert.deepEqual(provisionCalls, [], `${label}: the helper is not called`)
  assert.deepEqual(hookCreates(), [], `${label}: no webhook is created`)
}

function assertTokenNowhere(res, label) {
  for (const secret of [TENANT_TOKEN, GLOBAL_TOKEN]) {
    assert.ok(!res.body.includes(secret), `${label}: a token is in the response`)
    assert.ok(!logs.join('').includes(secret), `${label}: a token is in the log`)
    const events = JSON.stringify(db.prepare('SELECT * FROM project_event').all())
    assert.ok(!events.includes(secret), `${label}: a token is in project_event`)
  }
}

function fresh(over) {
  resetGithub(over)
  provisionCalls = []
  provisionFails = false
}

// ---- metric 1: who may connect ----

test('metric 1: a non-member, another project’s member, an unknown id and an internal project get 404 with a valid PIN — no GitHub call, nothing saved', async () => {
  // The guard's not_found for anyone outside the project; the handler's own
  // 404 for a member of a project that is not a tenant project.
  const cases = [
    ['a member of no project', outsider, R, 'not_found'],
    ['a member of another tenant project', otherMember, R, 'not_found'],
    ['a member, on an unknown id', member, 99999, 'not_found'],
    ['a member, on an internal project they are not in', member, INTERNAL, 'not_found'],
    ['a member of the internal project, on it', internalMember, INTERNAL, 'not_a_tenant_project'],
  ]
  const internalBefore = projectRow(INTERNAL)
  const internalRepos = repoRows(INTERNAL)
  for (const [label, who, projectId, error] of cases) {
    fresh()
    const res = await connect(who, projectId, good())
    assert.equal(res.statusCode, 404, `${label}: ${res.body}`)
    assert.equal(res.json().error, error, label)
    assert.deepEqual(calls, [], `${label}: GitHub was called`)
    assertTokenNowhere(res, label)
    assertNothingSaved(R, label)
  }
  assert.deepEqual(projectRow(INTERNAL), internalBefore)
  assert.deepEqual(repoRows(INTERNAL), internalRepos)
})

// ---- HZ-741 metrics 2 and 3: a classic token, and a token that cannot reach the repo, are refused ----

test('metric 2 (HZ-741): a classic ghp_ token is refused as token_too_broad, naming its repo scope, before any GitHub call', async () => {
  fresh()
  const classic = `ghp_${'C'.repeat(36)}`
  const res = await connect(member, R, good({ token: classic }))
  assert.equal(res.statusCode, 400, res.body)
  assert.equal(res.json().error, 'token_too_broad')
  assert.match(res.json().message, /repo scope reaches every repository/)
  assert.ok(!res.body.includes(classic) && !logs.join('').includes(classic))
  assert.deepEqual(calls, [])
  assertNothingSaved(R, 'classic token')
})

test('metric 3 (HZ-741): a fine-grained token that cannot reach the named repo is refused as missing Metadata: read; nothing is saved', async () => {
  fresh({ status: { 'GET ': 404 } })
  const res = await connect(member, R, good())
  assert.equal(res.statusCode, 400, res.body)
  assert.equal(res.json().error, 'token_missing_permission')
  assert.equal(res.json().permission, 'metadata:read')
  assert.match(res.json().message, new RegExp(`Metadata: read on ${REPO}`))
  assertNothingSaved(R, 'unreachable repo')
  assertTokenNowhere(res, 'unreachable repo')
  assert.deepEqual(unexpected, [])
})

// ---- metric 3: a token missing any one permission is refused ----

const PROBE_ROWS = [
  ...REQUIRED_PERMISSIONS.map((probe) => [probe, 403]),
  // Fine-grained tokens can answer 404 for an absent permission: only 422 grants a write.
  ...REQUIRED_PERMISSIONS.filter((probe) => probe.method === 'POST').map((probe) => [probe, 404]),
]
assert.deepEqual(
  [...new Set(REQUIRED_PERMISSIONS.map((p) => p.permission.split(':')[0]))].sort(),
  ['actions', 'contents', 'issues', 'metadata', 'pull_requests', 'webhooks'],
)

for (const [probe, status] of PROBE_ROWS) {
  test(`metric 3: ${probe.method} ${probe.path || '/'} answering ${status} is refused as missing ${probe.label}; nothing is saved`, async () => {
    fresh({ status: { [`${probe.method} ${probe.path}`]: status } })
    const res = await connect(member, R, good())
    assert.equal(res.statusCode, 400, res.body)
    assert.equal(res.json().error, 'token_missing_permission')
    assert.equal(res.json().permission, probe.permission)
    assert.match(res.json().message, new RegExp(probe.label))
    assertNothingSaved(R, probe.permission)
    assertTokenNowhere(res, probe.permission)
    // Write probes send only `{}`, which can create nothing.
    for (const c of calls.filter((c) => c.method === 'POST')) assert.equal(c.body, '{}')
    assert.deepEqual(unexpected, [])
  })
}

// ---- guardrail 1: the token is never shown, on any error path ----

test('guardrail 1: every error path keeps the token out of the response, the log and project_event, and saves nothing', async () => {
  const cases = [
    ['an over-long token (schema 400)', () => connect(member, R, good({ token: `${TENANT_TOKEN}${'x'.repeat(300)}` })), 400, null],
    ['no gate PIN (401)', () => connect(member, R, good(), { pin: null }), 401, 'human_gate_key_required'],
    ['GitHub rejects the token', () => (gh.status['GET '] = 401) && connect(member, R, good()), 400, 'token_rejected'],
    ['GitHub is unreachable', () => (gh.throwAll = true) && connect(member, R, good()), 502, 'github_unreachable'],
  ]
  for (const [label, send, status, error] of cases) {
    fresh()
    const res = await send()
    assert.equal(res.statusCode, status, `${label}: ${res.body}`)
    if (error) assert.equal(res.json().error, error, label)
    assertTokenNowhere(res, label)
    assertNothingSaved(R, label)
  }
})

test('guardrail 1: an extra `path` field is a 400 — the file path never comes from the client', async () => {
  fresh()
  const res = await connect(member, R, { ...good(), path: '/etc/horizon/server.env' })
  assert.equal(res.statusCode, 400, res.body)
  assert.deepEqual(calls, [])
  assertNothingSaved(R, 'extra path')
})

test('guardrail 1: a failed helper returns run_user_provision_failed and removes the token file again', async () => {
  fresh()
  provisionFails = true
  const res = await connect(member, R, good())
  assert.equal(res.statusCode, 502, res.body)
  assert.equal(res.json().error, 'run_user_provision_failed')
  assert.deepEqual(provisionCalls, [R])
  provisionCalls = []
  assertNothingSaved(R, 'helper failed')
  assertTokenNowhere(res, 'helper failed')
})

// ---- metric 1: a member connects ----

// HZ-741 metric 1: /user/repos lists the ACCOUNT's repos, so a correctly scoped
// fine-grained token still sees others there. The stub keeps answering it, so
// "no call" proves the check is gone rather than that it crashed.
test('metric 1: a non-owner member connects with a valid token — the repo syncs, one webhook, the file: ref, the helper once; every call carries the tenant token', async () => {
  fresh({ pages: [[{ full_name: REPO }, { full_name: 'acme/other' }, { full_name: 'someone/public' }]] })
  const res = await connect(member, T, good())
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.repo, REPO)
  assert.equal(body.defaultBranch, 'main')
  assert.equal(body.githubTokenRef, `file:/etc/horizon/tenant-tokens/${T}`)
  assert.equal(body.runUser, `hz-p${T}`)
  assert.equal(body.webhook.status, 'ok')
  assert.deepEqual(unexpected, [])

  const row = projectRow(T)
  assert.equal(row.github_token_ref, `file:/etc/horizon/tenant-tokens/${T}`)
  assert.equal(row.run_user, `hz-p${T}`)
  assert.deepEqual(repoRows(T).map((r) => r.repo), [REPO])
  assert.deepEqual(provisionCalls, [T])

  // Exactly one hook is created, and every GitHub call used the tenant's token.
  assert.equal(hookCreates().length, 1)
  assert.equal(JSON.parse(hookCreates()[0].body).config.url, 'https://horizon.test/horizon/api/webhooks/github')
  assert.ok(calls.length > REQUIRED_PERMISSIONS.length)
  for (const c of calls) assert.equal(c.authz, `Bearer ${TENANT_TOKEN}`, `${c.method} ${c.url}`)
  assert.ok(calls.some((c) => c.url.includes('/issues?state=all')), 'pollRepo ran with the tenant token')
  // HZ-741: /user/repos is never asked, and every call stays on the connected repo.
  assert.deepEqual(calls.filter((c) => new URL(c.url).pathname === '/user/repos'), [])
  for (const c of calls) {
    assert.ok(new URL(c.url).pathname.toLowerCase().startsWith(`/repos/${REPO}`.toLowerCase()), `${c.method} ${c.url} leaves ${REPO}`)
  }

  // The repo synced its issue.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_item WHERE repo = ?').get(REPO).n, 1)
  assert.equal(github.getSyncState().repos.find((r) => r.repo === REPO).last.status, 200)

  // The token file: under the root, named by the id, 0600, ours, and only the token.
  const file = join(TOKEN_ROOT, String(T))
  assert.deepEqual(readdirSync(TOKEN_ROOT), [String(T)])
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(file).uid, process.getuid())
  assert.equal(readFileSync(file, 'utf8'), TENANT_TOKEN)

  // project_event names the ref and run user only.
  assert.deepEqual(
    projectEvents(T).map((e) => [e.kind, e.new_value]),
    [
      ['github_token_ref', `file:/etc/horizon/tenant-tokens/${T}`],
      ['run_user', `hz-p${T}`],
    ],
  )
  assertTokenNowhere(res, 'success')

  // The reload: the member reads the connected repo's checks back.
  const reload = await app.inject({ method: 'GET', url: `/api/tenant/projects/${T}/repos/checks?repo=${REPO}`, headers: { cookie: member.cookie } })
  assert.equal(reload.statusCode, 200, reload.body)
})

test('a second connect is refused 409 before any GitHub call; the token file and the helper are untouched', async () => {
  fresh()
  const before = readFileSync(join(TOKEN_ROOT, String(T)), 'utf8')
  const again = await connect(member, T, good({ token: `github_pat_${'z'.repeat(60)}` }))
  assert.equal(again.statusCode, 409, again.body)
  assert.equal(again.json().error, 'repo_already_connected')
  const other = await connect(member, T, good({ repo: 'acme/second' }))
  assert.equal(other.statusCode, 409, other.body)
  assert.equal(other.json().error, 'tenant_project_has_repo')
  assert.deepEqual(calls, [])
  assert.deepEqual(provisionCalls, [])
  assert.equal(readFileSync(join(TOKEN_ROOT, String(T)), 'utf8'), before)
})
