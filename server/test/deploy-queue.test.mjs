// HZ-333: the deploy queue. Step 14 joins its target's queue; one batch per
// window publishes one release of main and deploys once; each item whose
// merge is an ancestor of the deployed commit is released to its smoke check.
// GitHub and the farm are a fetch stub; the deploy outcome is the target's
// state dir (last-good-tag, self-deploy.log); tick() runs on an injected clock.

import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'
import { deployQueueStub, shaOf } from './helpers/deployQueueStub.mjs'

const TOKEN = 'ghp_SENTINELdeployqueue0123456789abcdefXYZ'
const WEBHOOK_SECRET = 'whsec-SENTINEL-deploy-queue-0123'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-home-'))
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
process.env.GITHUB_TOKEN = TOKEN
process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET
delete process.env.HORIZON_DEPLOY_BATCH_S
delete process.env.HORIZON_DEPLOY_WAIT_MS
delete process.env.FARM_STEP_TIMEOUT_MS

await useDeployTargetRows([
  { key: 'horizon', repo: 'FinTekkers/horizon', stateKey: 'horizon', script: 'h.sh', service: 'horizon-test' },
  { key: 'ui-service', repo: 'FinTekkers/ui-service', stateKey: 'ui-service', script: 'u.sh', service: 'ui-test' },
  { key: 'ledger-models', repo: 'FinTekkers/ledger-models', stateKey: 'ledger-models', script: 'l.sh', service: '', healthCheckType: 'registry-publish' },
  { key: 'market-data-inputs', repo: 'FinTekkers/market-data-inputs', stateKey: 'market-data-inputs', script: 'm.sh', service: '', healthCheckType: 'deploy-log' },
])

// Every console line, so the credential guardrail can read them all.
const logged = []
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level]
  console[level] = (...args) => {
    logged.push(args.map(String).join(' '))
    if (level === 'error') original(...args)
  }
}
const unhandled = []
process.on('unhandledRejection', (err) => unhandled.push(err))

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { DEPLOY_STEP_INDEX, requiredStepIndex } = await import('../../domain/js/lifecycle.js')
const { DEPLOY_BATCH_S, DEPLOY_WAIT_MS } = await import('../src/config.js')
const orchestrator = await import('../src/orchestrator.js')
const deployQueue = await import('../src/deployQueue.js')
const deploy = await import('../src/deploy.js')
const caretaker = await import('../src/caretaker.js')
const { parsePolicy, decide } = await import('../src/caretakerRules.js')
const { buildApp } = await import('../src/app.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: orchestrator.kick, cancel: orchestrator.cancel, pause: orchestrator.pause })
const policy = parsePolicy(readFileSync(join(import.meta.dirname, '../../farm/roles/caretaker.md'), 'utf8'))
const RELEASE_GATE = requiredStepIndex('Review the work & close')
const { msOf } = deployQueue

let stub
const spawned = []
deploy.runner.spawn = (target, tag) => spawned.push({ target: target.key, tag })

const created = []
let n = 0
function newItem(repo = 'FinTekkers/horizon') {
  n += 1
  const id = `DQ-${n}`
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    `Queue fixture ${n}`,
    'Medium',
    DEPLOY_STEP_INDEX,
    repo,
    n,
    100 + n,
  )
  stub.prs.set(`${repo}#${100 + n}`, shaOf(n))
  created.push(id)
  return id
}

const row = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
const entriesOf = (id) => db.prepare('SELECT * FROM deploy_queue_entry WHERE item_id = ? ORDER BY id').all(id)
const entry = (id) => entriesOf(id).at(-1)
const batch = (id) => db.prepare('SELECT * FROM deploy_batch WHERE id = ?').get(id)
const batchesOf = (target) => db.prepare('SELECT * FROM deploy_batch WHERE target = ? ORDER BY id').all(target)
const runsOf = (id) => db.prepare('SELECT * FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id').all(id, DEPLOY_STEP_INDEX)
const stateDir = (key) => join(process.env.HOME, '.horizon', key)
const releasePosts = () => stub.posts
const smokeDispatch = (id) => stub.dispatches.find((d) => d.path === '/steps/run' && d.body?.item?.id === id)?.body

