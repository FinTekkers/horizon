// HZ-244: connecting a repo creates and verifies its GitHub webhook; Admin
// reads each repo's webhook status; a PIN-gated Fix webhook creates or repairs.
//
// GitHub is a stubbed globalThis.fetch that answers only the calls each case
// expects and THROWS on anything else (recorded in `unexpected`, because
// pollRepo swallows errors) — no request can reach the real API.
//
// Its own file because config.js reads HORIZON_UI_URL and GITHUB_WEBHOOK_SECRET
// at import time. The localhost-URL guard and the secret-unset case live in
// repo-webhooks-url-guard.test.mjs and repo-webhooks-no-secret.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const SECRET = 'test-secret-XYZ-hz244'
const TOKEN = 'ghp_TESTTOKENhz244ABCDEFGHIJKLMNOPQRSTU'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-repo-webhooks-')), 'test.db')
process.env.HORIZON_UI_URL = 'https://horizon.test/horizon'
process.env.GITHUB_WEBHOOK_SECRET = SECRET
process.env.GITHUB_TOKEN = TOKEN
delete process.env.HORIZON_REPO
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const { HOOK_EVENTS } = await import('../src/webhooks.js')

store.purgeDemoItems()

const HOOK_URL = 'https://horizon.test/horizon/api/webhooks/github'
const FOREIGN_URL = 'https://old-host.example/horizon/api/webhooks/github'
const EXPECTED_BODY = {
  name: 'web',
  active: true,
  events: ['issue_comment', 'issues', 'pull_request', 'release'],
  config: { url: HOOK_URL, content_type: 'json', secret: SECRET, insecure_ssl: '0' },
}

// ---- the GitHub stub ----

const GH = 'https://api.github.com'
const calls = [] // every call, for the whole file
const unexpected = []
const hooksByRepo = {} // repo -> hook list | { status } | 'throw'
const writeStatus = {} // `${method} ${path}` -> HTTP status for a failing write

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

globalThis.fetch = async (input, opts = {}) => {
  const url = String(input)
  const method = (opts.method || 'GET').toUpperCase()
  calls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : undefined })
  const fail = () => {
    unexpected.push(`${method} ${url}`)
    throw new Error(`unexpected GitHub call: ${method} ${url}`)
  }
  if (!url.startsWith(`${GH}/repos/`)) return fail()
  const path = url.slice(GH.length)
  let m
  if (method === 'GET' && (m = /^\/repos\/([^/]+\/[^/?]+)$/.exec(path))) return json({ full_name: m[1] })
  if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/issues\?/.test(path)) return json([])
  if (method === 'GET' && (m = /^\/repos\/([^/]+\/[^/]+)\/hooks\?per_page=100$/.exec(path))) {
    const hooks = hooksByRepo[m[1]]
    if (hooks === 'throw') throw new TypeError('fetch failed')
    if (hooks && !Array.isArray(hooks)) return json({ message: 'Forbidden' }, hooks.status)
    return json(hooks || [])
  }
  if (method === 'POST' && (m = /^\/repos\/([^/]+\/[^/]+)\/hooks$/.exec(path))) {
    const code = writeStatus[`POST ${path}`]
    // A failing GitHub write can echo the request — including the secret.
    if (code) return json({ message: 'Validation Failed', config: opts.body && JSON.parse(opts.body).config }, code)
    return json({ id: 999, config: { url: HOOK_URL, secret: '********' }, last_response: { code: null } }, 201)
  }
  if (method === 'PATCH' && /^\/repos\/[^/]+\/[^/]+\/hooks\/\d+$/.test(path)) return json({ id: 1 })
  return fail()
}

const hook = (id, over = {}) => ({
  id,
  name: 'web',
  active: true,
  events: [...HOOK_EVENTS],
  config: { url: HOOK_URL, content_type: 'json', insecure_ssl: '0', secret: '********' },
  last_response: { code: 200, status: 'active', message: 'OK' },
  ...over,
})

const since = (n) => calls.slice(n)
const writes = (list) => list.filter((c) => c.method !== 'GET')

// ---- app + fixtures ----

const app = buildApp({ logger: false })
const user = loginFixtureUser(auth, config)
const inject = (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie: user.cookie } })
const gated = (opts) => inject({ ...opts, headers: { 'x-human-key': user.pin, ...opts.headers } })

const project = store.createProject('HZ-244 webhooks')
const projectId = project.id

const connect = (repo, a = app) =>
  a.inject({ method: 'POST', url: `/api/projects/${projectId}/repos`, headers: { cookie: user.cookie }, payload: { repo } })
