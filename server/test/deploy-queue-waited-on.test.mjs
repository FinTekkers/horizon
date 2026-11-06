// HZ-783: a batch whose member an open item waits on (HZ-469) still takes in
// merges already at Accept the code or in premerge (HZ-591's check), but its
// window closes at most DEPLOY_WAITED_ON_CAP_S (default 10 min) after the
// dependent is first seen. Nothing coming, or a failing check, closes it at
// once, as before. start() still waits on jobBlocksDeploy.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'
import { addComingItem, deployQueueStub, shaOf } from './helpers/deployQueueStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-waited-on-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-waited-on-home-'))
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
// The defaults: a 900 s window and a 600 s cap, so the cap shortens it.
delete process.env.HORIZON_DEPLOY_BATCH_S
delete process.env.HORIZON_DEPLOY_WAITED_ON_CAP_S

await useDeployTargetRows([{ key: 'horizon', repo: 'FinTekkers/horizon', stateKey: 'horizon' }])

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { ACCEPT_GATE_INDEX, DEPLOY_STEP_INDEX, EXECUTE_STEP_INDEX, STEPS } = await import('../../domain/js/lifecycle.js')
const { DEPLOY_WAITED_ON_CAP_S } = await import('../src/config.js')
const deployQueue = await import('../src/deployQueue.js')
const { sqlTime, TICK_MS } = deployQueue

store.purgeDemoItems()
const stub = deployQueueStub()
globalThis.fetch = stub.fetch

const REPO = 'FinTekkers/horizon'
// Whole seconds, as sqlTime() stores them, so the window maths is exact.
const T0 = Math.floor(Date.now() / 1000) * 1000
// The dependent is first seen on the first tick after the join.
const S = T0 + TICK_MS
const CAP_MS = 600_000

beforeEach(() => {
  for (const table of ['deploy_queue_entry', 'deploy_batch', 'work_item_dependency', 'gate_action', 'step_run', 'event', 'work_item']) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
  stub.posts.length = 0
})

afterEach(() => deployQueue.setComingToDeployCheck(null))

function addItem(id, cursor, n = null) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, id, 'Medium', cursor, REPO, n, n)
}

function dependsOn(id, on) {
  db.prepare('INSERT INTO work_item_dependency (item_id, depends_on_id) VALUES (?, ?)').run(id, on)
}

function runningPremerge(id) {
  db.prepare(
    "INSERT INTO gate_action (item_id, kind, state, run_token, epoch, started_at, deadline_at) VALUES (?, 'premerge', 'running', 'tok', 'ep', ?, ?)",
  ).run(id, sqlTime(T0), sqlTime(T0 + 3_600_000))
}

async function joinQueue(id, n, now) {
  stub.prs.set(`${REPO}#${n}`, shaOf(n))
  const joined = await deployQueue.join({ id, repo: REPO, issue: n, pr: n }, now)
  assert.ok(joined, `${id} joined`)
  return joined.id
}

// WO-1 joins at T0, and WO-DEP (open, at step 4) depends on it.
async function waitedOnBatch() {
  addItem('WO-1', DEPLOY_STEP_INDEX, 1)
  const batchId = await joinQueue('WO-1', 1, T0)
  addItem('WO-DEP', 4)
  dependsOn('WO-DEP', 'WO-1')
  return batchId
}

const batch = (id) => db.prepare('SELECT * FROM deploy_batch WHERE id = ?').get(id)
const heldEvents = (id) => db.prepare("SELECT text FROM event WHERE item_id = ? AND text LIKE 'deploy window held%'").all(id)
const earlyEvents = (id) => db.prepare("SELECT text FROM event WHERE item_id = ? AND text LIKE 'deploy window closed early%'").all(id)

test('the cap defaults to 10 minutes', () => {
  assert.equal(DEPLOY_WAITED_ON_CAP_S, 600)
})

test('metric 1: a merge in its premerge check joins the held batch, and both ship in one batch and one release', async () => {
  addItem('WO-COMING', 4)
  runningPremerge('WO-COMING')
  const batchId = await waitedOnBatch()

  await deployQueue.tick(S)
  assert.equal(batch(batchId).status, 'open', 'held for the merge in premerge')
  assert.equal(batch(batchId).window_closes_at, sqlTime(S + CAP_MS))
  assert.equal(stub.posts.length, 0)

  // The premerge passes and the item merges and joins the same batch.
  db.prepare('UPDATE work_item SET cursor = ?, issue = 2, pr = 2 WHERE id = ?').run(DEPLOY_STEP_INDEX, 'WO-COMING')
  assert.equal(await joinQueue('WO-COMING', 2, S + 20_000), batchId)

  await deployQueue.tick(S + 25_000)
  assert.notEqual(batch(batchId).status, 'open', 'closed once the merge landed')
  const batchIds = db.prepare("SELECT DISTINCT batch_id FROM deploy_queue_entry WHERE item_id IN ('WO-1', 'WO-COMING')").all()
  assert.deepEqual(batchIds, [{ batch_id: batchId }])
  assert.equal(stub.posts.length, 1, 'one release for both')
  assert.match(earlyEvents('WO-1')[0].text, /WO-DEP is waiting on it/)
})

