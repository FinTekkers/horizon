// HZ-709 metric 2: approve and send-back accept step keys, and the item
// snapshot lists every step's key. The old numeric forms still work for one
// release and each logs exactly one deprecation line. Plus the new error
// states, the declared default send-back targets (guardrail 3: move/reset
// behaviour unchanged) and the snapshot for all three kinds.

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

// Every warn line the app logs, so the deprecation line can be counted.
const logLines = []
const app = buildApp({ logger: { level: 'warn', stream: { write: (line) => logLines.push(JSON.parse(line).msg) } } })
const { cookie, pin } = loginFixtureUser(auth, config)
const HUMAN = { cookie, 'x-human-key': pin }

const deprecations = (id) => logLines.filter((msg) => msg.startsWith('deprecated: numeric step') && msg.includes(`item=${id} `))

function seed(id, key, kind = 'change') {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, 'Medium', ?, ?)").run(id, `Item ${id}`, stepIndexOf(key), kind)
}
const cursorKey = (id) => stepKeyAt(db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor)
const approve = (id, step) => app.inject({ method: 'POST', url: `/api/items/${id}/gates/${step}/approve`, headers: HUMAN, payload: {} })
const reject = (id, body = {}) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/reject`, headers: HUMAN, payload: { target: 'this step', feedback: 'redo', ...body } })

// ---- approve ----

test('approve by key moves the item on, with no deprecation line', async () => {
  seed('AK-1', 'change.approve-prioritize')
  const res = await approve('AK-1', 'change.approve-prioritize')
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(cursorKey('AK-1'), 'change.plan-options')
  assert.deepEqual(deprecations('AK-1'), [])
})

test('approve by number still works for one release, and logs exactly one deprecation line', async () => {
  seed('AN-1', 'change.approve-prioritize')
  const res = await approve('AN-1', stepIndexOf('change.approve-prioritize'))
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(cursorKey('AN-1'), 'change.plan-options')
  assert.deepEqual(deprecations('AN-1'), [
    `deprecated: numeric step ref route=approve item=AN-1 step=${stepIndexOf('change.approve-prioritize')}`,
  ])
})

test('approve with an unknown key: 404 unknown_step, nothing moves', async () => {
  seed('AE-1', 'change.approve-prioritize')
  const res = await approve('AE-1', 'change.no-such-step')
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'unknown_step' })
  assert.equal(cursorKey('AE-1'), 'change.approve-prioritize')
})

test("approve with another kind's key: 409 wrong_kind, nothing moves", async () => {
  seed('AE-2', 'change.approve-prioritize')
  const res = await approve('AE-2', 'task.approve-prioritize')
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.json(), { error: 'wrong_kind' })
  assert.equal(cursorKey('AE-2'), 'change.approve-prioritize')
})

test("approve with a real key for a gate the item is not at: the existing 409, nothing moves", async () => {
  seed('AE-3', 'change.approve-prioritize')
  const res = await approve('AE-3', 'change.review-before-exec')
  assert.equal(res.statusCode, 409)
  assert.ok(!['unknown_step', 'wrong_kind'].includes(res.json().error), res.body)
  assert.equal(cursorKey('AE-3'), 'change.approve-prioritize')
})

// ---- send-back ----

test('send-back by targetStep (a key) lands on that step, with no deprecation line', async () => {
  seed('RK-1', 'change.accept-code')
  const res = await reject('RK-1', { targetStep: 'change.draft-plan' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(cursorKey('RK-1'), 'change.draft-plan')
  assert.deepEqual(deprecations('RK-1'), [])
})

test('send-back by targetStepIndex still works for one release, and logs exactly one deprecation line', async () => {
  seed('RN-1', 'change.accept-code')
  const res = await reject('RN-1', { targetStepIndex: stepIndexOf('change.draft-plan') })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(cursorKey('RN-1'), 'change.draft-plan')
  assert.deepEqual(deprecations('RN-1'), [`deprecated: numeric step ref route=reject item=RN-1 step=${stepIndexOf('change.draft-plan')}`])
})

test('send-back naming two different targets: 400 ambiguous_target; the same one twice is fine', async () => {
  seed('RE-1', 'change.accept-code')
  const res = await reject('RE-1', { targetStep: 'change.draft-plan', targetStepIndex: stepIndexOf('change.implement') })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { error: 'ambiguous_target' })
  assert.equal(cursorKey('RE-1'), 'change.accept-code')

  const same = await reject('RE-1', { targetStep: 'change.draft-plan', targetStepIndex: stepIndexOf('change.draft-plan') })
  assert.equal(same.statusCode, 200, same.body)
  assert.equal(cursorKey('RE-1'), 'change.draft-plan')
})

test("send-back to an unknown key, another kind's key or a position in targetStep: 409 invalid_target", async () => {
  seed('RE-2', 'change.accept-code')
  for (const targetStep of ['change.no-such-step', 'task.run-plan', String(stepIndexOf('change.draft-plan'))]) {
    const res = await reject('RE-2', { targetStep })
    assert.equal(res.statusCode, 409, targetStep)
    assert.deepEqual(res.json(), { error: 'invalid_target' }, targetStep)
  }
  assert.equal(cursorKey('RE-2'), 'change.accept-code')
})

// ---- default send-back targets (steps.json sendBackTo) ----

test('a send-back with no target follows the gate\'s declared default, else walks back as before', async () => {
  seed('RD-1', 'change.accept-code')
  assert.equal((await reject('RD-1')).statusCode, 200)
  assert.equal(cursorKey('RD-1'), 'change.implement')

  seed('RD-2', 'task.approve-run', 'task')
  assert.equal((await reject('RD-2')).statusCode, 200)
  assert.equal(cursorKey('RD-2'), 'task.run-plan')

  seed('RD-3', 'change.review-before-exec')
  assert.equal((await reject('RD-3')).statusCode, 200)
  assert.equal(cursorKey('RD-3'), 'change.summarize-reviews')
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