const statusList = (a = app) =>
  a.inject({ method: 'GET', url: `/api/projects/${projectId}/repos/webhooks`, headers: { cookie: user.cookie } })
const fixRepo = (repo, headers = {}, a = app) =>
  a.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/repos/webhook/fix`,
    headers: { cookie: user.cookie, 'x-human-key': user.pin, ...headers },
    payload: { repo },
  })
const rowFor = (res, repo) => res.json().webhooks.find((w) => w.repo === repo)

// ---- metric 1: connect with no hook creates exactly one ----

test('connecting a repo with no webhook sends exactly one POST /hooks with the exact body', async () => {
  const n = calls.length
  hooksByRepo['FinTekkers/m1'] = []
  const res = await connect('FinTekkers/m1')
  assert.equal(res.statusCode, 200, res.body)
  const w = writes(since(n))
  assert.equal(w.length, 1, JSON.stringify(w.map((c) => `${c.method} ${c.url}`)))
  assert.equal(w[0].method, 'POST')
  assert.equal(w[0].url, `${GH}/repos/FinTekkers/m1/hooks`)
  assert.deepEqual(w[0].body, EXPECTED_BODY)
  assert.deepEqual(res.json().webhook, { status: 'ok', lastResponseCode: null, reason: 'created' })
  assert.equal(res.json().repo, 'FinTekkers/m1', 'the existing connect fields are kept')
  assert.deepEqual(unexpected, [])
})

// ---- metric 2: connect verifies, never writes, when a hook exists ----

for (const [name, hooks, expected] of [
  ['a matching hook', [hook(5)], { status: 'ok', lastResponseCode: 200, reason: null }],
  ['a hook missing the release event', [hook(5, { events: ['issues', 'issue_comment', 'pull_request'] })], { status: 'mismatched', lastResponseCode: 200, reason: null }],
  ['a hook with an extra push event', [hook(5, { events: [...HOOK_EVENTS, 'push'] })], { status: 'mismatched', lastResponseCode: 200, reason: null }],
  ['a form-encoded hook', [hook(5, { config: { url: HOOK_URL, content_type: 'form' } })], { status: 'mismatched', lastResponseCode: 200, reason: null }],
  ['an inactive hook', [hook(5, { active: false })], { status: 'mismatched', lastResponseCode: 200, reason: null }],
  ['a hook with the four events reordered', [hook(5, { events: ['release', 'pull_request', 'issues', 'issue_comment'] })], { status: 'ok', lastResponseCode: 200, reason: null }],
  ['a Horizon hook on another host', [hook(5, { config: { url: FOREIGN_URL, content_type: 'json' } })], { status: 'mismatched', lastResponseCode: 200, reason: 'foreign_url' }],
]) {
  test(`connect with ${name}: webhook.status ${expected.status}, no POST/PATCH/DELETE`, async () => {
    const repo = `FinTekkers/m2-${name.replace(/\W+/g, '-')}`
    hooksByRepo[repo] = hooks
    const n = calls.length
    const res = await connect(repo)
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json().webhook, expected)
    assert.deepEqual(writes(since(n)), [])
    assert.deepEqual(unexpected, [])
  })
}

test('the hooks list is read 100 per page, so a Horizon hook at entry 31 reads ok and nothing is POSTed', async () => {
  const repo = 'FinTekkers/paginated'
  hooksByRepo[repo] = [...Array.from({ length: 30 }, (_, i) => hook(100 + i, { config: { url: `https://ci.example/hook/${i}`, content_type: 'json' } })), hook(500)]
  const n = calls.length
  const res = await connect(repo)
  assert.equal(res.json().webhook.status, 'ok')
  assert.ok(since(n).some((c) => c.url === `${GH}/repos/${repo}/hooks?per_page=100`))
  assert.deepEqual(writes(since(n)), [])
})

// ---- guardrail 3: a hook Horizon did not create is never touched ----

test('an unrelated hook leaves the repo missing: connect POSTs one new hook and never PATCHes', async () => {
  const repo = 'FinTekkers/unrelated'
  hooksByRepo[repo] = [hook(7, { config: { url: 'https://ci.example/hook', content_type: 'json' } })]
  assert.equal(rowFor(await statusList(), repo), undefined, 'not connected yet')
  const n = calls.length
  const res = await connect(repo)
  assert.equal(res.json().webhook.reason, 'created')
  const w = writes(since(n))
  assert.deepEqual(w.map((c) => `${c.method} ${c.url}`), [`POST ${GH}/repos/${repo}/hooks`])
  assert.ok(!since(n).some((c) => c.url.includes('/hooks/7')))
})

