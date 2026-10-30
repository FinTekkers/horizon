// HZ-540 metric 2 and guardrail 2: a send-back from a gate can target an
// (anchor, sub-step) pair from the item's snapshot — POST /reject with
// targetStepIndex and targetSubstepId — and the item lands on the anchor at
// that sub-step. A numeric targetStepIndex works as before. A pair the item
// does not offer is refused with invalid_target and changes nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-request-changes-substep-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.HORIZON_REPO

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { STEPS, ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX, requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)

const PLAN_GATE = requiredStepIndex('Review before execution')
const SNAPSHOT = JSON.stringify([
  { id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: 1, persona: 'data_integrity', output: 'golden_cases', applies: { labels: ['valuation'], repos: [], paths: [] } },
  { id: 'impl-audit', label: 'Audit the change', kind: 'audit', anchor: IMPLEMENT_STEP_INDEX, persona: null, output: 'findings', applies: { labels: ['valuation'], repos: [], paths: [] } },
])

function seed(id, { cursor = ACCEPT_GATE_INDEX, substeps = SNAPSHOT, substepCursor = null } = {}) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, substeps_json, substep_cursor) VALUES (?, ?, 'Medium', ?, ?, ?)").run(
    id,
    `Item ${id}`,
    cursor,
    substeps,
    substepCursor,
  )
}

const reject = (id, body) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/reject`, headers: { cookie, 'x-human-key': pin }, payload: { target: 'the code', feedback: 'redo', ...body } })
const row = (id) => db.prepare('SELECT cursor, substep_cursor FROM work_item WHERE id = ?').get(id)
const lastEvent = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(id)?.text

test('a pair sends the item back to the anchor, at that sub-step', async () => {
  seed('P-1')
  const res = await reject('P-1', { targetStepIndex: IMPLEMENT_STEP_INDEX, targetSubstepId: 'impl-audit' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(row('P-1'), { cursor: IMPLEMENT_STEP_INDEX, substep_cursor: 'impl-audit' })
  assert.equal(store.itemViewById('P-1').substep.label, 'Audit the change')
  assert.equal(lastEvent('P-1'), 'requested changes on the code: redo — sent back to the audit the change step')
})

test('a pair to an opening sub-step from the plan gate lands on its anchor', async () => {
  seed('P-2', { cursor: PLAN_GATE })
  const res = await reject('P-2', { targetStepIndex: 1, targetSubstepId: 'golden-cases' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(row('P-2'), { cursor: 1, substep_cursor: 'golden-cases' })
})

test('a numeric targetStepIndex works as before, and leaves the item at no sub-step', async () => {
  seed('N-1', { substepCursor: 'impl-audit' })
  const res = await reject('N-1', { targetStepIndex: IMPLEMENT_STEP_INDEX })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(row('N-1'), { cursor: IMPLEMENT_STEP_INDEX, substep_cursor: null })
  assert.equal(store.itemViewById('N-1').substep, null)

  // An item with no snapshot: the same send-back, the same event as before.
  seed('N-2', { substeps: null })
  assert.equal((await reject('N-2', { targetStepIndex: IMPLEMENT_STEP_INDEX })).statusCode, 200)
  assert.deepEqual(row('N-2'), { cursor: IMPLEMENT_STEP_INDEX, substep_cursor: null })
  assert.equal(lastEvent('N-2'), `requested changes on the code: redo — sent back to the ${STEPS[IMPLEMENT_STEP_INDEX].label.toLowerCase()} step`)

  // And the store's five-argument call, as every existing caller makes it.
  seed('N-3')
  assert.deepEqual(store.requestChanges('N-3', 'the code', 'redo', 'You', IMPLEMENT_STEP_INDEX), { ok: true })
  assert.deepEqual(row('N-3'), { cursor: IMPLEMENT_STEP_INDEX, substep_cursor: null })
})

test('a pair the item does not offer is refused with invalid_target and changes nothing', async () => {
  const cases = [
    ['an id not in the snapshot', {}, { targetStepIndex: IMPLEMENT_STEP_INDEX, targetSubstepId: 'not-there' }],
    ['a sub-step under another step', {}, { targetStepIndex: IMPLEMENT_STEP_INDEX, targetSubstepId: 'golden-cases' }],
    ['a sub-step id with no step', {}, { targetSubstepId: 'impl-audit' }],
    ['a sub-step not before the gate', { cursor: PLAN_GATE }, { targetStepIndex: IMPLEMENT_STEP_INDEX, targetSubstepId: 'impl-audit' }],
    ['a sub-step on an item with no snapshot', { substeps: null }, { targetStepIndex: IMPLEMENT_STEP_INDEX, targetSubstepId: 'impl-audit' }],
  ]
  for (const [i, [name, seeded, body]] of cases.entries()) {
    const id = `B-${i}`
    seed(id, seeded)
    const before = row(id)
    const res = await reject(id, body)
    assert.equal(res.statusCode, 409, name)
    assert.equal(res.json().error, 'invalid_target', name)
    assert.deepEqual(row(id), before, name)
  }
})

test('a sub-step id that is not an id is refused before the store sees it', async () => {
  seed('B-pattern')
  const res = await reject('B-pattern', { targetStepIndex: IMPLEMENT_STEP_INDEX, targetSubstepId: 'Not An Id' })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(row('B-pattern'), { cursor: ACCEPT_GATE_INDEX, substep_cursor: null })
})
