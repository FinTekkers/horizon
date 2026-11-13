// HZ-709 metric 3: farm step requests and results carry the step key. The
// request half drives the real orchestrator dispatch against a stub farmd and
// checks the /steps/run body against domain/fixtures/step-dispatch.json — the
// same fixture farm/tests/test_farmd_step_keys.py feeds farmd with a wrong
// index. The result half drives the real completeFarmRun / failFarmRun /
// blockFarmRun: a result naming the run's own step is recorded, one naming
// another step changes nothing, and one with no key (a farm from before keys)
// is recorded as before.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-farm-step-key-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.GITHUB_TOKEN

const dispatches = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('http://farm.test')) return realFetch(url, opts)
  if (String(url).endsWith('/steps/run')) dispatches.push(JSON.parse(opts.body))
  if (String(url).includes('/runs/status')) return { ok: true, json: async () => ({ states: {} }) }
  if (String(url).includes('/preflight') || (typeof u !== 'undefined' && String(u).includes('/preflight'))) return { ok: true, json: async () => ({ ok: true, failed: [], unmet: [], elapsed_ms: 0 }) }
  return { ok: true, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { STEPS, stepIndexOf, stepKeyAt } = await import('../../domain/js/lifecycle.js')
const { connectReadyRepo } = await import('./helpers/readyRepo.mjs')

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {}, error: () => {} })
after(() => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

const FIXTURE = JSON.parse(readFileSync(join(REPO_ROOT, 'domain/fixtures/step-dispatch.json'), 'utf8'))
connectReadyRepo(db, FIXTURE.item.repo)
const projectId = db.prepare('SELECT project_id FROM project_repo WHERE repo = ?').get(FIXTURE.item.repo).project_id
db.prepare('UPDATE project SET enabled = 1 WHERE id = ?').run(projectId)

function insertItem(id, stepKey) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, repo, kind) VALUES (?, ?, 'Medium', ?, ?, ?, ?)").run(
    id,
    id,
    stepIndexOf(stepKey),
    projectId,
    FIXTURE.item.repo,
    FIXTURE.item.kind,
  )
}
function insertRun(id, stepKey) {
  const index = stepIndexOf(stepKey)
  return Number(
    db.prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)').run(id, index, STEPS[index].agent ?? 'PM')
      .lastInsertRowid,
  )
}
const runStatus = (runId) => db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor

test('a step request names its step by key, as the shared fixture does, beside its current index', async () => {
  insertItem('FK-DISPATCH', FIXTURE.step.key)
  orchestrator.kick('FK-DISPATCH')
  for (let i = 0; i < 50 && !dispatches.some((d) => d.item.id === 'FK-DISPATCH'); i++) await new Promise((r) => setTimeout(r, 20))
  const body = dispatches.find((d) => d.item.id === 'FK-DISPATCH')
  assert.ok(body, 'nothing was dispatched')
  assert.deepEqual(body.step, { ...FIXTURE.step, index: stepIndexOf(FIXTURE.step.key) })
  assert.equal(body.item.kind, FIXTURE.item.kind)
  orchestrator.cancel('FK-DISPATCH')
})

test('a result carrying its own step key is recorded', async () => {
  const key = 'change.arch-review'
  insertItem('FK-OWN', key)
  const runId = insertRun('FK-OWN', key)
  const res = await orchestrator.completeFarmRun(runId, { summary: 'reviewed', artifacts: { artifact_md: '# ok' }, step_key: key })
  orchestrator.cancel('FK-OWN')
  assert.deepEqual(res, { ok: true })
  assert.equal(runStatus(runId), 'done')
  assert.notEqual(cursorOf('FK-OWN'), stepIndexOf(key), 'the item did not advance')
})

test("a result naming another step's key changes nothing — complete, fail and blocked alike", async () => {
  const key = 'change.arch-review'
  insertItem('FK-OTHER', key)
  const runId = insertRun('FK-OTHER', key)
  const wrong = 'change.qa-test-plan'
  assert.deepEqual(await orchestrator.completeFarmRun(runId, { summary: 'x', step_key: wrong }), { ok: true, stale: true })
  assert.deepEqual(orchestrator.failFarmRun(runId, 'boom', null, null, null, wrong), { ok: true, stale: true })
  assert.deepEqual(orchestrator.blockFarmRun(runId, { rule: 'r', needs: 'n', step_key: wrong }), { ok: true, stale: true })
  assert.equal(runStatus(runId), 'active')
  assert.equal(cursorOf('FK-OTHER'), stepIndexOf(key))
  orchestrator.cancel('FK-OTHER')
})

test('a result with no step key (a run dispatched before keys) is recorded by its run id, as before', async () => {
  const key = 'change.arch-review'
  insertItem('FK-LEGACY', key)
  const runId = insertRun('FK-LEGACY', key)
  const res = await orchestrator.completeFarmRun(runId, { summary: 'reviewed', artifacts: { artifact_md: '# ok' } })
  orchestrator.cancel('FK-LEGACY')
  assert.deepEqual(res, { ok: true })
  assert.equal(runStatus(runId), 'done')
  assert.equal(stepKeyAt(stepIndexOf(key)), key)
})
