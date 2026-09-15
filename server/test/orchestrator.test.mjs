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

// ---- artifact prompt budget (HZ-29) ----
// A superseded attempt of a re-run step must not ride along with its current
// version, a long artifact must not silently lose its tail, and the total
// dispatched size must stay bounded. See orchestrator.js's budgetArtifacts.

function doneStepRun(itemId, stepIndex, attempt, artifact) {
  return db
    .prepare(
      "INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact, ended_at) VALUES (?, ?, ?, ?, 'done', ?, datetime('now'))",
    )
    .run(itemId, stepIndex, attempt, STEPS[stepIndex].agent, artifact).lastInsertRowid
}

test('budgetArtifacts: empty input yields no artifacts', () => {
  assert.deepEqual(orchestrator.budgetArtifacts([]), [])
})

test('budgetArtifacts: a single (latest-only) artifact passes through untouched', () => {
  const [result] = orchestrator.budgetArtifacts([{ step_index: 6, artifact: 'a short plan' }])
  assert.equal(result.content, 'a short plan')
  assert.equal(result.truncated, false)
})

test('budgetArtifacts: the latest artifact gets the dominant share and stays whole for realistic sizes', () => {
  const latest = 'p'.repeat(15000) // bigger than the old flat 12,000-char slice
  const rows = [{ step_index: 4, artifact: 'small older plan' }, { step_index: 6, artifact: latest }]
  const result = orchestrator.budgetArtifacts(rows)
  const latestEntry = result[result.length - 1]
  assert.equal(latestEntry.truncated, false)
  assert.equal(latestEntry.content, latest)
})

test('budgetArtifacts: an older artifact that does not fit its share is truncated with a visible marker', () => {
  const older = 'o'.repeat(50000)
  const rows = [{ step_index: 4, artifact: older }, { step_index: 6, artifact: 'latest plan' }]
  const [olderEntry] = orchestrator.budgetArtifacts(rows)
  assert.equal(olderEntry.truncated, true)
  assert.match(olderEntry.content, /\[\.\.\.truncated \d+ of 50000 chars\.\.\.\]$/)
  assert.ok(olderEntry.content.length < older.length)
})

test('budgetArtifacts: many older artifacts hit the 40% reserve ceiling and each still gets a positive cap', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ step_index: i, artifact: 'x'.repeat(50000) }))
  const result = orchestrator.budgetArtifacts(rows)
  const older = result.slice(0, -1)
  for (const entry of older) {
    assert.equal(entry.truncated, true)
    assert.ok(entry.content.length > 0)
  }
  // reserve is capped at 40% of the total budget, split evenly across 9 older artifacts
  const expectedOlderCap = Math.floor(Math.min(9 * 3000, 60000 * 0.4) / 9)
  assert.ok(expectedOlderCap > 0)
  const marker = `\n\n[...truncated ${50000 - expectedOlderCap} of 50000 chars...]`
  assert.equal(older[0].content.length, expectedOlderCap + marker.length)
})

test('dispatchToFarm keeps only the latest attempt per step_index (dedupe)', async () => {
  insertItem.run('D-7', 'Re-run planning step', 'Medium', 11, null)
  doneStepRun('D-7', 6, 1, 'OLD superseded plan')
  doneStepRun('D-7', 6, 2, 'NEW reworked plan')
  orchestrator.kick('D-7')
  await new Promise((r) => setTimeout(r, 20))
  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'D-7')
  assert.ok(dispatch, 'no /steps/run dispatch captured')
  const planArtifacts = dispatch.body.artifacts.filter((a) => a.label === STEPS[6].label)
  assert.equal(planArtifacts.length, 1, 'superseded attempt rode along')
  assert.equal(planArtifacts[0].content, 'NEW reworked plan')
  orchestrator.cancel('D-7')
})

test('dispatchToFarm budgets a large plan complete and marks truncated older artifacts, with an item event', async () => {
  insertItem.run('D-8', 'Large plan with old context', 'Medium', 11, null)
  doneStepRun('D-8', 4, 1, 'a'.repeat(50000))
  doneStepRun('D-8', 6, 1, 'b'.repeat(50000))
  const latestPlan = 'c'.repeat(15000)
  doneStepRun('D-8', 7, 1, latestPlan)
  orchestrator.kick('D-8')
  await new Promise((r) => setTimeout(r, 20))
  const dispatch = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'D-8')
  assert.ok(dispatch, 'no /steps/run dispatch captured')
  const byLabel = Object.fromEntries(dispatch.body.artifacts.map((a) => [a.label, a.content]))
  assert.equal(byLabel[STEPS[7].label], latestPlan, 'the latest artifact must arrive complete')
  assert.ok(byLabel[STEPS[4].label].includes('[...truncated'), 'older artifact should be marked truncated')
  assert.ok(byLabel[STEPS[6].label].includes('[...truncated'), 'older artifact should be marked truncated')
  const event = db.prepare("SELECT text FROM event WHERE item_id = 'D-8' ORDER BY id DESC LIMIT 1").get()
  assert.match(event.text, /artifact truncated for context budget/)
  assert.ok(event.text.includes(STEPS[4].label), 'event should name the truncated step')
  assert.ok(event.text.includes(STEPS[6].label), 'event should name the truncated step')
  orchestrator.cancel('D-8')
})

test('completeFarmRun stores the full artifact — the write side no longer cuts a plan off at 12,000 chars', async () => {
  insertItem.run('D-9', 'Large plan writes in full', 'Medium', 6, null)
  const runId = activeRunFor('D-9', 6)
  const bigPlan = 'p'.repeat(15000)
  const result = await orchestrator.completeFarmRun(runId, { summary: 'planned', artifacts: { artifact_md: bigPlan } })
  assert.deepEqual(result, { ok: true })
  const stored = db.prepare('SELECT artifact FROM step_run WHERE id = ?').get(runId).artifact
  assert.equal(stored.length, 15000)
  assert.equal(stored, bigPlan)
  orchestrator.cancel('D-9') // completing step 6 auto-kicks step 7 (agent); clear its watchdog
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
