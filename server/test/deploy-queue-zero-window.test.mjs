// HZ-333 metric 2: HORIZON_DEPLOY_BATCH_S=0 means no window — the batch
// publishes on the next tick after the first join, still once for all items.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'
import { deployQueueStub, shaOf } from './helpers/deployQueueStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-zero-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-zero-home-'))
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
process.env.HORIZON_DEPLOY_BATCH_S = '0'

await useDeployTargetRows([{ key: 'horizon', repo: 'FinTekkers/horizon', stateKey: 'horizon' }])

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { DEPLOY_BATCH_S } = await import('../src/config.js')
const orchestrator = await import('../src/orchestrator.js')
const deployQueue = await import('../src/deployQueue.js')

store.purgeDemoItems()
const stub = deployQueueStub()
globalThis.fetch = stub.fetch

after(() => {
  for (const id of ['DZ-1', 'DZ-2']) orchestrator.cancel(id)
})

test('a window of 0 publishes one release on the next tick', async () => {
  assert.equal(DEPLOY_BATCH_S, 0)
  for (const [i, id] of ['DZ-1', 'DZ-2'].entries()) {
    db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      id,
      'Medium',
      DEPLOY_STEP_INDEX,
      'FinTekkers/horizon',
      i + 1,
      i + 1,
    )
    stub.prs.set(`FinTekkers/horizon#${i + 1}`, shaOf(i + 1))
    orchestrator.kick(id)
  }
  for (let i = 0; i < 100 && db.prepare('SELECT COUNT(*) AS n FROM deploy_queue_entry').get().n < 2; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.equal(stub.posts.length, 0)
  await deployQueue.tick(Date.now() + 1000)
  assert.equal(stub.posts.length, 1)
  assert.equal(db.prepare("SELECT status FROM deploy_batch").get().status, 'deploying')
  await deployQueue.tick(Date.now() + 2000)
  assert.equal(stub.posts.length, 1)
})
