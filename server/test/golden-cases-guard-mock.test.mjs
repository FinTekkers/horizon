// HZ-541 metric line 1, the mock path: with no farm (demo mode and the e2e
// server), Draft implementation plan, Implement and Review abort the same way
// with no approved golden cases — no mock step runs and the item pauses. With
// an approved set, the mock step runs. golden-cases-guard.test.mjs is the
// farm path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-golden-guard-mock-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '10'
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const golden = await import('../src/goldenCases.js')
const { REASON } = await import('../../domain/js/reasons.js')
const { IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {} })

const PLAN_STEP = requiredStepIndex('Draft implementation plan')
const SNAPSHOT = JSON.stringify([
  { id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: 1, persona: null, output: 'golden_cases', applies: { labels: ['valuation'], repos: [], paths: [] } },
])
const CASES = [{ id: 'c1', inputs: { x: 1 }, measure: 'y', expected: 2, tolerance: { abs: 0 }, source: 'doc#s' }]
const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Golden mock', 1, 1)").run().lastInsertRowid)

function seed(id, cursor) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, substeps_json) VALUES (?, ?, 'Medium', ?, ?, ?)").run(
    id,
    `Item ${id}`,
    cursor,
    projectId,
    SNAPSHOT,
  )
}
const runs = (id) => db.prepare('SELECT status, output FROM step_run WHERE item_id = ? ORDER BY id').all(id)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

for (const stepIndex of [PLAN_STEP, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX]) {
  test(`step ${stepIndex} aborts on the mock path with no approved set`, async () => {
    const id = `M-NO-${stepIndex}`
    seed(id, stepIndex)
    orchestrator.kick(id)
    await wait(100)
    assert.deepEqual(runs(id), [{ status: 'cancelled', output: `FAILED: ${golden.NOT_APPROVED_TEXT}` }])
    const item = store.itemViewById(id)
    assert.equal(item.paused, true)
    assert.equal(item.cursor, stepIndex)
    assert.match(item.events[0].text, new RegExp(`\\(${REASON.GOLDEN_CASES_NOT_APPROVED}\\)`))
  })
}

test('with an approved set, the mock Draft implementation plan runs and moves on', async () => {
  seed('M-OK', PLAN_STEP)
  db.prepare("INSERT INTO golden_case_set (item_id, cases_json, hash, approved_by) VALUES ('M-OK', ?, ?, 'Ada')").run(JSON.stringify(CASES), golden.hashOf(CASES))
  orchestrator.kick('M-OK')
  const deadline = Date.now() + 3000
  while (store.getItem('M-OK').cursor === PLAN_STEP && Date.now() < deadline) await wait(10)
  orchestrator.cancel('M-OK')
  assert.equal(runs('M-OK')[0].status, 'done')
  assert.equal(!!store.getItem('M-OK').paused, false)
})