function goLive(key, tag, commit) {
  mkdirSync(stateDir(key), { recursive: true })
  writeFileSync(join(stateDir(key), 'last-good-tag'), `refs/tags/${tag}:${commit}\n`)
}
function logLine(key, line) {
  mkdirSync(stateDir(key), { recursive: true })
  appendFileSync(join(stateDir(key), 'self-deploy.log'), `2026-10-07T12:00:00Z ${line}\n`)
}

async function waitFor(predicate, what) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail(`timed out waiting for ${what}`)
}

// Joins through the real kick(), then pins the join (and its window) to `at`.
async function joinAt(id, at) {
  orchestrator.kick(id)
  await waitFor(() => entry(id)?.status === 'queued', `${id} to queue`)
  const e = entry(id)
  db.prepare('UPDATE deploy_queue_entry SET joined_at = ? WHERE id = ?').run(deployQueue.sqlTime(at), e.id)
  if (db.prepare("SELECT COUNT(*) AS n FROM deploy_queue_entry WHERE batch_id = ?").get(e.batch_id).n === 1) {
    db.prepare('UPDATE deploy_batch SET window_closes_at = ? WHERE id = ?').run(deployQueue.sqlTime(at + DEPLOY_BATCH_S * 1000), e.batch_id)
  }
  return e.batch_id
}

beforeEach(() => {
  db.exec('DELETE FROM deploy_queue_entry; DELETE FROM deploy_batch')
  rmSync(join(process.env.HOME, '.horizon'), { recursive: true, force: true })
  stub = deployQueueStub()
  globalThis.fetch = stub.fetch
  spawned.length = 0
})

after(() => {
  for (const id of created) orchestrator.cancel(id)
  const secrets = [TOKEN, WEBHOOK_SECRET]
  const surfaces = [
    ...logged,
    ...db.prepare('SELECT output FROM step_run WHERE output IS NOT NULL').all().map((r) => r.output),
    ...db.prepare('SELECT text FROM event').all().map((r) => r.text),
    ...db.prepare('SELECT failure FROM deploy_batch WHERE failure IS NOT NULL').all().map((r) => r.failure),
  ]
  for (const secret of secrets) assert.ok(!surfaces.some((s) => s.includes(secret)), 'a credential reached a log, event or step output')
  assert.deepEqual(unhandled, [])
})

test('metric 1: two items joining one target publish nothing; each records its merge commit in one open batch', async () => {
  const a = newItem()
  const b = newItem()
  orchestrator.kick(a)
  orchestrator.kick(b)
  await waitFor(() => entry(a) && entry(b), 'both entries')

  assert.equal(releasePosts().length, 0)
  assert.equal(stub.requests.filter((r) => r.path.includes('/releases')).length, 0)
  assert.equal(entry(a).merge_sha, stub.prs.get(`FinTekkers/horizon#${row(a).pr}`))
  assert.equal(entry(b).merge_sha, stub.prs.get(`FinTekkers/horizon#${row(b).pr}`))
  assert.deepEqual([entry(a).status, entry(b).status], ['queued', 'queued'])
  const open = batchesOf('horizon')
  assert.equal(open.length, 1)
  assert.equal(open[0].status, 'open')
  assert.equal(entry(a).batch_id, open[0].id)
  assert.equal(entry(b).batch_id, open[0].id)
  // No step_run while queued: nothing for reconcile, rearm or the HZ-321 drain to see.
  assert.deepEqual([runsOf(a).length, runsOf(b).length], [0, 0])
  assert.ok(!store.listRunningAgentSteps().some((s) => s.itemId === a || s.itemId === b))
  assert.equal(stub.dispatches.filter((d) => d.path === '/steps/run').length, 0)
  // The board payload carries the window's close time.
  const view = store.listItems().find((i) => i.id === a)
  assert.equal(view.deploy_queue.target, 'horizon')
  assert.equal(view.deploy_queue.batch_status, 'open')
  assert.equal(Date.parse(view.deploy_queue.window_closes_at), msOf(open[0].window_closes_at))
})

test('metric 1: two kicks at once for one item give one queued entry and no constraint error', async () => {
  const a = newItem()
  orchestrator.kick(a)
  orchestrator.kick(a)
  await waitFor(() => entry(a), 'the entry')
  await new Promise((r) => setTimeout(r, 30))
  orchestrator.kick(a)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(entriesOf(a).length, 1)
  assert.equal(stub.requests.filter((r) => r.path.endsWith(`/pulls/${row(a).pr}`)).length, 1)
})