test('metric 2: with nothing at Accept the code or in premerge the window closes at once, as today', async () => {
  const batchId = await waitedOnBatch()

  await deployQueue.tick(S)
  const after = batch(batchId)
  assert.notEqual(after.status, 'open')
  assert.equal(after.window_closes_at, sqlTime(S))
  assert.equal(stub.posts.length, 1)
  const events = earlyEvents('WO-1')
  assert.equal(events.length, 1)
  assert.match(events[0].text, /WO-DEP is waiting on it/)
  assert.equal(heldEvents('WO-1').length, 0)
})

test('metric 2: the dependent itself at Accept the code does not hold its own batch', async () => {
  const batchId = await waitedOnBatch()
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(ACCEPT_GATE_INDEX, 'WO-DEP')

  await deployQueue.tick(S)
  assert.notEqual(batch(batchId).status, 'open')
  assert.equal(stub.posts.length, 1)
  assert.match(earlyEvents('WO-1')[0].text, /WO-DEP is waiting on it/)
  assert.equal(heldEvents('WO-1').length, 0)
})

test('metric 3 / guardrail 4: a merge that never lands holds the window to the cap from the dependent being seen, never extended', async () => {
  addComingItem(db, REPO, 'WO-STUCK')
  const batchId = await waitedOnBatch()

  for (const now of [S, S + 60_000, S + 300_000, S + CAP_MS - 1000]) {
    // A second merge reaching Accept the code later must not extend the cap.
    if (now === S + 300_000) addComingItem(db, REPO, 'WO-LATE')
    await deployQueue.tick(now)
    assert.equal(batch(batchId).status, 'open', `open at S + ${now - S}ms`)
    assert.equal(batch(batchId).window_closes_at, sqlTime(S + CAP_MS))
  }
  assert.equal(stub.posts.length, 0)
  assert.equal(earlyEvents('WO-1').length, 0, 'no early close before the cap')
  const held = heldEvents('WO-1')
  assert.equal(held.length, 1, 'one hold event, not one per tick')
  assert.match(held[0].text, /WO-STUCK's merge/)
  assert.match(held[0].text, /WO-DEP is waiting on it/)
  assert.match(held[0].text, new RegExp(`closes by ${sqlTime(S + CAP_MS)} UTC at the latest \\(10-minute cap\\)`))

  await deployQueue.tick(S + CAP_MS)
  assert.notEqual(batch(batchId).status, 'open', 'closed at the cap')
  assert.equal(batch(batchId).started_at, sqlTime(S + CAP_MS))
  assert.equal(stub.posts.length, 1)
})

test('metric 5 / guardrail 2: a failing coming-to-deploy check closes the window at once with no hold, and warns', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  deployQueue.setComingToDeployCheck(() => {
    throw new Error('boom')
  })
  addComingItem(db, REPO, 'WO-STUCK')
  const batchId = await waitedOnBatch()

  await deployQueue.tick(S)
  assert.notEqual(batch(batchId).status, 'open')
  assert.equal(stub.posts.length, 1)
  assert.equal(heldEvents('WO-1').length, 0)
  assert.match(earlyEvents('WO-1')[0].text, /WO-DEP is waiting on it/)
  assert.ok(warn.mock.calls.some((c) => /coming-to-deploy check failed: boom/.test(String(c.arguments[0]))))
})

test('guardrail 3: a job running at the cap keeps the batch open until it ends, then it releases once', async () => {
  addComingItem(db, REPO, 'WO-STUCK')
  const batchId = await waitedOnBatch()
  await deployQueue.tick(S)
  assert.equal(batch(batchId).window_closes_at, sqlTime(S + CAP_MS))

  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, repo) VALUES ('WO-JOB', 'job', 'High', ?, 'task', ?)").run(EXECUTE_STEP_INDEX, REPO)
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, started_at) VALUES ('WO-JOB', ?, 1, ?, 'active', ?)")
    .run(EXECUTE_STEP_INDEX, STEPS[EXECUTE_STEP_INDEX].agent, sqlTime(S)).lastInsertRowid

  await deployQueue.tick(S + CAP_MS)
  await deployQueue.tick(S + CAP_MS + TICK_MS)
  assert.equal(batch(batchId).status, 'open', 'held while the job runs')
  assert.equal(stub.posts.length, 0)

  db.prepare("UPDATE step_run SET status = 'done', ended_at = datetime('now') WHERE id = ?").run(runId)
  await deployQueue.tick(S + CAP_MS + 2 * TICK_MS)
  assert.notEqual(batch(batchId).status, 'open')
  assert.equal(stub.posts.length, 1)
  await deployQueue.tick(S + CAP_MS + 3 * TICK_MS)
  assert.equal(stub.posts.length, 1, 'released once')
})

// Only on HZ-783's own branch: later items may change the release path.
test('guardrail 1: the release path (tags, deploy scripts, webhook) is untouched by this branch', (t) => {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  let changed
  try {
    if (git('rev-parse', '--abbrev-ref', 'HEAD').trim() !== 'horizon/hz-783') {
      t.skip('not the HZ-783 branch')
      return
    }
    changed = git('diff', '--name-only', 'origin/main...HEAD')
  } catch {
    t.skip('no git checkout with origin/main')
    return
  }
  const touched = changed.split('\n').filter((f) => f === 'server/src/deploy.js' || f === 'server/src/app.js' || /^infra\/host\/.*\.sh$/.test(f))
  assert.deepEqual(touched, [])
})
