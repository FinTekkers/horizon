// HO-871 metrics 2 and 3: with a stub adapter behind forRepo(repo).tracker
// (backends/index.js setBackendForTest), each moved Tracker path calls its
// port method exactly once — item create (POST /api/items), Plan filing
// (planFiling.fileDrafts → spawn.js), the final-gate close, one signed
// /api/webhooks/github event, and the server.js polling call. Plus the
// guardrails: the signature check runs before the port, item ids stay
// `<prefix>-<issue>` with the issue link unchanged, a pull_request event
// reaches no tracker method, and an unconnected repo's events stay no-ops on
// the real adapter.
//
// Driven through the real Fastify app. Its own file because config.js reads
// GITHUB_WEBHOOK_SECRET at import time.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { stripComments } from './helpers/repoFiles.mjs'

const SECRET = 'tracker-port-calls-secret'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-tracker-port-calls-')), 'test.db')
process.env.GITHUB_WEBHOOK_SECRET = SECRET
process.env.GITHUB_TOKEN = 'tracker-port-calls-fake-token'
for (const key of ['FARM_URL', 'FARM_HOME', 'HORIZON_REPO']) delete process.env[key]

// No live GitHub call from anything the stub does not cover.
const realFetch = globalThis.fetch
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const planDraft = await import('../src/planDraft.js')
const { fileDrafts } = await import('../src/planFiling.js')
const { buildApp } = await import('../src/app.js')
const { forKind, setBackendForTest } = await import('../src/backends/index.js')
const { githubAdapters } = await import('../src/backends/github.js')
const { endIndex, stepKeyAt, APPROVE_FILE_GATE_INDEX, PLAN_DRAFT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

// Every log line at warn or above, for the unconnected-repo case.
const logLines = []
const app = buildApp({ logger: { level: 'warn', stream: { write: (line) => logLines.push(JSON.parse(line)) } } })
await app.ready()
const { pin, cookie } = loginFixtureUser(auth, config)
const inject = (opts) => app.inject({ ...opts, headers: { 'x-human-key': pin, ...opts.headers, cookie } })

after(async () => {
  setBackendForTest('github', null)
  globalThis.fetch = realFetch
  await app.close()
})

const REPO = 'acme/port-calls'
const projectId = store.createProject('HO-871 port calls').id
const connected = store.addRepoToProject(projectId, REPO)
assert.equal(connected.ok, true, JSON.stringify(connected))
const PREFIX = connected.prefix

// ---- the stub adapter: every tracker method counts its calls ----

const calls = []
let nextIssue = 4700
const issueFor = (repo, title, body = '') => {
  const number = nextIssue++
  return { number, html_url: `https://github.com/${repo}/issues/${number}`, title, body, labels: [], state: 'open' }
}
const answers = {
  createIssue: async (repo, { title }) => issueFor(repo, title),
  findSplitIssue: async () => null,
  ingestIssue: () => false,
  ingestComment: () => false,
  pollRepo: async () => ({ changed: 0 }),
  pollComments: async () => ({ changed: 0 }),
  pollOnce: async () => ({ changed: 0 }),
  startPolling: () => {},
  getSyncState: () => ({ tokenConfigured: true, repos: [] }),
}
const stubTracker = Object.fromEntries(
  Object.keys(githubAdapters.tracker).map((name) => [
    name,
    (...args) => {
      calls.push({ name, args })
      return (answers[name] ?? (async () => undefined))(...args)
    },
  ]),
)
const callsTo = (name) => calls.filter((c) => c.name === name)
// Tracker calls other than the read-only sync status the SSE snapshot takes.
const portCalls = () => calls.filter((c) => c.name !== 'getSyncState')

setBackendForTest('github', { ...githubAdapters, tracker: stubTracker })
beforeEach(() => {
  calls.length = 0
  setBackendForTest('github', { ...githubAdapters, tracker: stubTracker })
})

const sign = (body, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
function webhook(event, payload, { secret = SECRET } = {}) {
  const body = JSON.stringify(payload)
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sign(body, secret) },
    payload: body,
  })
}
const commentEvent = (repo, issue) => ({
  action: 'created',
  repository: { full_name: repo },
  issue: { number: issue },
  comment: { id: 99001, body: 'Please also cover the empty state.', user: { login: 'someone', type: 'User' } },
})

// ---- metric 2 ----

