// HO-875 guardrails 1 and 4: with one GitHub repo and one sl repo connected,
// one full GitHub poll tick (pollOnce, plus the artifacts prune its loop
// runs) still makes every call the GitHub repo always got — the issue poll,
// the comment poll, the PR-state poll, the main-head read, the default-branch
// read and the e2e-artifacts prune — and none for the sl repo, not even for
// an sl item parked at the Accept gate with a PR number. The sl poll tick
// reads only farmd's Task routes.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFarmTasksStub } from './helpers/farmTasksStub.mjs'

const SECRET = 'sl-poll-filter-farm-secret'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-sl-poll-filter-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = SECRET
process.env.GITHUB_TOKEN = 'sl-poll-filter-fake-token'
for (const key of ['FARM_HOME', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const farm = createFarmTasksStub({ secret: SECRET })
const github = []
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  if (url.origin !== 'https://api.github.com') return farm.fetch(input, init)
  github.push(`${(init.method || 'GET').toUpperCase()} ${url.pathname}`)
  const repo = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)/)?.[1]
  if (url.pathname === `/repos/${repo}`) return json(200, { full_name: repo, default_branch: 'main' })
  if (/\/pulls\/\d+$/.test(url.pathname)) return json(200, { merged: false, state: 'open', mergeable: true, mergeable_state: 'clean' })
  if (/\/(branches|git\/ref)\//.test(url.pathname)) return json(200, { commit: { sha: 'a'.repeat(40) }, object: { sha: 'a'.repeat(40) } })
  return json(200, [], { etag: '"filter"' })
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { forKind } = await import('../src/backends/index.js')
const { ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
after(() => {
  globalThis.fetch = realFetch
  forKind('github').vcs.setMainHeadListener(null)
})

const GH_REPO = 'acme/gh-app'
const SL_REPO = 'acme/sl-app'
const project = store.createProject('poll filter').id
assert.equal(store.addRepoToProject(project, GH_REPO).ok, true)
assert.equal(store.addRepoToProject(project, SL_REPO, 'sl').ok, true)
const insert = db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo, issue, task_id, pr, backend) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
insert.run('GH-5', 'GitHub item at Accept', 'Medium', ACCEPT_GATE_INDEX, 'change', project, GH_REPO, 5, null, 41, 'github')
insert.run('SLA-5', 'sl item at Accept', 'Medium', ACCEPT_GATE_INDEX, 'change', project, SL_REPO, null, '5', 42, 'sl')
// Past the comment poll's first-run baseline, so its request is made.
db.prepare("INSERT INTO sync_cursor (key, etag, last_synced_at) VALUES (?, NULL, '2026-11-01T00:00:00Z')").run(`comments:${GH_REPO}`)

const quietLog = { info() {}, warn() {}, error() {}, debug() {} }

test('guardrail 4: one full GitHub poll tick still polls the GitHub repo every way, and the sl repo not at all', async () => {
  const heads = []
  forKind('github').vcs.setMainHeadListener((repo, sha) => heads.push([repo, sha]))
  await forKind('github').tracker.pollOnce(quietLog)
  await forKind('github').artifacts.pruneArtifactRefs(quietLog)

  const gh = (pattern) => github.filter((call) => pattern.test(call))
  assert.equal(gh(new RegExp(`^GET /repos/${GH_REPO}$`)).length, 1, 'the default-branch read')
  assert.equal(gh(new RegExp(`^GET /repos/${GH_REPO}/issues$`)).length, 1, 'the issue poll')
  assert.equal(gh(new RegExp(`^GET /repos/${GH_REPO}/issues/comments$`)).length, 1, 'the comment poll')
  assert.equal(gh(new RegExp(`^GET /repos/${GH_REPO}/pulls/41$`)).length, 1, 'the PR-state poll')
  assert.ok(gh(new RegExp(`^GET /repos/${GH_REPO}/(branches|git/ref)/`)).length >= 1, 'the main-head read')
  assert.deepEqual(heads, [[GH_REPO, 'a'.repeat(40)]])
  assert.ok(gh(new RegExp(`^GET /repos/${GH_REPO}/git/matching-refs/`)).length >= 1, 'the e2e-artifacts prune')
  assert.deepEqual(
    github.filter((call) => call.includes(SL_REPO)),
    [],
    github.join('\n'),
  )
  assert.equal(farm.calls.length, 0, 'the GitHub tick asks farmd nothing')
})

test('guardrail 1: the sl poll tick reads only farmd’s Task routes', async () => {
  const before = github.length
  const result = await forKind('sl').tracker.pollOnce(quietLog)
  assert.deepEqual(result, { changed: 0 })
  assert.equal(github.length, before, 'no GitHub call')
  assert.ok(farm.calls.length > 0)
  assert.ok(farm.calls.every((c) => c.route === 'list' && c.path.startsWith(`/api/farm/tasks?repo=${encodeURIComponent(SL_REPO)}`)))
  assert.deepEqual(farm.strays, [])
})