test('metric 2 / guardrails 2, 3, 8: three items in one window give one release of main and one deploy; targets deploy in parallel', async () => {
  const t0 = Math.floor((Date.now() - 1_000_000) / 1000) * 1000
  const [a, b, c] = [newItem(), newItem(), newItem()]
  const batchId = await joinAt(a, t0)
  await joinAt(b, t0 + 60_000)
  const closes = batch(batchId).window_closes_at
  assert.equal(msOf(closes), Math.floor(t0 / 1000) * 1000 + DEPLOY_BATCH_S * 1000)

  await deployQueue.tick(msOf(closes) - 1000)
  assert.equal(releasePosts().length, 0, 'nothing publishes before the window closes')
  // A join 800 s in does not move the window.
  await joinAt(c, t0 + 800_000)
  assert.equal(batch(batchId).window_closes_at, closes)

  // ui-service has its own queue and window.
  const u = newItem('FinTekkers/ui-service')
  const uBatch = await joinAt(u, t0)

  await deployQueue.tick(msOf(closes))
  assert.equal(releasePosts().length, 2, 'one release per target')
  const release = releasePosts().find((p) => p.repo === 'FinTekkers/horizon')
  assert.match(release.tag_name, new RegExp(`^deploy-horizon-\\d{8}-b${batchId}$`))
  assert.equal(release.target_commitish, stub.mainSha, 'pinned to main head, never an item branch')
  for (const id of [a, b, c]) assert.ok(release.body.includes(id))
  assert.ok(!release.body.includes(TOKEN) && !release.body.includes(WEBHOOK_SECRET))
  assert.equal(batch(batchId).status, 'deploying')
  assert.equal(batch(uBatch).status, 'deploying', 'a second target deploys while the first does')
  assert.ok(!store.listRunningAgentSteps().some((s) => [a, b, c].includes(s.itemId)))

  // GitHub's one webhook for the one release: exactly one deploy.
  const app = buildApp({ logger: false })
  const body = JSON.stringify({ action: 'published', repository: { full_name: 'FinTekkers/horizon' }, release: { tag_name: release.tag_name } })
  const res = await app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'release',
      'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex'),
    },
    payload: body,
  })
  assert.equal(res.statusCode, 204)
  assert.deepEqual(spawned, [{ target: 'horizon', tag: release.tag_name }])

  // A second horizon window waits while the first deploys; ticking again publishes nothing more.
  const d = newItem()
  const next = await joinAt(d, t0 + 100_000)
  assert.notEqual(next, batchId)
  await deployQueue.tick(msOf(closes) + 200_000)
  await deployQueue.tick(msOf(closes) + 400_000)
  assert.equal(releasePosts().length, 2)
  assert.equal(batch(next).status, 'open')
  await app.close()
})

test('metric 3: a live batch releases its items to a smoke check against its own release, the wait counted from its start', async () => {
  const t0 = Math.floor((Date.now() - 1_000_000) / 1000) * 1000
  const [a, b] = [newItem(), newItem()]
  const batchId = await joinAt(a, t0)
  await joinAt(b, t0)
  await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000)
  const { tag, commit_sha: commit, started_at: startedAt } = batch(batchId)

  goLive('horizon', tag, commit)
  await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000 + 30_000)
  assert.equal(batch(batchId).status, 'verifying')
  for (const id of [a, b]) {
    await waitFor(() => smokeDispatch(id), `${id}'s smoke dispatch`)
    const body = smokeDispatch(id)
    assert.equal(body.item.release_tag, tag)
    assert.equal(row(id).release_tag, tag)
    const expected = (DEPLOY_WAIT_MS - (Date.now() - msOf(startedAt))) / 1000
    assert.ok(Math.abs(body.deploy_wait.timeout_s - expected) < 5, `timeout_s ${body.deploy_wait.timeout_s} vs ${expected}`)
    assert.equal(entry(id).status, 'released')
  }
  assert.equal(releasePosts().length, 1, 'no per-item release (createDeployRelease) at dispatch')
  assert.ok(!stub.requests.some((r) => /releases\/tags\/deploy-dq-/.test(r.path)))
})

