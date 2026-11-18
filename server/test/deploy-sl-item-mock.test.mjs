// HO-901, mock path (FARM_URL unset — demo mode and the e2e suite), driven
// through the orchestrator. An sl Task-backed item has a null issue, like a
// local demo item, but its Deploy never takes the demo item's "release
// skipped" summary: it fails by name. A local demo item, and a GitHub item
// with a repo but no issue, keep exactly today's summaries and make no GitHub
// call. Every outbound fetch is recorded.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectReadyRepo } from './helpers/readyRepo.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-sl-mock-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-sl-mock-home-'))
process.env.MOCK_STEP_LATENCY_MS = '5'
process.env.MOCK_REVIEW_FAIL_COUNT = '0'
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { IMPLEMENT_STEP_INDEX, DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const calls = []
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || 'GET' })
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
}
const githubCalls = (since) => calls.slice(since).filter((c) => c.url.includes('github.com'))

const projectId = store.createProject('HO-901 mock').id
const SL_REPO = 'acme/sl-mock'
const GH_REPO = 'acme/gh-mock'
assert.equal(store.addRepoToProject(projectId, SL_REPO, 'sl').ok, true)
assert.equal(store.addRepoToProject(projectId, GH_REPO).ok, true)
connectReadyRepo(db, SL_REPO, { unrunnableTarget: true })
connectReadyRepo(db, GH_REPO, { unrunnableTarget: true })

const RELEASE_SKIPPED = 'deployed to the target environment; smoke checks passed (no GitHub — release skipped)'
const PR_SKIPPED = 'implementation complete on a feature branch; all checks green (no GitHub — PR skipped)'

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
const runsAt = (id, step) => db.prepare('SELECT status, output FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id').all(id, step)
const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)

// Kicks `id` and waits until its run at `step` has ended.
async function runStep(id, step) {
  orchestrator.kick(id)
  for (let i = 0; i < 300; i++) {
    const runs = runsAt(id, step)
    if (runs.length > 0 && runs.every((r) => r.status !== 'active')) break
    await new Promise((r) => setTimeout(r, 10))
  }
  return runsAt(id, step)
}

test('metric 2: through the mock orchestrator, an sl item at Deploy fails by name and never reads "release skipped"', async () => {
  // HO-875's own insert path: store.recordTask (issue NULL, task_id, backend sl).
  const recorded = store.recordTask({ number: 7, title: 'Ship it', body: '', labels: [], state: 'open' }, SL_REPO)
  assert.equal(recorded?.created, true)
  const id = recorded.id
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(DEPLOY_STEP_INDEX, id)
  assert.equal(store.getItem(id).issue, null)

  const since = calls.length
  const runs = await runStep(id, DEPLOY_STEP_INDEX)
  orchestrator.cancel(id)

  assert.equal(runs.length, 1)
  assert.match(runs[0].output, /^FAILED: deploy_unsupported/)
  assert.ok(runs[0].output.includes(id), runs[0].output)
  assert.equal(store.getItem(id).cursor, DEPLOY_STEP_INDEX, 'the cursor stays at Deploy')
  assert.equal(store.getItem(id).release_tag, null)
  assert.ok(!events(id).some((t) => /release skipped/.test(t)), JSON.stringify(events(id)))
  assert.ok(!runsAt(id, DEPLOY_STEP_INDEX).some((r) => /release skipped/.test(r.output ?? '')))
  assert.deepEqual(githubCalls(since), [])
})

test("metric 4: a local demo item runs Implement and Deploy with today's exact summaries, no PR, no release, no GitHub call", async () => {
  insertItem.run('DM-1', 'Demo', 'Medium', IMPLEMENT_STEP_INDEX, null, null, null)
  const since = calls.length

  const implement = await runStep('DM-1', IMPLEMENT_STEP_INDEX)
  orchestrator.cancel('DM-1')
  assert.deepEqual(implement, [{ status: 'done', output: PR_SKIPPED }])

  db.prepare('UPDATE work_item SET cursor = ?, paused = 0 WHERE id = ?').run(DEPLOY_STEP_INDEX, 'DM-1')
  const deploy = await runStep('DM-1', DEPLOY_STEP_INDEX)
  orchestrator.cancel('DM-1')
  assert.deepEqual(deploy, [{ status: 'done', output: RELEASE_SKIPPED }])

  const item = store.getItem('DM-1')
  assert.equal(item.pr, null)
  assert.equal(item.release_tag, null)
  assert.deepEqual(githubCalls(since), [])
})

test('guardrail 1: a GitHub item with a repo but no issue keeps the release-skipped summary at Deploy', async () => {
  insertItem.run('GN-1', 'No issue', 'Medium', DEPLOY_STEP_INDEX, GH_REPO, null, projectId)
  const since = calls.length
  const deploy = await runStep('GN-1', DEPLOY_STEP_INDEX)
  orchestrator.cancel('GN-1')
  assert.deepEqual(deploy, [{ status: 'done', output: RELEASE_SKIPPED }])
  assert.equal(store.getItem('GN-1').release_tag, null)
  assert.deepEqual(githubCalls(since), [])
})
