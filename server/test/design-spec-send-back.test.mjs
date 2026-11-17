// HO-852 metric line 5, after golden-cases-send-back.test.mjs. A send-back to
// or before the first gate deletes the frozen design row — a return to a step
// (moveItem.js's reset) and a return to the design sub-step (store.js's
// send-back), for a Change and a Task, a frozen canvas and a skip alike. The
// re-approved canvas is the new round's. A send-back to Design, Implement or
// Review keeps the row byte for byte. All through the real POST /move.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('design-spec-send-back test: no network')
}
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-design-spec-send-back-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO']) delete process.env[key]
process.env.MOCK_STEP_LATENCY_MS = String(60 * 60 * 1000)

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const spec = await import('../src/designSpec.js')
const { canvasUrlFor } = await import('../../domain/js/designCanvas.js')
const { ACCEPT_GATE_INDEX, APPROVE_RUN_GATE_INDEX, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, kindStepIndex, requiredStepIndex, stepKeyAt } = await import(
  '../../domain/js/lifecycle.js'
)

store.purgeDemoItems()
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

const CHANGE_GATE = requiredStepIndex('Approve & prioritize this work')
const DESIGN_GATE = requiredStepIndex('Approve the high-level design')
const PLAN_OPTIONS = requiredStepIndex('Plan options & trade-offs (pros / cons)')
const PLAN_GATE = requiredStepIndex('Review before execution')
const TASK_GATE = kindStepIndex('Approve & prioritize', 'task')
const TASK_ANCHOR = kindStepIndex("How we'll verify", 'task')
const TASK_GUARDRAILS = kindStepIndex('Guardrails', 'task')
const DESIGN_ID = 'design-screens'
const snapshot = (anchor) =>
  JSON.stringify([{ id: DESIGN_ID, label: 'Design the screens', kind: 'opening', anchor, persona: null, output: 'design', applies: { labels: ['design'], repos: [], paths: [] } }])
const canvasLine = (slug) => `**Canvas:** [Open the design canvas](${canvasUrlFor(slug)}) · slug \`${slug}\` · version 1`

const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Design spec send-back', 1, 1)").run().lastInsertRowid)

const writeRun = (id, anchor, slug) =>
  Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, artifact) VALUES (?, ?, ?, 1, 'Design', 'done', ?)")
      .run(id, anchor, DESIGN_ID, canvasLine(slug)).lastInsertRowid,
  )
// An item at `cursor` whose first gate froze a canvas, or a skip with `skip`.
function seedFrozen(id, cursor, { kind = 'change', skip = null } = {}) {
  const anchor = kind === 'change' ? 1 : TASK_ANCHOR
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, substeps_json) VALUES (?, ?, 'Medium', ?, ?, ?, ?)").run(
    id,
    `Item ${id}`,
    cursor,
    kind,
    projectId,
    snapshot(anchor),
  )
  const runId = writeRun(id, anchor, 'first')
  if (skip) spec.skipDesign(id, skip, 'Ada')
  else spec.approveCanvas(id, { url: canvasUrlFor('first'), runId }, 'Ada')
  return anchor
}
const move = (id, payload) => app.inject({ method: 'POST', url: `/api/items/${id}/move`, headers: { cookie, 'x-human-key': pin }, payload })
// From the item's gate back to a step, or with a sub-step id to that sub-step.
const sendBack = (id, toIndex, substepId = null) => {
  const from = stepKeyAt(cursorOf(id))
  return substepId
    ? move(id, { stepKey: `${stepKeyAt(toIndex)}#${substepId}`, from, note: 'redo' })
    : move(id, { action: 'return', from, to: stepKeyAt(toIndex), note: 'redo' })
}
const specRow = (id) => db.prepare('SELECT * FROM design_spec WHERE item_id = ?').get(id)
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor

for (const [name, gate, landsOn] of [
  ['to Design (from the design gate)', DESIGN_GATE, PLAN_OPTIONS],
  ['to Implement (from Accept the code)', ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX],
  ['to Review (from Accept the code)', ACCEPT_GATE_INDEX, REVIEW_STEP_INDEX],
]) {
  test(`a send-back ${name} keeps the frozen canvas byte for byte`, async () => {
    const id = `K-${gate}-${landsOn}`
    seedFrozen(id, gate)
    const before = specRow(id)
    const res = await sendBack(id, landsOn)
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(cursorOf(id), landsOn)
    assert.deepEqual(specRow(id), before)
  })
}

for (const [kind, gate, toStep] of [
  ['change', DESIGN_GATE, 2],
  ['task', APPROVE_RUN_GATE_INDEX, TASK_GUARDRAILS],
]) {
  test(`a ${kind}: a return to a step before the first gate deletes the frozen canvas (moveItem.js)`, async () => {
    const id = `C-STEP-${kind}`
    seedFrozen(id, gate, { kind })
    const res = await sendBack(id, toStep)
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(specRow(id), undefined)
  })

  test(`a ${kind}: a return to the design sub-step deletes the frozen canvas (store.js)`, async () => {
    const id = `C-SUB-${kind}`
    const anchor = seedFrozen(id, gate, { kind })
    const res = await sendBack(id, anchor, DESIGN_ID)
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(specRow(id), undefined)
  })

  test(`a ${kind}: a skip is deleted the same way`, async () => {
    const id = `C-SKIP-${kind}`
    seedFrozen(id, gate, { kind, skip: 'Back-end only.' })
    assert.equal(specRow(id).skip_reason, 'Back-end only.')
    const res = await sendBack(id, toStep)
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(specRow(id), undefined)
  })
}

test('after a clear, the next approval freezes the new round’s canvas, and the next dispatch input carries it', async () => {
  seedFrozen('R-NEW', PLAN_GATE)
  const res = await sendBack('R-NEW', 1, DESIGN_ID)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(specRow('R-NEW'), undefined)

  // The design round re-runs with a new canvas, and the item walks back to the gate.
  const fresh = writeRun('R-NEW', 1, 'second')
  db.prepare('UPDATE work_item SET cursor = ?, substep_cursor = NULL, substep_pending_json = NULL WHERE id = ?').run(CHANGE_GATE, 'R-NEW')
  const approved = await move('R-NEW', { action: 'approve', from: stepKeyAt(CHANGE_GATE), designRunId: fresh })
  assert.equal(approved.statusCode, 200, approved.body)
  assert.equal(specRow('R-NEW').canvas_url, canvasUrlFor('second'))
  const input = spec.canvasInput('R-NEW', PLAN_OPTIONS)
  assert.ok(input.content.includes(canvasUrlFor('second')))
  assert.ok(!input.content.includes(canvasUrlFor('first')))
})

test('an item back at the first gate with its canvas still frozen approves with no run named, and keeps the row', async () => {
  seedFrozen('R-KEEP', CHANGE_GATE)
  const before = specRow('R-KEEP')
  writeRun('R-KEEP', 1, 'later')
  const res = await move('R-KEEP', { action: 'approve', from: stepKeyAt(CHANGE_GATE) })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(specRow('R-KEEP'), before)
})
