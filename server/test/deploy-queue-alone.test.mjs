// HZ-591: a batch with no other item in its repo at Accept the code or in its
// premerge check deploys on the next tick instead of waiting out its window.
// With one coming, the window keeps DEPLOY_BATCH_S. HZ-469's dependency close
// still fires first, a running job still holds start(), and a failing check
// keeps the window.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'
import { addComingItem, deployQueueStub, shaOf } from './helpers/deployQueueStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-alone-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-alone-home-'))
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
// The default window (900 s), so guardrail 3 checks the default itself.
delete process.env.HORIZON_DEPLOY_BATCH_S

await useDeployTargetRows([{ key: 'horizon', repo: 'FinTekkers/horizon', stateKey: 'horizon' }])

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { DEPLOY_STEP_INDEX, EXECUTE_STEP_INDEX, STEPS } = await import('../../domain/js/lifecycle.js')
const { DEPLOY_BATCH_S } = await import('../src/config.js')
const deployQueue = await import('../src/deployQueue.js')
const { sqlTime, TICK_MS } = deployQueue

store.purgeDemoItems()
const stub = deployQueueStub()
globalThis.fetch = stub.fetch

const REPO = 'FinTekkers/horizon'
// Whole seconds, as sqlTime() stores them, so the window maths is exact.
const T0 = Math.floor(Date.now() / 1000) * 1000
const DUE = T0 + DEPLOY_BATCH_S * 1000

beforeEach(() => {
  for (const table of ['deploy_queue_entry', 'deploy_batch', 'work_item_dependency', 'gate_action', 'step_run', 'event', 'work_item']) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
  stub.posts.length = 0
})

afterEach(() => deployQueue.setComingToDeployCheck(null))

function addItem(id, cursor, n = null, repo = REPO) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, id, 'Medium', cursor, repo, n, n)
}

function runningPremerge(id) {
  db.prepare(
    "INSERT INTO gate_action (item_id, kind, state, run_token, epoch, started_at, deadline_at) VALUES (?, 'premerge', 'running', 'tok', 'ep', ?, ?)",
  ).run(id, sqlTime(T0), sqlTime(T0 + 3_600_000))
}

// AL-1 joins its target's queue at T0 through join(), so the batch's window is
// the one join() sets.
async function joinFirst(id = 'AL-1', n = 1) {
  addItem(id, DEPLOY_STEP_INDEX, n)
  stub.prs.set(`${REPO}#${n}`, shaOf(n))
  const joined = await deployQueue.join({ id, repo: REPO, issue: n, pr: n }, T0)
  assert.ok(joined, `${id} joined`)
  return joined.id
}

const batch = (id) => db.prepare('SELECT * FROM deploy_batch WHERE id = ?').get(id)
const earlyEvents = (id) => db.prepare("SELECT text FROM event WHERE item_id = ? AND text LIKE 'deploy window closed early%'").all(id)
const notComing = new RegExp(`no other ${REPO} merge is coming`)

test('metric 1: a lone merge closes its window and starts its deploy on the next tick, with one event naming the old close time', async () => {
  const batchId = await joinFirst()
  assert.equal(batch(batchId).window_closes_at, sqlTime(DUE))

  const now = T0 + TICK_MS
  await deployQueue.tick(now)
  const after = batch(batchId)
  assert.notEqual(after.status, 'open', 'the batch started in this tick')
  assert.equal(after.window_closes_at, sqlTime(now))
  assert.equal(after.started_at, after.window_closes_at)
  assert.equal(stub.posts.length, 1, 'one release published')
  const events = earlyEvents('AL-1')
  assert.equal(events.length, 1)
  assert.match(events[0].text, notComing)
  assert.match(events[0].text, new RegExp(`it was due to close ${sqlTime(DUE)} UTC`))

  await deployQueue.tick(now + TICK_MS)
  await deployQueue.tick(now + 2 * TICK_MS)
  assert.equal(earlyEvents('AL-1').length, 1, 'no second event')
  assert.equal(stub.posts.length, 1)
})

test('metric 1: an abandoned item still at Accept the code does not hold the window', async () => {
  addComingItem(db, REPO, 'AL-GONE')
  db.prepare("UPDATE work_item SET abandoned_at = datetime('now') WHERE id = 'AL-GONE'").run()
  const batchId = await joinFirst()

  await deployQueue.tick(T0 + TICK_MS)
  assert.notEqual(batch(batchId).status, 'open')
  assert.equal(stub.posts.length, 1)
})

test("metric 1: the member's own premerge row still reading running does not hold its window", async () => {
  const batchId = await joinFirst()
  runningPremerge('AL-1')

  await deployQueue.tick(T0 + TICK_MS)
  assert.notEqual(batch(batchId).status, 'open')
  assert.equal(stub.posts.length, 1)
})

test('metric 2: with another item at Accept the code the window stays open, then both merges deploy in one batch', async () => {
  addComingItem(db, REPO, 'AL-ACCEPT')
  const batchId = await joinFirst()

  for (const now of [T0 + TICK_MS, T0 + 60_000, DUE - 1]) {
    await deployQueue.tick(now)
    assert.equal(batch(batchId).status, 'open', `open at ${now - T0}ms`)
    assert.equal(batch(batchId).window_closes_at, sqlTime(DUE))
  }
  assert.equal(earlyEvents('AL-1').length, 0)

  // The item at Accept merges and joins the same batch.
  db.prepare('UPDATE work_item SET cursor = ?, issue = 2, pr = 2 WHERE id = ?').run(DEPLOY_STEP_INDEX, 'AL-ACCEPT')
  stub.prs.set(`${REPO}#2`, shaOf(2))
  const second = await deployQueue.join({ id: 'AL-ACCEPT', repo: REPO, issue: 2, pr: 2 }, T0 + 120_000)
  assert.equal(second.id, batchId)

  await deployQueue.tick(DUE)
  assert.notEqual(batch(batchId).status, 'open')
  const batchIds = db.prepare("SELECT DISTINCT batch_id FROM deploy_queue_entry WHERE item_id IN ('AL-1', 'AL-ACCEPT')").all()
  assert.deepEqual(batchIds, [{ batch_id: batchId }])
  assert.equal(stub.posts.length, 1, 'one release for both')
  assert.equal(earlyEvents('AL-ACCEPT').length, 0)
})

