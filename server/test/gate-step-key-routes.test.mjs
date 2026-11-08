// HZ-709 metric 2: the item snapshot lists every step's key, for all three
// kinds, and the declared default send-back targets (guardrail 3: move/reset
// behaviour unchanged). HZ-712 retired the old approve and send-back routes,
// and their key and numeric step forms with them; POST /api/items/:id/move
// takes step keys only, and the WhatsApp gate routes' key and numeric forms
// are wa-approval-auth.test.mjs's.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-gate-step-key-routes-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.HORIZON_REPO
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { STEPS, stepsFor, stepIndexOf, stepKeyAt } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)

function seed(id, key, kind = 'change') {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, 'Medium', ?, ?)").run(id, `Item ${id}`, stepIndexOf(key), kind)
}
const cursorKey = (id) => stepKeyAt(db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor)
// The gate's send-back with no target: what the Caretaker and a WhatsApp vote
// run. Its HTTP route was retired in HZ-712.
const sendBack = (id) => app.gateActions.sendBack(id, { target: 'this step', feedback: 'redo' }, 'You')

// ---- default send-back targets (steps.json sendBackTo) ----

test('a send-back with no target follows the gate\'s declared default', async () => {
  seed('RD-1', 'change.accept-code')
  assert.equal((await sendBack('RD-1')).ok, true)
  assert.equal(cursorKey('RD-1'), 'change.implement')

  seed('RD-2', 'task.approve-run', 'task')
  assert.equal((await sendBack('RD-2')).ok, true)
  assert.equal(cursorKey('RD-2'), 'task.run-plan')

  seed('RD-3', 'change.review-before-exec')
  assert.equal((await sendBack('RD-3')).ok, true)
  // HZ-708: every gate declares one — Review before execution, the plan it reviews.
  assert.equal(cursorKey('RD-3'), 'change.draft-plan')
})

// ---- the snapshot ----

test('the snapshot lists every step with its key, for a Change, a Task and a Plan', async () => {
  const cases = [
    ['SN-CHANGE', 'change', 'change.accept-code', 'change.draft-plan'],
    ['SN-TASK', 'task', 'task.approve-run', 'task.run-plan'],
    ['SN-PLAN', 'plan', 'plan.approve-file', 'plan.draft-items'],
  ]
  for (const [id, kind, at, done] of cases) {
    seed(id, at, kind)
    db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output) VALUES (?, ?, 1, ?, 'done', 'did it')").run(
      id,
      stepIndexOf(done),
      STEPS[stepIndexOf(done)].agent,
    )
  }
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  for (const [id, kind, at, done] of cases) {
    const item = res.json().items.find((it) => it.id === id)
    assert.ok(item, id)
    assert.equal(item.steps.length, stepsFor(kind).length, id)
    assert.deepEqual(
      item.steps.map((step) => step.key),
      stepsFor(kind).map((step) => step.key),
      id,
    )
    for (const step of item.steps) assert.equal(step.label, STEPS[stepIndexOf(step.key)].label, `${id} ${step.key}`)
    assert.equal(item.currentStepKey, at, id)
    assert.equal(item.currentStepKey, stepKeyAt(item.cursor), id)
    assert.equal(item.currentStep.key, at, id)
    const outputs = Object.values(item.stepOutputs)
    assert.ok(outputs.length > 0, `${id}: positive control — no step outputs`)
    for (const output of outputs) assert.equal(typeof output.key, 'string', `${id}: an output with no key`)
    assert.equal(item.stepOutputs[stepIndexOf(done)].key, done, id)
  }
})
