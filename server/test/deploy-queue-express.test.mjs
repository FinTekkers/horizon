// HZ-469 metric 3: a batch whose member an open item depends on releases on
// the next tick instead of waiting out its window. Without such a dependent,
// or when the dependent is closed or abandoned, the window is kept.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'
import { addComingItem, deployQueueStub, shaOf } from './helpers/deployQueueStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-express-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-express-home-'))
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
process.env.HORIZON_DEPLOY_BATCH_S = '900'

await useDeployTargetRows([{ key: 'horizon', repo: 'FinTekkers/horizon', stateKey: 'horizon' }])

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { DEPLOY_STEP_INDEX, endIndex } = await import('../../domain/js/lifecycle.js')
const { DEPLOY_BATCH_S } = await import('../src/config.js')
const deployQueue = await import('../src/deployQueue.js')
const { sqlTime } = deployQueue

store.purgeDemoItems()
const stub = deployQueueStub()
globalThis.fetch = stub.fetch

const REPO = 'FinTekkers/horizon'
// Whole seconds, as sqlTime() stores them, so the window maths is exact.
const T0 = Math.floor(Date.now() / 1000) * 1000

beforeEach(() => {
  for (const table of ['deploy_queue_entry', 'deploy_batch', 'work_item_dependency', 'event', 'work_item']) db.prepare(`DELETE FROM ${table}`).run()
  stub.posts.length = 0
})

function addItem(id, cursor, n = null) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, id, 'Medium', cursor, REPO, n, n)
}

// One open batch (window closes DEPLOY_BATCH_S after T0) holding EX-1, queued.
function openBatchWithMember() {
  addItem('EX-1', DEPLOY_STEP_INDEX, 1)
  stub.prs.set(`${REPO}#1`, shaOf(1))
  const closes = sqlTime(T0 + DEPLOY_BATCH_S * 1000)
  const batchId = db
    .prepare("INSERT INTO deploy_batch (target, repo, window_closes_at, created_at) VALUES ('horizon', ?, ?, ?)")
    .run(REPO, closes, sqlTime(T0)).lastInsertRowid
  db.prepare("INSERT INTO deploy_queue_entry (item_id, target, merge_sha, batch_id, joined_at) VALUES ('EX-1', 'horizon', ?, ?, ?)").run(
    shaOf(1),
    batchId,
    sqlTime(T0),
  )
  return { batchId, closes }
}

const batch = (id) => db.prepare('SELECT * FROM deploy_batch WHERE id = ?').get(id)

test('an open item depending on a queued member closes the window: the batch starts in the same tick', async () => {
  const { batchId } = openBatchWithMember()
  addItem('EX-2', 4)
  db.prepare("INSERT INTO work_item_dependency (item_id, depends_on_id) VALUES ('EX-2', 'EX-1')").run()

  const now = T0 + 60_000
  await deployQueue.tick(now)

  const after = batch(batchId)
  assert.notEqual(after.status, 'open', 'the batch left open in this tick')
  assert.equal(after.started_at, sqlTime(now))
  assert.equal(after.window_closes_at, sqlTime(now))
  assert.equal(stub.posts.length, 1, 'one release published')
  const event = db.prepare("SELECT text FROM event WHERE item_id = 'EX-1' AND text LIKE 'deploy window closed early%'").get()
  assert.match(event.text, /EX-2 is waiting on it/)
  assert.match(event.text, new RegExp(sqlTime(T0 + DEPLOY_BATCH_S * 1000)))
})

test('with no dependent the window stays the full DEPLOY_BATCH_S', async () => {
  const { batchId, closes } = openBatchWithMember()
  addItem('EX-3', 4)
  addComingItem(db, REPO) // HZ-591: another merge is coming

  await deployQueue.tick(T0 + 60_000)
  assert.equal(batch(batchId).status, 'open')
  assert.equal(batch(batchId).window_closes_at, closes)
  await deployQueue.tick(T0 + DEPLOY_BATCH_S * 1000 - 1000)
  assert.equal(batch(batchId).status, 'open')
  assert.equal(stub.posts.length, 0)

  await deployQueue.tick(T0 + DEPLOY_BATCH_S * 1000)
  assert.notEqual(batch(batchId).status, 'open', 'released once the window closes')
})

for (const [label, setup] of [
  ['closed', (id) => db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(endIndex(), id)],
  ['abandoned', (id) => db.prepare("UPDATE work_item SET abandoned_at = datetime('now') WHERE id = ?").run(id)],
]) {
  test(`a dependent that is ${label} keeps the window`, async () => {
    const { batchId, closes } = openBatchWithMember()
    addItem('EX-4', 4)
    addComingItem(db, REPO) // HZ-591: another merge is coming
    db.prepare("INSERT INTO work_item_dependency (item_id, depends_on_id) VALUES ('EX-4', 'EX-1')").run()
    setup('EX-4')

    await deployQueue.tick(T0 + 60_000)
    assert.equal(batch(batchId).status, 'open')
    assert.equal(batch(batchId).window_closes_at, closes)
    assert.equal(stub.posts.length, 0)
  })
}

test('a dependency added mid-window releases the batch on the very next tick', async () => {
  const { batchId } = openBatchWithMember()
  addItem('EX-5', 4)
  addComingItem(db, REPO) // HZ-591: another merge is coming
  const now = T0 + 120_000

  await deployQueue.tick(now)
  assert.equal(batch(batchId).status, 'open')

  db.prepare("INSERT INTO work_item_dependency (item_id, depends_on_id) VALUES ('EX-5', 'EX-1')").run()
  await deployQueue.tick(now)
  assert.notEqual(batch(batchId).status, 'open', 'released on the next tick, with no time passing')
  assert.equal(stub.posts.length, 1)
})