test('metric 3 (artificial fixture: a running premerge on an item not at Accept the code): the window stays open until it closes', async () => {
  addItem('AL-PRE', 4)
  runningPremerge('AL-PRE')
  const batchId = await joinFirst()

  await deployQueue.tick(T0 + TICK_MS)
  await deployQueue.tick(DUE - 1)
  assert.equal(batch(batchId).status, 'open')
  assert.equal(batch(batchId).window_closes_at, sqlTime(DUE))
  assert.equal(stub.posts.length, 0)

  await deployQueue.tick(DUE)
  assert.notEqual(batch(batchId).status, 'open')
  assert.equal(stub.posts.length, 1)
})

test('metric 4: an item at Accept the code in another repo does not hold the window', async () => {
  addComingItem(db, 'FinTekkers/ui-service', 'AL-UI')
  const batchId = await joinFirst()

  await deployQueue.tick(T0 + TICK_MS)
  assert.notEqual(batch(batchId).status, 'open')
  assert.equal(stub.posts.length, 1)
})

test('metric 5: with an item at Accept the code and an open dependent, only the dependency close is logged', async () => {
  addComingItem(db, REPO, 'AL-ACCEPT')
  const batchId = await joinFirst()
  addItem('AL-DEP', 4)
  db.prepare("INSERT INTO work_item_dependency (item_id, depends_on_id) VALUES ('AL-DEP', 'AL-1')").run()

  await deployQueue.tick(T0 + TICK_MS)
  assert.notEqual(batch(batchId).status, 'open')
  const events = earlyEvents('AL-1')
  assert.equal(events.length, 1)
  assert.match(events[0].text, /AL-DEP is waiting on it/)
  assert.doesNotMatch(events[0].text, notComing)
})

test('guardrail 1: a lone merge with a running job in the repo moves its close time but starts only once the job ends', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, repo) VALUES ('AL-JOB', 'job', 'High', ?, 'task', ?)").run(EXECUTE_STEP_INDEX, REPO)
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, started_at) VALUES ('AL-JOB', ?, 1, ?, 'active', ?)")
    .run(EXECUTE_STEP_INDEX, STEPS[EXECUTE_STEP_INDEX].agent, sqlTime(T0)).lastInsertRowid
  const batchId = await joinFirst()

  const now = T0 + TICK_MS
  await deployQueue.tick(now)
  assert.equal(batch(batchId).window_closes_at, sqlTime(now))
  assert.equal(batch(batchId).status, 'open', 'held while the job runs')
  await deployQueue.tick(now + TICK_MS)
  assert.equal(batch(batchId).status, 'open')
  assert.equal(stub.posts.length, 0)

  db.prepare("UPDATE step_run SET status = 'done', ended_at = datetime('now') WHERE id = ?").run(runId)
  await deployQueue.tick(now + 2 * TICK_MS)
  assert.notEqual(batch(batchId).status, 'open')
  assert.equal(stub.posts.length, 1)
})

test('guardrail 1: a failing coming-to-deploy check does not stop the dependency close', async (t) => {
  t.mock.method(console, 'warn', () => {})
  deployQueue.setComingToDeployCheck(() => {
    throw new Error('boom')
  })
  const batchId = await joinFirst()
  addItem('AL-DEP', 4)
  db.prepare("INSERT INTO work_item_dependency (item_id, depends_on_id) VALUES ('AL-DEP', 'AL-1')").run()

  await deployQueue.tick(T0 + TICK_MS)
  assert.notEqual(batch(batchId).status, 'open')
  assert.match(earlyEvents('AL-1')[0].text, /AL-DEP is waiting on it/)
})

test('guardrail 2: a failing coming-to-deploy check keeps the window, warns, and the batch starts when it closes', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  deployQueue.setComingToDeployCheck(() => {
    throw new Error('boom')
  })
  const batchId = await joinFirst()

  await deployQueue.tick(T0 + TICK_MS)
  assert.equal(batch(batchId).status, 'open')
  assert.equal(batch(batchId).window_closes_at, sqlTime(DUE))
  assert.ok(warn.mock.calls.some((c) => /coming-to-deploy check failed: boom/.test(String(c.arguments[0]))))
  assert.equal(earlyEvents('AL-1').length, 0)

  await deployQueue.tick(DUE)
  assert.notEqual(batch(batchId).status, 'open')
  assert.equal(batch(batchId).started_at, sqlTime(DUE))
})

test('guardrail 3: with another item at Accept the code the window is the full DEPLOY_BATCH_S from the join', async () => {
  addComingItem(db, REPO, 'AL-ACCEPT')
  const batchId = await joinFirst()
  await deployQueue.tick(T0 + TICK_MS)
  assert.equal(batch(batchId).window_closes_at, sqlTime(T0 + DEPLOY_BATCH_S * 1000))
  assert.equal(DEPLOY_BATCH_S, 900, 'the 15-minute default')
})