test('metric 3: an item that joins after its target started deploying stays queued for the next deploy', async () => {
  const t0 = Math.floor((Date.now() - 1_000_000) / 1000) * 1000
  const a = newItem()
  const first = await joinAt(a, t0)
  await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000)
  assert.equal(batch(first).status, 'deploying')

  const late = newItem()
  stub.compare = (base) => (base === shaOf(Number(late.slice(3))) ? 'behind' : 'ahead')
  const second = await joinAt(late, t0 + DEPLOY_BATCH_S * 1000 + 10_000)
  assert.notEqual(second, first)

  goLive('horizon', batch(first).tag, batch(first).commit_sha)
  await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000 + 20_000)
  assert.equal(entry(a).status, 'released')
  assert.equal(entry(late).status, 'queued')
  assert.equal(entry(late).batch_id, second)
  assert.equal(row(late).release_tag, null)
  assert.equal(smokeDispatch(late), undefined)
})

test('metric 3: a batch entry the deploy does not contain, or that GitHub cannot compare, is never released', async () => {
  const t0 = Math.floor((Date.now() - 1_000_000) / 1000) * 1000
  const [behind, unknown] = [newItem(), newItem()]
  const batchId = await joinAt(behind, t0)
  await joinAt(unknown, t0)
  stub.compare = (base) => (base === entry(behind).merge_sha ? 'behind' : 500)
  await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000)
  goLive('horizon', batch(batchId).tag, batch(batchId).commit_sha)
  await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000 + 30_000)

  assert.equal(entry(behind).status, 'queued')
  assert.notEqual(entry(behind).batch_id, batchId, 'moved to the next batch')
  assert.equal(batch(entry(behind).batch_id).status, 'open')
  assert.equal(entry(unknown).status, 'queued')
  assert.equal(entry(unknown).batch_id, batchId, 'retried on the next tick')
  assert.equal(batch(batchId).status, 'verifying')
  for (const id of [behind, unknown]) {
    assert.equal(row(id).release_tag, null)
    assert.equal(smokeDispatch(id), undefined)
    assert.equal(runsOf(id).length, 0)
  }
})

test('metric 3: an item that waited the full window still passes when the deploy goes live within the wait of its start', async () => {
  const t0 = Math.floor((Date.now() - 2_200_000) / 1000) * 1000
  const a = newItem()
  const batchId = await joinAt(a, t0)
  const start = t0 + DEPLOY_BATCH_S * 1000
  await deployQueue.tick(start)
  goLive('horizon', batch(batchId).tag, batch(batchId).commit_sha)
  // More than DEPLOY_WAIT_MS after the join, less than it after the deploy started.
  const liveAt = start + DEPLOY_WAIT_MS - 60_000
  assert.ok(liveAt - t0 > DEPLOY_WAIT_MS)
  await deployQueue.tick(liveAt)
  assert.equal(batch(batchId).status, 'verifying')
  assert.equal(entry(a).status, 'released')
  await waitFor(() => smokeDispatch(a), 'the smoke dispatch')
  assert.equal(row(a).paused, 0)
})

test('metric 4 / guardrail 6: DEPLOY FAILED in either log form fails step 14 for every item, naming the release and the batch', async () => {
  for (const form of ['bare', 'refs']) {
    db.exec('DELETE FROM deploy_queue_entry; DELETE FROM deploy_batch')
    const t0 = Math.floor((Date.now() - 1_000_000) / 1000) * 1000
    const [a, b] = [newItem(), newItem()]
    const batchId = await joinAt(a, t0)
    await joinAt(b, t0)
    goLive('horizon', 'deploy-horizon-previous', shaOf(0xee))
    const lastGood = readFileSync(join(stateDir('horizon'), 'last-good-tag'), 'utf8')
    await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000)
    const { tag } = batch(batchId)

    // A neighbouring tag's failure (-b7 vs -b70) is not this batch's.
    logLine('horizon', `DEPLOY FAILED: lock (tag=${tag}0)`)
    await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000 + 5000)
    assert.equal(batch(batchId).status, 'deploying')

    logLine('horizon', form === 'bare' ? `DEPLOY FAILED: lock (tag=${tag})` : `DEPLOY FAILED: health-check (tag=refs/tags/${tag} commit=${shaOf(1)}) — down`)
    await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000 + 10_000)
    assert.equal(batch(batchId).status, 'failed')
    for (const id of [a, b]) {
      const runs = runsOf(id)
      assert.equal(runs.length, 1, 'no auto-retry')
      assert.match(runs[0].output, new RegExp(`^FAILED: deploy ${tag} failed \\(the deploy log records DEPLOY FAILED for it\\) — batch: ${a}, ${b}$`))
      assert.equal(row(id).paused, 1)
      assert.equal(entry(id).status, 'failed')
    }
    assert.equal(readFileSync(join(stateDir('horizon'), 'last-good-tag'), 'utf8'), lastGood, 'last-good-tag unchanged')
    assert.deepEqual(spawned, [], 'no rollback deploy')
  }
})

