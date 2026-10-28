// HZ-541 metric line 1: with golden cases on (the project's definitions
// switch on, and a golden_cases sub-step in the item's snapshot), Draft
// implementation plan, Implement and Review each abort with a clear error
// when the item has no approved set — before anything reaches the farm. With
// an approved set they run, and get it as an artifact read from the approved
// row only (guardrail 1). Every other step is never guarded. The mock path is
// golden-cases-guard-mock.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-golden-guard-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
delete process.env.FARM_STEP_INDEXES
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const golden = await import('../src/goldenCases.js')
const { REASON } = await import('../../domain/js/reasons.js')
const { STEPS, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, ACCEPT_GATE_INDEX, requiredStepIndex } = await import('../../domain/js/lifecycle.js')

const posts = []
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  if (String(url).includes('/steps/run')) posts.push(body)
  return { ok: true, status: 200, json: async () => ({}) }
}

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {} })

const PLAN_STEP = requiredStepIndex('Draft implementation plan')
const DESIGN_STEP = requiredStepIndex('Plan options & trade-offs (pros / cons)')
const SNAPSHOT = JSON.stringify([
  { id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: 1, persona: null, output: 'golden_cases', applies: { labels: ['valuation'], repos: [], paths: [] } },
])
const CASES = [
  { id: 'accrual-30-360', inputs: { notional: 1000000, rate: 0.05, days: 30 }, measure: 'accrued_interest', expected: 4166.67, tolerance: { abs: 0.01 }, source: 'bond-math#accrual' },
]
const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Golden guard', 1, 1)").run().lastInsertRowid)

function seed(id, cursor, { approved = false } = {}) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, substeps_json) VALUES (?, ?, 'Medium', ?, ?, ?)").run(
    id,
    `Item ${id}`,
    cursor,
    projectId,
    SNAPSHOT,
  )
  if (approved) {
    db.prepare("INSERT INTO golden_case_set (item_id, cases_json, hash, approved_by) VALUES (?, ?, ?, 'Ada')").run(id, JSON.stringify(CASES), golden.hashOf(CASES))
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
const lastRun = (id) => db.prepare('SELECT status, output FROM step_run WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(id)

async function waitForPost(id) {
  const deadline = Date.now() + 3000
  while (!posts.some((p) => p.item.id === id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  return posts.find((p) => p.item.id === id) ?? null
}

for (const [name, stepIndex] of [
  ['Draft implementation plan', PLAN_STEP],
  ['Implement', IMPLEMENT_STEP_INDEX],
  ['Review', REVIEW_STEP_INDEX],
]) {
  test(`${name} aborts with a clear error when the set is not approved, and nothing reaches the farm`, async () => {
    const id = `G-NO-${stepIndex}`
    seed(id, stepIndex)
    orchestrator.kick(id)
    await settle()
    assert.equal(posts.filter((p) => p.item.id === id).length, 0, 'zero farm dispatches')
    const run = lastRun(id)
    assert.equal(run.status, 'cancelled')
    assert.equal(run.output, `FAILED: ${golden.NOT_APPROVED_TEXT}`)
    const item = store.itemViewById(id)
    assert.equal(item.paused, true)
    assert.equal(item.cursor, stepIndex)
    // The error the person sees: the pause event names the reason and the fix.
    assert.match(item.events[0].text, new RegExp(`\\(${REASON.GOLDEN_CASES_NOT_APPROVED}\\)`))
    assert.ok(item.events[0].text.includes('golden cases are not approved — approve the set at the first gate'), item.events[0].text)
  })
}

test('with an approved set, Draft implementation plan dispatches with the approved cases as an artifact', async () => {
  seed('G-OK', PLAN_STEP, { approved: true })
  orchestrator.kick('G-OK')
  const body = await waitForPost('G-OK')
  orchestrator.cancel('G-OK')
  assert.ok(body, 'the step was dispatched')
  assert.equal(body.step.index, PLAN_STEP)
  assert.equal(body.golden_cases, true, 'the farm is told to append the golden-cases addendum')
  const input = body.artifacts.find((a) => a.label === golden.APPROVED_ARTIFACT_LABEL)
  assert.ok(input, 'the approved set rides along')
  assert.ok(input.content.includes(JSON.stringify({ cases: CASES }, null, 2)))
})

test('the injected set is the approved row, even after the sub-step’s run is rewritten (guardrail 1)', async () => {
  seed('G-FROZEN', PLAN_STEP, { approved: true })
  const other = [{ ...CASES[0], expected: 1 }]
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, artifact) VALUES ('G-FROZEN', 1, 'golden-cases', 1, 'PM', 'done', ?)",
  ).run('```json golden-cases\n' + JSON.stringify({ cases: other }) + '\n```')
  orchestrator.kick('G-FROZEN')
  const body = await waitForPost('G-FROZEN')
  orchestrator.cancel('G-FROZEN')
  const input = body.artifacts.find((a) => a.label === golden.APPROVED_ARTIFACT_LABEL)
  const stored = db.prepare('SELECT cases_json FROM golden_case_set WHERE item_id = ?').get('G-FROZEN').cases_json
  assert.ok(input.content.includes(JSON.stringify({ cases: JSON.parse(stored) }, null, 2)))
  assert.ok(!input.content.includes('"expected": 1\n'))
})

test('Design and Accept the code are never guarded, and Design dispatches with no approved set', async () => {
  for (const stepIndex of [DESIGN_STEP, ACCEPT_GATE_INDEX]) {
    const id = `G-FREE-${stepIndex}`
    seed(id, stepIndex)
    assert.equal(orchestrator.refuseWithoutGoldenCases(0, id, stepIndex), false)
  }
  orchestrator.kick(`G-FREE-${DESIGN_STEP}`)
  const body = await waitForPost(`G-FREE-${DESIGN_STEP}`)
  orchestrator.cancel(`G-FREE-${DESIGN_STEP}`)
  assert.ok(body, `${STEPS[DESIGN_STEP].label} was dispatched`)
  assert.ok(!body.artifacts.some((a) => a.label === golden.APPROVED_ARTIFACT_LABEL))
})
