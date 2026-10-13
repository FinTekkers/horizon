// HZ-425: the deploy queue releases a repo's real default branch. On 11-12
// Oct price-service-rust's default was `master`, every 5s tick asked GitHub
// for `main`, got a 404 and the batch stayed open for 16 hours. Now a due
// batch reads the cached default branch (no GitHub call for it per tick),
// and a branch it can't read fails the batch with a one-line reason after
// DEFAULT_BRANCH_MAX_ATTEMPTS ticks in a row. GitHub is deployQueueStub with
// a `master` branch in front of it; tick() runs on an injected clock.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'
import { deployQueueStub, shaOf } from './helpers/deployQueueStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-branch-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-branch-home-'))
process.env.GITHUB_TOKEN = 'ghp_TEST_SENTINEL_hz425'
for (const key of ['FARM_URL', 'HORIZON_REPO', 'HORIZON_DEPLOY_BATCH_S', 'HORIZON_DEPLOY_WAIT_MS', 'FARM_STEP_TIMEOUT_MS']) delete process.env[key]

const REPO = 'acme/price-service-rust'
await useDeployTargetRows([{ key: 'psr', repo: REPO, stateKey: 'psr', script: 'psr.sh', service: 'psr-test' }])

const warned = []
console.warn = (...args) => warned.push(args.map(String).join(' '))

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const deployQueue = await import('../src/deployQueue.js')
const { DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { sqlTime, TICK_MS, DEFAULT_BRANCH_MAX_ATTEMPTS } = deployQueue

store.purgeDemoItems()
const project = store.createProject('HZ-425 deploy queue')
assert.ok(store.addRepoToProject(project.id, REPO).ok)

const failed = []
deployQueue.setDeployQueueHooks({ kick: () => {}, fail: (id, message) => failed.push({ id, message }) })

const MASTER_SHA = shaOf(0xbeef)
let stub
let masterStatus // HTTP status GitHub answers for master's ref
function useStub() {
  stub = deployQueueStub()
  const inner = stub.fetch
  stub.fetch = async (url, opts = {}) => {
    const u = new URL(String(url))
    if (u.hostname === 'api.github.com' && /\/git\/ref\/heads(%2F|\/)master$/.test(u.pathname)) {
      stub.requests.push({ method: opts.method || 'GET', path: u.pathname })
      return masterStatus === 200
        ? { ok: true, status: 200, json: async () => ({ object: { sha: MASTER_SHA } }) }
        : { ok: false, status: masterStatus, json: async () => ({}) }
    }
    return inner(url, opts)
  }
  globalThis.fetch = stub.fetch
}

const T0 = Date.parse('2026-10-11T09:00:00Z')
let n = 0
// One item queued in an open batch whose window closed at T0.
function dueBatch() {
  n += 1
  const id = `PSR-${n}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    `Deploy fixture ${n}`,
    'Medium',
    DEPLOY_STEP_INDEX,
    REPO,
    n,
    100 + n,
  )
  const batchId = db
    .prepare('INSERT INTO deploy_batch (target, repo, window_closes_at, created_at) VALUES (?, ?, ?, ?)')
    .run('psr', REPO, sqlTime(T0), sqlTime(T0 - 60_000)).lastInsertRowid
  db.prepare('INSERT INTO deploy_queue_entry (item_id, target, merge_sha, batch_id, joined_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    'psr',
    shaOf(n),
    batchId,
    sqlTime(T0 - 60_000),
  )
  return { id, batchId }
}

const batch = (id) => db.prepare('SELECT * FROM deploy_batch WHERE id = ?').get(id)
const refReads = () => stub.requests.filter((r) => r.path.includes('/git/ref/')).map((r) => r.path.replace(/^.*heads(%2F|\/)/, ''))
const repoReads = () => stub.requests.filter((r) => r.path === `/repos/${REPO}`)
const writes = () => stub.requests.filter((r) => r.method !== 'GET')

async function ticks(count, from = T0) {
  for (let i = 0; i < count; i++) await deployQueue.tick(from + i * TICK_MS)
  return from + count * TICK_MS
}

beforeEach(() => {
  db.exec("DELETE FROM deploy_queue_entry; DELETE FROM deploy_batch; DELETE FROM work_item WHERE id LIKE 'PSR-%'")
  useStub()
  masterStatus = 200
  failed.length = 0
  warned.length = 0
  store.setDefaultBranch(REPO, 'master', T0)
})

// ---- metric 1 / guardrail 2 ----

test('metric 1: a master repo releases its batch from master, never asking for main', async () => {
  const { batchId } = dueBatch()
  await ticks(1)
  assert.equal(batch(batchId).status, 'deploying', 'the batch was published')
  assert.equal(batch(batchId).commit_sha, MASTER_SHA)
  assert.equal(stub.posts.length, 1)
  assert.equal(stub.posts[0].target_commitish, MASTER_SHA)
  assert.deepEqual(refReads(), ['master'])
  // Guardrail 2: no branch or repo is written — the only write is the release.
  assert.deepEqual(writes().map((r) => `${r.method} ${r.path}`), [`POST /repos/${REPO}/releases`])
})

// ---- guardrail 3 ----

test('guardrail 3: ten ticks of an open batch read the default branch from the cache — no GET /repos/:r', async () => {
  const { batchId } = dueBatch()
  masterStatus = 404
  await ticks(10)
  assert.equal(batch(batchId).status, 'open')
  assert.equal(batch(batchId).start_attempts, 10)
  assert.deepEqual(repoReads(), [])
  assert.deepEqual([...new Set(refReads())], ['master'])
})

// ---- metric 3 ----

test(`metric 3: ${DEFAULT_BRANCH_MAX_ATTEMPTS} failed reads of master fail the batch with one line naming the repo and the branch`, async () => {
  const { id, batchId } = dueBatch()
  masterStatus = 404
  const next = await ticks(DEFAULT_BRANCH_MAX_ATTEMPTS - 1)
  assert.equal(batch(batchId).status, 'open', 'still retrying before the bound')
  assert.deepEqual(failed, [])
  await ticks(1, next)
  const row = batch(batchId)
  assert.equal(row.status, 'failed')
  assert.ok(!row.failure.includes('\n'), 'one line')
  assert.match(row.failure, new RegExp(`cannot read branch 'master' of ${REPO} after ${DEFAULT_BRANCH_MAX_ATTEMPTS} attempts`))
  assert.match(row.failure, /404/)
  assert.match(row.failure, /^deploy psr failed/, 'names the target, not a null tag')
  assert.deepEqual(failed, [{ id, message: row.failure }])
  assert.equal(stub.posts.length, 0)
  assert.equal(refReads().length, DEFAULT_BRANCH_MAX_ATTEMPTS, 'one read per tick, then none')
  await ticks(5, next + TICK_MS)
  assert.equal(refReads().length, DEFAULT_BRANCH_MAX_ATTEMPTS)
})

// Right after deploy, a connected repo's branch is NULL until the first poll
// (about 60s, so about 12 of the 60 attempts); here it is never read.
test('metric 3: a default branch never read fails the batch as unknown, never null, with no GitHub call for it', async () => {
  db.prepare('UPDATE project_repo SET default_branch = NULL, default_branch_at = NULL WHERE repo = ?').run(REPO)
  const { batchId } = dueBatch()
  await ticks(DEFAULT_BRANCH_MAX_ATTEMPTS)
  const row = batch(batchId)
  assert.equal(row.status, 'failed')
  assert.ok(!row.failure.includes('\n'))
  assert.match(row.failure, new RegExp(`cannot read branch 'unknown' of ${REPO} after ${DEFAULT_BRANCH_MAX_ATTEMPTS} attempts`))
  assert.ok(!/null/.test(row.failure))
  assert.deepEqual(refReads(), [])
  assert.deepEqual(repoReads(), [])
})

test('metric 2: a cached branch over 24h old is not used before the poll re-reads it', async () => {
  store.setDefaultBranch(REPO, 'master', T0 - 25 * 60 * 60_000)
  const { batchId } = dueBatch()
  await ticks(1)
  assert.equal(batch(batchId).status, 'open')
  assert.equal(batch(batchId).start_attempts, 1)
  assert.deepEqual(refReads(), [])
  assert.deepEqual(repoReads(), [], 'the tick itself never calls GitHub for it')
  store.setDefaultBranch(REPO, 'master', T0) // the poll's re-read
  await ticks(1, T0 + TICK_MS)
  assert.equal(batch(batchId).status, 'deploying')
})

test(`metric 3: the count is of reads in a row — ${DEFAULT_BRANCH_MAX_ATTEMPTS - 1} failures, a success, then ${DEFAULT_BRANCH_MAX_ATTEMPTS - 1} more never fail`, async () => {
  const first = dueBatch()
  masterStatus = 404
  let at = await ticks(DEFAULT_BRANCH_MAX_ATTEMPTS - 1)
  assert.equal(batch(first.batchId).start_attempts, DEFAULT_BRANCH_MAX_ATTEMPTS - 1)
  masterStatus = 200
  at = await ticks(1, at)
  assert.equal(batch(first.batchId).status, 'deploying')
  assert.equal(batch(first.batchId).start_attempts, 0, 'the success reset the count')

  db.prepare("UPDATE deploy_batch SET status = 'done' WHERE id = ?").run(first.batchId)
  const second = dueBatch()
  masterStatus = 404
  await ticks(DEFAULT_BRANCH_MAX_ATTEMPTS - 1, at)
  assert.equal(batch(second.batchId).status, 'open')
  assert.deepEqual(failed, [])
})

// ---- guardrail 1 ----

test('guardrail 1: a repo that is not connected keeps releasing main, as before', async () => {
  const { batchId } = dueBatch()
  db.prepare('DELETE FROM project_repo WHERE repo = ?').run(REPO)
  try {
    await ticks(1)
    assert.equal(batch(batchId).status, 'deploying')
    assert.equal(batch(batchId).commit_sha, stub.mainSha)
    assert.deepEqual(refReads(), ['main'])
  } finally {
    store.addRepoToProject(project.id, REPO)
  }
})