test('metric 4: a deploy not live within HORIZON_DEPLOY_WAIT_MS of its start fails the batch the same way', async () => {
  const t0 = Math.floor((Date.now() - 1_000_000) / 1000) * 1000
  const [a, b] = [newItem(), newItem()]
  const batchId = await joinAt(a, t0)
  await joinAt(b, t0)
  const start = t0 + DEPLOY_BATCH_S * 1000
  await deployQueue.tick(start)
  await deployQueue.tick(start + DEPLOY_WAIT_MS)
  assert.equal(batch(batchId).status, 'deploying', 'not yet past the wait')
  await deployQueue.tick(start + DEPLOY_WAIT_MS + 1000)
  assert.equal(batch(batchId).status, 'failed')
  for (const id of [a, b]) {
    assert.match(runsOf(id)[0].output, new RegExp(`deploy ${batch(batchId).tag} failed \\(it was not live within ${DEPLOY_WAIT_MS / 1000}s of its start\\) — batch: ${a}, ${b}`))
    assert.equal(row(id).paused, 1)
  }
  assert.deepEqual(spawned, [])
})

test('metric 5: resuming a failed deploy step re-queues the item and never publishes a new tag', async () => {
  const t0 = Math.floor((Date.now() - 1_000_000) / 1000) * 1000
  const a = newItem()
  const batchId = await joinAt(a, t0)
  await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000)
  logLine('horizon', `DEPLOY FAILED: lock (tag=${batch(batchId).tag})`)
  await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000 + 5000)
  assert.equal(entry(a).status, 'failed')
  const posts = releasePosts().length

  assert.deepEqual(store.setPaused(a, false), { ok: true })
  await waitFor(() => entry(a).status === 'queued', 'the re-queued entry')
  assert.equal(entriesOf(a).length, 2)
  assert.notEqual(entry(a).batch_id, batchId)
  assert.equal(batch(entry(a).batch_id).status, 'open')
  assert.equal(releasePosts().length, posts, 'no release before the next window closes')
  assert.ok(!stub.requests.some((r) => /releases\/tags\/deploy-.*-b\d+-\d+$/.test(r.path)), 'never looks for a -2 tag')
  assert.ok(!stub.posts.some((p) => /-b\d+-\d+$/.test(p.tag_name)), 'never publishes a -2 tag')
})

test('guardrails 4, 5: re-ticking a publishing batch reuses its tag; a release on another commit fails it loudly', async () => {
  const t0 = Math.floor((Date.now() - 1_000_000) / 1000) * 1000
  const a = newItem()
  const batchId = await joinAt(a, t0)
  const tag = deployQueue.batchTag('horizon', batchId, t0)
  db.prepare("UPDATE deploy_batch SET status = 'publishing', tag = ?, commit_sha = ?, started_at = ? WHERE id = ?").run(
    tag,
    stub.mainSha,
    deployQueue.sqlTime(t0),
    batchId,
  )
  stub.releases.set(`FinTekkers/horizon@${tag}`, { tag_name: tag, target_commitish: stub.mainSha, html_url: 'https://x/r' })
  await deployQueue.tick(t0 + 1000)
  assert.equal(releasePosts().length, 0)
  assert.equal(batch(batchId).status, 'deploying')
  assert.equal(batch(batchId).release_url, 'https://x/r')

  const b = newItem()
  const other = await joinAt(b, t0)
  assert.notEqual(other, batchId)
  goLive('horizon', tag, stub.mainSha)
  await deployQueue.tick(t0 + 2000) // batch 1 verifying; b's own window still open
  const otherTag = deployQueue.batchTag('horizon', other, t0)
  db.prepare("UPDATE deploy_batch SET status = 'done' WHERE id = ?").run(batchId)
  db.prepare("UPDATE deploy_batch SET status = 'publishing', tag = ?, commit_sha = ?, started_at = ? WHERE id = ?").run(
    otherTag,
    stub.mainSha,
    deployQueue.sqlTime(t0),
    other,
  )
  stub.releases.set(`FinTekkers/horizon@${otherTag}`, { tag_name: otherTag, target_commitish: shaOf(0xdead), html_url: 'https://x/o' })
  await deployQueue.tick(t0 + 3000)
  assert.equal(releasePosts().length, 0)
  assert.equal(batch(other).status, 'failed')
  assert.match(batch(other).failure, /already exists on/)
  assert.equal(row(b).paused, 1)
})

