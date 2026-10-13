// HZ-425: Horizon reads each connected repo's real GitHub default branch,
// never an assumed `main`. A repo whose default is `master` gets its poll,
// merged-PR detection and auto-resolve scan on `master`; the branch is cached
// in project_repo, set on connect, by a signed `repository` webhook, and
// re-read by the poll once a day old. GitHub and the farm are the
// auto-resolve harness's fetch stub (helpers/autoResolveHarness.mjs).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupAutoResolve, REPO, MAIN_SHA_2 } from './helpers/autoResolveHarness.mjs'

const h = await setupAutoResolve('repo-default-branch')
const { store, github, autoResolve, gh, app } = h

const HOUR = 60 * 60_000
const ago = (ms) => Date.now() - ms
const refReads = () => gh.calls.filter((c) => c.path.includes('/git/ref/')).map((c) => c.path.replace(/^.*heads%2F/, ''))
const repoReads = (repo = REPO) => gh.calls.filter((c) => c.path === `/repos/${repo}`)
const settle = async () => {
  await new Promise((r) => setTimeout(r, 300)) // past AUTO_RESOLVE_DEBOUNCE_MS
  await autoResolve.whenIdleForTest()
}

beforeEach(async () => {
  await h.reset()
  store.setDefaultBranch(REPO, 'master')
  gh.defaultBranch = 'master'
})

// ---- metric 1 ----

test('metric 1: on a master repo the poll reads master and the PRs merged into master, never main', async () => {
  gh.commitPrs.set(MAIN_SHA_2, [{ number: 250, base: 'master' }, { number: 251, base: 'main' }])
  await h.pollTick()
  assert.deepEqual(await github.prsForCommit(REPO, MAIN_SHA_2), [250])
  assert.ok(refReads().length > 0, 'the poll read the default branch head')
  assert.deepEqual([...new Set(refReads())], ['master'])
})

test('metric 1: a signed PR merged into master starts the auto-resolve scan on master; the same merge into main does not', async () => {
  h.conflictedAtGate('DB-Y', 402)
  h.farmReplyNext(h.resolved)

  const intoMain = await h.mergeWebhook(401, { base: 'main' })
  assert.equal(intoMain.statusCode, 204)
  await settle()
  assert.equal(h.farmCalls.length, 0, 'a merge into a branch that is not the default starts nothing')
  assert.deepEqual(h.itemLines('DB-Y'), [])

  const intoMaster = await h.mergeWebhook(403, { base: 'master' })
  assert.equal(intoMaster.statusCode, 204)
  await h.untilFarmCalls(1)
  await autoResolve.whenIdleForTest()
  assert.deepEqual(h.resolveCallsFor('DB-Y').length, 1)
  assert.deepEqual([...new Set(refReads())], ['master'], 'the scan read master, never main')
})

test('metric 1: a repo with main as its default is unchanged — a merge into main still starts the scan', async () => {
  store.setDefaultBranch(REPO, 'main')
  gh.defaultBranch = 'main'
  h.conflictedAtGate('DB-M', 412)
  h.farmReplyNext(h.resolved)
  assert.equal((await h.mergeWebhook(411, { base: 'main' })).statusCode, 204)
  await h.untilFarmCalls(1)
  await autoResolve.whenIdleForTest()
  assert.deepEqual([...new Set(refReads())], ['main'])
})

// Every server read of a repo's default-branch head goes through the cache.
// A literal 'main' would bring back the price-service incident.
test('metric 1: no server source reads a branch head or matches a merge base against a literal main', () => {
  const dir = join(import.meta.dirname, '../src')
  const offenders = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/getBranchSha\([^;]*'main'\s*\)/.test(line) || /base\??\.ref\s*===\s*'main'/.test(line)) offenders.push(`${file}:${i + 1}`)
      })
  }
  assert.deepEqual(offenders, [])
})

// ---- metric 2 ----

const repositoryEvent = (changes, defaultBranch, opts) =>
  h.webhook('repository', { action: 'edited', changes, repository: { full_name: REPO, default_branch: defaultBranch } }, opts)

test('metric 2: a signed repository edit that changes the default branch updates the cache; a description edit does not', async () => {
  store.setDefaultBranch(REPO, 'master', ago(2 * HOUR))
  const res = await repositoryEvent({ default_branch: { from: 'master' } }, 'main')
  assert.equal(res.statusCode, 204)
  const cached = store.getDefaultBranch(REPO)
  assert.equal(cached.branch, 'main')
  assert.ok(Date.now() - Date.parse(`${cached.at.replace(' ', 'T')}Z`) < 60_000, 'the read is stamped now')

  const before = store.getDefaultBranch(REPO)
  assert.equal((await repositoryEvent({ description: { from: 'old' } }, 'trunk')).statusCode, 204)
  assert.deepEqual(store.getDefaultBranch(REPO), before)
})

test('guardrail 4: a repository event with a bad or missing signature is refused and never changes the cache', async () => {
  const before = store.getDefaultBranch(REPO)
  for (const signature of ['sha256=' + '0'.repeat(64), null]) {
    const res = await repositoryEvent({ default_branch: { from: 'master' } }, 'main', { signature })
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: 'bad_signature' })
    assert.deepEqual(store.getDefaultBranch(REPO), before)
  }
})

test('metric 2: a cached branch 25h old is re-read on the next poll; one 1h old is not', async () => {
  gh.defaultBranch = 'trunk'
  store.setDefaultBranch(REPO, 'master', ago(HOUR))
  await github.pollOnce(null)
  assert.equal(repoReads().length, 0, 'a fresh value makes no GitHub call')
  assert.equal(store.getDefaultBranch(REPO).branch, 'master')

  store.setDefaultBranch(REPO, 'master', ago(25 * HOUR))
  await github.pollOnce(null)
  assert.equal(repoReads().length, 1)
  assert.equal(store.getDefaultBranch(REPO).branch, 'trunk')
  assert.ok(refReads().includes('trunk'), 'the same poll read the new branch head')
})

// ---- metric 4 ----

test('metric 4: connecting a repo records its default branch, and the board snapshot Admin reads lists it', async () => {
  gh.defaultBranch = 'master'
  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${h.projectId}/repos`,
    headers: { cookie: h.cookie },
    payload: { repo: 'acme/price-service' },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().defaultBranch, 'master')
  assert.equal(store.getDefaultBranch('acme/price-service').branch, 'master')

  const board = await app.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie: h.cookie } })
  const listed = board
    .json()
    .projects.flatMap((p) => p.repos)
    .find((r) => r.repo === 'acme/price-service')
  assert.equal(listed.defaultBranch, 'master')
  assert.deepEqual(h.nonGetGithubCalls(), [], 'connecting wrote nothing to GitHub repos or branches')
})