// ---- metric 3 (server): live status per repo, read-only, per-row errors ----

test('GET .../repos/webhooks returns each repo row, maps last_response.code, and turns a failed call into that row\'s error', async () => {
  const other = store.createProject('HZ-244 status')
  for (const repo of ['FinTekkers/s-ok', 'FinTekkers/s-403', 'FinTekkers/s-down', 'FinTekkers/s-missing']) {
    store.addRepoToProject(other.id, repo)
  }
  hooksByRepo['FinTekkers/s-ok'] = [hook(1, { last_response: { code: 502 } })]
  hooksByRepo['FinTekkers/s-403'] = { status: 403 }
  hooksByRepo['FinTekkers/s-down'] = 'throw'
  hooksByRepo['FinTekkers/s-missing'] = []
  const n = calls.length
  const res = await inject({ method: 'GET', url: `/api/projects/${other.id}/repos/webhooks` })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), {
    webhooks: [
      { repo: 'FinTekkers/s-403', status: 'error', lastResponseCode: null, reason: 'github_error', httpStatus: 403 },
      { repo: 'FinTekkers/s-down', status: 'error', lastResponseCode: null, reason: 'github_unreachable', httpStatus: null },
      { repo: 'FinTekkers/s-missing', status: 'missing', lastResponseCode: null, reason: null },
      { repo: 'FinTekkers/s-ok', status: 'ok', lastResponseCode: 502, reason: null },
    ],
  })
  assert.ok(since(n).every((c) => c.method === 'GET'), 'the status route wrote to GitHub')
  assert.equal((await inject({ method: 'GET', url: '/api/projects/99999/repos/webhooks' })).statusCode, 404)
})

// ---- metric 4: Fix webhook ----

test('Fix webhook without a valid PIN is rejected like other Admin writes, with no GitHub call', async () => {
  store.addRepoToProject(projectId, 'FinTekkers/pin-check')
  hooksByRepo['FinTekkers/pin-check'] = []
  const created = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie: user.cookie }, payload: { name: 'hz244-bot' } })
  assert.equal(created.statusCode, 201, created.body)
  const { token } = created.json()
  const url = `/api/projects/${projectId}/repos/webhook/fix`
  const payload = { repo: 'FinTekkers/pin-check' }
  const n = calls.length
  for (const headers of [{ cookie: user.cookie }, { cookie: user.cookie, 'x-human-key': 'wrong-pin' }, { authorization: `Bearer ${token}` }]) {
    const res = await app.inject({ method: 'POST', url, headers, payload })
    assert.equal(res.statusCode, 401, JSON.stringify(Object.keys(headers)))
    assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
  }
  assert.equal(calls.length, n, 'a rejected Fix reached GitHub')
})

test('Fix webhook on a missing hook POSTs once, and the status then reads ok', async () => {
  const repo = 'FinTekkers/ui-service'
  store.addRepoToProject(projectId, repo)
  hooksByRepo[repo] = []
  const n = calls.length
  const res = await fixRepo(repo)
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true, repo, action: 'created', webhook: { status: 'ok', lastResponseCode: null, reason: null } })
  const w = writes(since(n))
  assert.equal(w.length, 1)
  assert.equal(`${w[0].method} ${w[0].url}`, `POST ${GH}/repos/${repo}/hooks`)
  assert.deepEqual(w[0].body, EXPECTED_BODY)

  hooksByRepo[repo] = [hook(999, { last_response: { code: 200 } })]
  const m = calls.length
  const after = await statusList()
  assert.deepEqual(rowFor(after, repo), { repo, status: 'ok', lastResponseCode: 200, reason: null })
  assert.deepEqual(writes(since(m)), [])
})

test('Fix webhook PATCHes Horizon\'s own mismatched hook by id with the full body, never the foreign-host one', async () => {
  const repo = 'FinTekkers/repair'
  store.addRepoToProject(projectId, repo)
  hooksByRepo[repo] = [
    hook(11, { config: { url: FOREIGN_URL, content_type: 'json' } }),
    hook(22, { events: ['issues'], last_response: { code: 404 } }),
  ]
  assert.equal(rowFor(await statusList(), repo).status, 'mismatched')
  const n = calls.length
  const res = await fixRepo(repo)
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true, repo, action: 'repaired', webhook: { status: 'ok', lastResponseCode: 404, reason: null } })
  const w = writes(since(n))
  assert.equal(w.length, 1)
  assert.equal(`${w[0].method} ${w[0].url}`, `PATCH ${GH}/repos/${repo}/hooks/22`)
  assert.deepEqual(w[0].body, EXPECTED_BODY)
  assert.ok(!since(n).some((c) => c.url.includes('/hooks/11')), 'the foreign-host hook was touched')

  hooksByRepo[repo] = [hooksByRepo[repo][0], hook(22)]
  const m = calls.length
  assert.equal(rowFor(await statusList(), repo).status, 'ok')
  assert.deepEqual(writes(since(m)), [])
})