test('guardrail 7: a library (registry-publish) target keeps the per-item release', async () => {
  const lib = newItem('FinTekkers/ledger-models')
  orchestrator.kick(lib)
  await waitFor(() => smokeDispatch(lib), 'the per-item dispatch')
  assert.deepEqual(entriesOf(lib), [])
  assert.equal(releasePosts().length, 1)
  assert.equal(releasePosts()[0].tag_name, `deploy-${lib.toLowerCase()}`)
  assert.equal(smokeDispatch(lib).item.release_tag, `deploy-${lib.toLowerCase()}`)
})

test('HZ-353: a code-only (deploy-log) target joins the queue, and its batch dispatch carries deploy-log', async () => {
  const t0 = Math.floor((Date.now() - 1_000_000) / 1000) * 1000
  const mdi = newItem('FinTekkers/market-data-inputs')
  assert.equal(deployQueue.queueTargetFor(row(mdi))?.key, 'market-data-inputs')
  const batchId = await joinAt(mdi, t0)
  await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000)
  const { tag, commit_sha: commit, started_at: startedAt } = batch(batchId)
  assert.equal(batch(batchId).target, 'market-data-inputs')
  assert.deepEqual(spawned, [], 'the queue publishes the release; the webhook runs the deploy script')

  goLive('market-data-inputs', tag, commit)
  logLine('market-data-inputs', `DEPLOY OK tag=refs/tags/${tag} commit=${commit}`)
  await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000 + 30_000)
  assert.equal(batch(batchId).status, 'verifying')
  await waitFor(() => smokeDispatch(mdi), 'the code-only Deploy dispatch')
  const body = smokeDispatch(mdi)
  assert.equal(body.item.release_tag, tag)
  assert.equal(body.deploy_wait.health_check_type, 'deploy-log')
  assert.equal(Object.hasOwn(body.deploy_wait, 'health_url'), false)
  assert.equal(body.deploy_wait.state_dir, stateDir('market-data-inputs'))
  // The wait counts from the batch's start (startedAt), as for a service target.
  const expected = (DEPLOY_WAIT_MS - (Date.now() - msOf(startedAt))) / 1000
  assert.ok(Math.abs(body.deploy_wait.timeout_s - expected) < 5, `timeout_s ${body.deploy_wait.timeout_s} vs ${expected}`)
  assert.equal(releasePosts().length, 1)
})

test('metric 6: gate 15 names the release, its commit and the ancestry, and keeps approving after a later batch moves last-good-tag', async () => {
  const t0 = Math.floor((Date.now() - 1_000_000) / 1000) * 1000
  const x = newItem()
  const batchA = await joinAt(x, t0)
  await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000)
  const A = batch(batchA)
  goLive('horizon', A.tag, A.commit_sha)
  await deployQueue.tick(t0 + DEPLOY_BATCH_S * 1000 + 10_000)
  await waitFor(() => runsOf(x).some((r) => r.status === 'active'), 'the smoke run')
  const run = runsOf(x).find((r) => r.status === 'active')
  await orchestrator.completeFarmRun(run.id, { summary: 'smoke passed', artifacts: { verdict: { verdict: 'pass' } } })
  assert.equal(row(x).cursor, RELEASE_GATE)
  assert.equal(entry(x).status, 'passed')

  const judge = () => decide(RELEASE_GATE, caretaker.gatherFacts(row(x), RELEASE_GATE, null), policy)
  const expected = `release ${A.tag} at ${A.commit_sha.slice(0, 7)} is live; merge ${entry(x).merge_sha.slice(0, 7)} is an ancestor of it`
  assert.deepEqual([judge().ruleId, judge().reason], ['g15.approve', expected])

  goLive('horizon', 'deploy-horizon-20261007-b999', shaOf(0xbbb))
  assert.deepEqual([judge().ruleId, judge().reason], ['g15.approve', expected])
  assert.ok(!expected.includes(TOKEN))
})
