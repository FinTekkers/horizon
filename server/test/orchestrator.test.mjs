// Orchestrator-level persona plumbing: the dispatch payload carries the item's
// persona, farm patches are registry-validated and never clobber a set value,
// the GitHub comment renders persona labels (not raw ids), and the required
// pre-execution gate is never auto-advanced.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-')), 'test.db')
// FARM_URL set => kick() dispatches to the farm (via the stubbed fetch below)
// instead of running mock timers.
process.env.FARM_URL = 'http://farm.test'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

// Capture farm dispatches instead of hitting the network.
const dispatches = []
globalThis.fetch = async (url, opts) => {
  dispatches.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  return { ok: true, json: async () => ({}) }
}

const insertItem = db.prepare(
  'INSERT INTO work_item (id, title, priority, cursor, persona) VALUES (?, ?, ?, ?, ?)',
)

test('dispatchToFarm sends the item persona to the farm', async () => {
  insertItem.run('D-1', 'Dispatch carries persona', 'Medium', 11, 'python_backend')
  orchestrator.kick('D-1')
  await new Promise((r) => setTimeout(r, 20)) // dispatch is fire-and-forget
  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'D-1')
  assert.ok(dispatch, 'no /steps/run dispatch captured')
  assert.equal(dispatch.body.item.persona, 'python_backend')
  orchestrator.cancel('D-1') // clear the watchdog so the test process can exit
})

test('kick at the required pre-execution gate does not dispatch or advance', async () => {
  insertItem.run('D-2', 'Parked at the gate', 'Medium', 10, null)
  assert.equal(STEPS[10].kind, 'gate')
  orchestrator.kick('D-2')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'D-2'").get().n, 0)
  assert.equal(store.getItem('D-2').cursor, 10)
  assert.ok(!dispatches.some((d) => d.body?.item?.id === 'D-2'))
})

function activeRunFor(id, stepIndex) {
  return db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)')
    .run(id, stepIndex, STEPS[stepIndex].agent).lastInsertRowid
}

test('a valid persona patch from the farm lands when the item has none', async () => {
  insertItem.run('D-3', 'Farm sets persona', 'Medium', 4, null)
  const runId = activeRunFor('D-3', 4)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'planned',
    patch: { persona: 'frontend_ui', desc: 'planned outcome' },
    artifacts: { artifact_md: '# plan' },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('D-3')
  assert.equal(item.persona, 'frontend_ui')
  assert.equal(item.desc, 'planned outcome')
  assert.equal(item.cursor, 5)
})

test('an invalid persona patch is dropped; the run completes and siblings survive', async () => {
  insertItem.run('D-4', 'Bad persona patch', 'Medium', 4, null)
  const runId = activeRunFor('D-4', 4)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'planned',
    patch: { persona: 'rustacean', desc: 'still lands' },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('D-4')
  assert.equal(item.persona, null)
  assert.equal(item.desc, 'still lands')
  assert.equal(item.cursor, 5)
})

test('a persona patch never clobbers a value already set (human choice wins)', async () => {
  insertItem.run('D-5', 'No clobber', 'Medium', 4, 'fullstack')
  const runId = activeRunFor('D-5', 4)
  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'planned',
    patch: { persona: 'python_backend', metric: 'faster' },
  })
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('D-5')
  assert.equal(item.persona, 'fullstack')
  assert.equal(item.metric, 'faster')
})

test('the GitHub step comment renders the persona label, not the raw id', () => {
  const body = orchestrator.stepCommentBody(
    { id: 'D-6', repo: 'acme/demo', issue: 7 },
    0,
    1,
    'defined the outcome',
    { persona: 'python_backend', desc: 'the outcome' },
    true,
    null,
  )
  assert.match(body, /\*\*Specialist persona:\*\* Python backend/)
  assert.ok(!body.includes('python_backend'), 'raw persona id leaked into the issue comment')
})
