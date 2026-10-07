// HZ-333: with no farm (FARM_URL unset — demo mode and the e2e suite) step 14
// never joins the deploy queue; the mock Deploy step publishes its per-item
// release exactly as before.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'
import { deployQueueStub, shaOf } from './helpers/deployQueueStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-mock-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-mock-home-'))
process.env.MOCK_STEP_LATENCY_MS = '5'
delete process.env.FARM_URL

await useDeployTargetRows([{ key: 'horizon', repo: 'FinTekkers/horizon', stateKey: 'horizon' }])

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

test('mock mode: step 14 never queues and the mock deploy publishes its own release', async () => {
  const stub = deployQueueStub()
  globalThis.fetch = stub.fetch
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'MQ-1',
    'Mock deploy',
    'Medium',
    DEPLOY_STEP_INDEX,
    'FinTekkers/horizon',
    1,
    1,
  )
  stub.prs.set('FinTekkers/horizon#1', shaOf(1))
  orchestrator.kick('MQ-1')
  for (let i = 0; i < 200 && store.getItem('MQ-1').cursor === DEPLOY_STEP_INDEX; i++) await new Promise((r) => setTimeout(r, 10))

  assert.equal(store.getItem('MQ-1').cursor, DEPLOY_STEP_INDEX + 1)
  assert.equal(stub.posts.length, 1)
  assert.equal(stub.posts[0].tag_name, 'deploy-mq-1')
  assert.equal(store.getItem('MQ-1').release_tag, 'deploy-mq-1')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deploy_queue_entry').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deploy_batch').get().n, 0)
  // join()'s one GitHub call, the PR's merge commit, never happened.
  assert.ok(!stub.requests.some((r) => r.path.endsWith('/pulls/1')))
})