test('Fix webhook with only a foreign-host hook POSTs a new hook and does not PATCH', async () => {
  const repo = 'FinTekkers/foreign-only'
  store.addRepoToProject(projectId, repo)
  hooksByRepo[repo] = [hook(11, { config: { url: FOREIGN_URL, content_type: 'json' } })]
  const n = calls.length
  const res = await fixRepo(repo)
  assert.equal(res.json().action, 'created')
  assert.deepEqual(writes(since(n)).map((c) => `${c.method} ${c.url}`), [`POST ${GH}/repos/${repo}/hooks`])
  assert.ok(!since(n).some((c) => c.url.includes('/hooks/11')))
})

test('Fix webhook on an ok hook writes nothing; on a repo outside the project it is a 404 with no GitHub call', async () => {
  const repo = 'FinTekkers/already-ok'
  store.addRepoToProject(projectId, repo)
  hooksByRepo[repo] = [hook(3)]
  const n = calls.length
  const res = await fixRepo(repo)
  assert.equal(res.json().action, 'none')
  assert.equal(res.json().webhook.status, 'ok')
  assert.deepEqual(writes(since(n)), [])

  const m = calls.length
  const gone = await fixRepo('FinTekkers/not-connected')
  assert.equal(gone.statusCode, 404)
  assert.equal(calls.length, m)
})

// ---- metric 5: the secret and token never leave the server ----

function keysDeep(node, out = []) {
  if (Array.isArray(node)) node.forEach((v) => keysDeep(v, out))
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) out.push(k, ...keysDeep(v))
  return out
}

test('the webhook secret and GitHub token never reach a response body, a log line or the database', async () => {
  const lines = []
  const logged = buildApp({ logger: { level: 'trace', stream: { write: (line) => lines.push(line) } } })
  await logged.ready()
  try {
    hooksByRepo['FinTekkers/m5-connect'] = []
    hooksByRepo['FinTekkers/m5-fix'] = []
    hooksByRepo['FinTekkers/m5-fail'] = []
    store.addRepoToProject(projectId, 'FinTekkers/m5-fix')
    store.addRepoToProject(projectId, 'FinTekkers/m5-fail')
    writeStatus['POST /repos/FinTekkers/m5-fail/hooks'] = 422

    const responses = [
      await connect('FinTekkers/m5-connect', logged),
      await statusList(logged),
      await fixRepo('FinTekkers/m5-fix', {}, logged),
      await fixRepo('FinTekkers/m5-fail', {}, logged),
    ]
    assert.deepEqual(responses.map((r) => r.statusCode), [200, 200, 200, 502])
    assert.deepEqual(responses[3].json(), { error: 'GitHub returned 422' })
    // Non-vacuity: the secret really went out to (stubbed) GitHub.
    assert.ok(calls.some((c) => c.body?.config?.secret === SECRET))

    for (const res of responses) {
      assert.equal(res.body.includes(SECRET), false, `secret in ${res.body}`)
      assert.equal(res.body.includes(TOKEN), false, `token in ${res.body}`)
      const keys = keysDeep(res.json())
      assert.ok(!keys.includes('config'), `raw config in ${res.body}`)
      assert.ok(!keys.includes('hookId'), `hook id in ${res.body}`)
    }

    assert.ok(lines.length >= 8, `only ${lines.length} log lines captured — the capture is not wired`)
    const all = lines.join('')
    assert.equal(all.includes(SECRET), false, 'the webhook secret was logged')
    assert.equal(all.includes(TOKEN), false, 'the GitHub token was logged')

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name)
    assert.ok(tables.length > 3)
    for (const table of tables) {
      const dump = JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all())
      assert.equal(dump.includes(SECRET), false, `the secret is stored in ${table}`)
      assert.equal(dump.includes(TOKEN), false, `the token is stored in ${table}`)
    }
  } finally {
    await logged.close()
  }
})

// ---- guardrails 2 and 9, across every case above ----

test('no case in this file sent a DELETE or an unexpected GitHub call', () => {
  assert.ok(calls.length > 20, 'the stub saw too few calls to mean anything')
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE'), [])
  assert.deepEqual(unexpected, [])
  assert.ok(calls.every((c) => c.url.startsWith(`${GH}/`)))
})

// ---- guardrails 7 and 8: files this item must not change ----

