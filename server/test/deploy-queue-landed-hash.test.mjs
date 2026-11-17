// HO-872 guardrail 3: the deploy queue reads a GitHub item's deploy commit
// from its PR's merge commit (getPrMergeSha, through the Review port) and never
// from work_item.landed_hash. The item here has a landed_hash that differs
// from the PR's merge_commit_sha; the queue entry and the ancestry check
// carry the merge commit only.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-landed-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-queue-landed-home-'))
process.env.GITHUB_TOKEN = 'ghp_fake_deploy_queue_landed_hash'
for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const REPO = 'FinTekkers/horizon'
await useDeployTargetRows([{ key: 'horizon', repo: REPO, stateKey: 'horizon', script: 'h.sh', service: 'horizon-test' }])

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const deployQueue = await import('../src/deployQueue.js')
const { DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const LANDED = 'c'.repeat(40)
const MERGE = 'd'.repeat(40)
const PR = 301

const calls = []
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url))
  calls.push(`${opts.method || 'GET'} ${u.pathname}`)
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (u.pathname === `/repos/${REPO}/pulls/${PR}`) return json(200, { number: PR, merged: true, merge_commit_sha: MERGE })
  return json(404, {})
}

test('guardrail 3: an item with a landed_hash queues its PR merge commit, not the landed hash', async () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, pr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'DQL-1',
    'Deploy sha source',
    'Medium',
    DEPLOY_STEP_INDEX,
    REPO,
    1,
    PR,
  )
  assert.equal(store.markLanded('DQL-1', LANDED), true)
  const batch = await deployQueue.join(store.getItem('DQL-1'))
  assert.ok(batch, 'the item joined a batch')
  const entry = db.prepare('SELECT merge_sha FROM deploy_queue_entry WHERE item_id = ?').get('DQL-1')
  assert.equal(entry.merge_sha, MERGE)
  assert.deepEqual(calls, [`GET /repos/${REPO}/pulls/${PR}`])
  assert.ok(!calls.some((c) => c.includes(LANDED)), 'no request names the landed hash')
})

test('guardrail 3: deployQueue.js never mentions landed_hash', () => {
  const source = readFileSync(new URL('../src/deployQueue.js', import.meta.url), 'utf8')
  assert.ok(source.length > 1000, 'read the real deployQueue.js')
  assert.doesNotMatch(source, /landed_hash/)
})