test('metric 2: POST /api/items calls tracker.createIssue once; the id is <prefix>-<issue> and the link is unchanged', async () => {
  const res = await inject({
    method: 'POST',
    url: '/api/items',
    payload: {
      title: 'Port create',
      outcome: 'The item files through the port.',
      metric: 'One line of metric text.',
      guardrails: 'No guardrail broken here.',
      priority: 'Medium',
      repo: REPO,
    },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(callsTo('createIssue').length, 1)
  assert.equal(callsTo('createIssue')[0].args[0], REPO)
  assert.equal(callsTo('createIssue')[0].args[1].title, 'Port create')
  const body = res.json()
  const issueNumber = body.issue
  assert.equal(body.id, `${PREFIX}-${issueNumber}`)
  assert.equal(body.url, `https://github.com/${REPO}/issues/${issueNumber}`)
  const item = store.getItem(body.id)
  assert.ok(item, `${body.id} was stored`)
  assert.equal(item.issue, issueNumber)
  // The stored issue link (repo + issue, as the UI builds it) is the stub's html_url.
  assert.equal(`https://github.com/${item.repo}/issues/${item.issue}`, body.url)
})

test('metric 2: Plan filing (fileDrafts → spawn.js) with one draft calls tracker.createIssue once', async () => {
  const id = `${PREFIX}-90`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo, issue) VALUES (?, 'Plan to file', 'High', ?, 'plan', ?, ?, 90)",
  ).run(id, PLAN_DRAFT_STEP_INDEX, projectId, REPO)
  const lines = (prefix) => [1, 2, 3].map((n) => `${prefix} line ${n}.`)
  const doc = {
    items: [
      {
        id: '#1',
        repo: REPO,
        title: 'The one draft',
        outcome: 'The one draft, done well.',
        metric: lines('Metric'),
        guardrails: lines('Guardrail'),
        depends_on: [],
        must_also_cover: [],
      },
    ],
    shared_guardrails: [],
    open_questions: [],
  }
  const saved = planDraft.ingestDraft(store.getItem(id), null, doc, 'PM')
  assert.equal(saved.ok, true, JSON.stringify(saved))
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(APPROVE_FILE_GATE_INDEX, id)

  const result = await fileDrafts(store.getItem(id))
  assert.ok(result.summary, JSON.stringify(result))
  assert.equal(callsTo('createIssue').length, 1)
  assert.equal(callsTo('findSplitIssue').length, 1)
  assert.equal(callsTo('createIssue')[0].args[0], REPO)
  assert.equal(callsTo('createIssue')[0].args[1].title, 'The one draft')
})

test('metric 2: approving the final gate calls tracker.closeIssueWithSummary once', async () => {
  const kind = 'task'
  const id = 'PC-FINAL'
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, repo, issue, project_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'Final gate', 'Medium', endIndex(kind) - 1, REPO, 931, projectId, kind)
  const res = await inject({ method: 'POST', url: `/api/items/${id}/move`, payload: { action: 'approve', from: stepKeyAt(endIndex(kind) - 1) } })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(callsTo('closeIssueWithSummary').length, 1)
  assert.equal(callsTo('closeIssueWithSummary')[0].args[0].id, id)
  assert.equal(store.getItem(id).cursor, endIndex(kind))
})

// ---- metric 3 ----

test('metric 3: one signed issue_comment webhook reaches tracker.ingestComment once', async () => {
  const res = await webhook('issue_comment', commentEvent(REPO, 931))
  assert.equal(res.statusCode, 204, res.body)
  assert.equal(callsTo('ingestComment').length, 1)
  const [repo, issue, comment] = callsTo('ingestComment')[0].args
  assert.equal(repo, REPO)
  assert.equal(issue, 931)
  assert.equal(comment.id, 99001)
  assert.deepEqual(portCalls().map((c) => c.name), ['ingestComment'])
})

test('metric 3: server.js polls through tracker.startPolling, once, and never github.startPolling', () => {
  const source = stripComments(readFileSync(new URL('../src/server.js', import.meta.url), 'utf8'))
  assert.equal(source.split('tracker.startPolling(').length - 1, 1, 'server.js calls tracker.startPolling( exactly once')
  assert.equal(source.split('github.startPolling').length - 1, 0, 'server.js does not call github.startPolling')
  assert.match(source, /forKind\('github'\)\.tracker\.startPolling\(fastify\.log\)/)
  // The line server.js runs, against the stub: one call, handed the logger.
  const log = { info() {}, warn() {} }
  forKind('github').tracker.startPolling(log)
  assert.equal(callsTo('startPolling').length, 1)
  assert.equal(callsTo('startPolling')[0].args[0], log)
})

// ---- guardrails ----

test('guardrail: a bad signature is refused with 401 before any tracker call', async () => {
  const res = await webhook('issue_comment', commentEvent(REPO, 931), { secret: 'not-the-secret' })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'bad_signature' })
  assert.deepEqual(portCalls(), [])
})

test('guardrail: a signed pull_request event reaches no tracker method', async () => {
  const res = await webhook('pull_request', {
    action: 'closed',
    repository: { full_name: REPO },
    pull_request: { number: 12, merged: false, state: 'closed', base: { ref: 'main' } },
  })
  assert.equal(res.statusCode, 204, res.body)
  assert.deepEqual(portCalls(), [])
})

test('guardrail: on the real adapter, issues and issue_comment events for an unconnected repo return 204, create no item and log no error', async () => {
  setBackendForTest('github', null)
  const repo = 'nobody/unconnected'
  const countItems = () => db.prepare('SELECT COUNT(*) AS n FROM work_item').get().n
  const before = countItems()
  logLines.length = 0
  const issues = await webhook('issues', {
    action: 'opened',
    repository: { full_name: repo },
    issue: { number: 5, title: 'Not ours', body: '## Outcome\nNothing.', labels: [], state: 'open' },
  })
  assert.equal(issues.statusCode, 204, issues.body)
  const comment = await webhook('issue_comment', commentEvent(repo, 5))
  assert.equal(comment.statusCode, 204, comment.body)
  assert.equal(countItems(), before)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_item WHERE repo = ?').get(repo).n, 0)
  assert.deepEqual(logLines, [], 'no warn or error was logged')
  assert.deepEqual(calls, [], 'the stub was not in place')
})
