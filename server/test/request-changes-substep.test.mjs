// HZ-540 metric 2 and guardrail 2: a send-back from a gate can target an
// (anchor, sub-step) pair from the item's snapshot and the item lands on the
// anchor at that sub-step. A numeric targetStepIndex works as before. A pair
// the item does not offer is refused with invalid_target and changes nothing.
//
// HZ-712: the send-back route is retired. A pair is now POST /move's stepKey
// form, `<step>#<sub-step>`, which runs gateActions.sendBack; the store-level
// checks (the numeric form, the refusal table) call gateActions.sendBack
// directly, as the caretaker does.

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
const { STEPS, ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX, requiredStepIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')

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

// POST /move to `stepKey` from wherever the item is, with the note 'redo'.
const move = (id, stepKey) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/move`,
    headers: { cookie, 'x-human-key': pin },
    payload: { from: stepKeyAt(store.getItem(id).cursor), stepKey, note: 'redo' },
  })
// The send-back itself, as the caretaker reaches it.
const sendBack = (id, body) => app.gateActions.sendBack(id, { target: 'the code', feedback: 'redo', ...body }, 'You')
const IMPL_AUDIT = `${stepKeyAt(IMPLEMENT_STEP_INDEX)}#impl-audit`
const row = (id) => db.prepare('SELECT cursor, substep_cursor FROM work_item WHERE id = ?').get(id)
const lastEvent = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(id)?.text

test('a pair sends the item back to the anchor, at that sub-step', async () => {
  seed('P-1')
  const res = await move('P-1', IMPL_AUDIT)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(row('P-1'), { cursor: IMPLEMENT_STEP_INDEX, substep_cursor: 'impl-audit' })
  assert.equal(store.itemViewById('P-1').substep.label, 'Audit the change')
  // /move names the gate the item was at as the send-back's target.
  assert.equal(lastEvent('P-1'), `requested changes on ${STEPS[ACCEPT_GATE_INDEX].label}: redo — sent back to the audit the change step`)
})

test('a pair to an opening sub-step from the plan gate lands on its anchor', async () => {
  seed('P-2', { cursor: PLAN_GATE })
  const res = await move('P-2', `${stepKeyAt(1)}#golden-cases`)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(row('P-2'), { cursor: 1, substep_cursor: 'golden-cases' })
})

test('a numeric targetStepIndex works as before, and leaves the item at no sub-step', async () => {
  seed('N-1', { substepCursor: 'impl-audit' })
  assert.deepEqual(await sendBack('N-1', { targetStepIndex: IMPLEMENT_STEP_INDEX }), { ok: true })
  assert.deepEqual(row('N-1'), { cursor: IMPLEMENT_STEP_INDEX, substep_cursor: null })
  assert.equal(store.itemViewById('N-1').substep, null)

  // An item with no snapshot: the same send-back, the same event as before.
  seed('N-2', { substeps: null })
  assert.deepEqual(await sendBack('N-2', { targetStepIndex: IMPLEMENT_STEP_INDEX }), { ok: true })
  assert.deepEqual(row('N-2'), { cursor: IMPLEMENT_STEP_INDEX, substep_cursor: null })
  assert.equal(lastEvent('N-2'), `requested changes on the code: redo — sent back to the ${STEPS[IMPLEMENT_STEP_INDEX].label.toLowerCase()} step`)

  // And the store's five-argument call, as every existing caller makes it.
  seed('N-3')
  assert.deepEqual(store.requestChanges('N-3', 'the code', 'redo', 'You', IMPLEMENT_STEP_INDEX), { ok: true })
  assert.deepEqual(row('N-3'), { cursor: IMPLEMENT_STEP_INDEX, substep_cursor: null })
})

test('a pair the item does not offer is refused with invalid_target and changes nothing', async () => {
  // [name, seed, send-back body, the same pair as a /move key (null: no key names it)]
  const cases = [
    ['an id not in the snapshot', {}, { targetStepIndex: IMPLEMENT_STEP_INDEX, targetSubstepId: 'not-there' }, `${stepKeyAt(IMPLEMENT_STEP_INDEX)}#not-there`],
    ['a sub-step under another step', {}, { targetStepIndex: IMPLEMENT_STEP_INDEX, targetSubstepId: 'golden-cases' }, `${stepKeyAt(IMPLEMENT_STEP_INDEX)}#golden-cases`],
    ['a sub-step id with no step', {}, { targetSubstepId: 'impl-audit' }, null],
    ['a sub-step not before the gate', { cursor: PLAN_GATE }, { targetStepIndex: IMPLEMENT_STEP_INDEX, targetSubstepId: 'impl-audit' }, IMPL_AUDIT],
    ['a sub-step on an item with no snapshot', { substeps: null }, { targetStepIndex: IMPLEMENT_STEP_INDEX, targetSubstepId: 'impl-audit' }, IMPL_AUDIT],
  ]
  for (const [i, [name, seeded, body, key]] of cases.entries()) {
    const id = `B-${i}`
    seed(id, seeded)
    const before = row(id)
    assert.deepEqual(await sendBack(id, body), { error: 'invalid_target' }, name)
    assert.deepEqual(row(id), before, name)
    if (key == null) continue
    const res = await move(id, key)
    assert.equal(res.statusCode, 400, name)
    assert.equal(res.json().error, 'invalid_target', name)
    assert.deepEqual(row(id), before, name)
  }
})

test('a sub-step id that is not an id is refused before the store sees it', async () => {
  seed('B-pattern')
  const res = await move('B-pattern', `${stepKeyAt(IMPLEMENT_STEP_INDEX)}#Not An Id`)
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'invalid_target')
  assert.deepEqual(row('B-pattern'), { cursor: ACCEPT_GATE_INDEX, substep_cursor: null })
})

// HZ-709: the same pair named by key lands exactly where the position form
// does, at the same sub-step, with the same event. HZ-712: the key is /move's
// stepKey; the position form is gateActions.sendBack, given the target label
// /move gives it.
test('a stepKey pair lands where targetStepIndex plus targetSubstepId does', async () => {
  seed('K-IDX')
  seed('K-KEY')
  const target = STEPS[ACCEPT_GATE_INDEX].label
  assert.deepEqual(await sendBack('K-IDX', { target, targetStepIndex: IMPLEMENT_STEP_INDEX, targetSubstepId: 'impl-audit' }), { ok: true })
  assert.equal((await move('K-KEY', IMPL_AUDIT)).statusCode, 200)
  assert.deepEqual(row('K-KEY'), row('K-IDX'))
  assert.deepEqual(row('K-KEY'), { cursor: IMPLEMENT_STEP_INDEX, substep_cursor: 'impl-audit' })
  assert.equal(lastEvent('K-KEY'), lastEvent('K-IDX'))

  // A key whose step does not offer that sub-step is refused, as by position.
  seed('K-BAD')
  const res = await move('K-BAD', 'change.draft-plan#impl-audit')
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'invalid_target')
  assert.deepEqual(row('K-BAD'), { cursor: ACCEPT_GATE_INDEX, substep_cursor: null })
})
