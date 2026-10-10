// HZ-377a: every item has a kind — `change` or `task`. Items with no stored
// kind read as `change`, an unknown kind is refused, the change rows keep
// their labels, order and step numbers with the task rows after them, and a
// stored closed change cursor still reads closed. Cursor movement for a task
// (restart, send-back, gate advance) stays inside the task rows.
//
// Step positions are always derived through kindStepIndex/firstStepIndex/
// endIndex — never typed — so this file cannot go stale on an insertion the
// way a hardcoded cursor would.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-item-kind-')), 'test.db')

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const {
  STEPS,
  isClosed,
  curStep,
  phaseIdx,
  itemKindOf,
  phasesFor,
  stepsFor,
  firstStepIndex,
  endIndex,
  kindStepIndex,
  requiredStepIndex,
  IMPLEMENT_STEP_INDEX,
} = await import('../../domain/js/lifecycle.js')

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, ?, ?, ?)')
// A legacy row, written as if the kind column did not exist yet.
const insertLegacyItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')

test('an item with no stored kind reads as change', () => {
  insertLegacyItem.run('K-LEGACY', 'Legacy item', 'Medium', firstStepIndex('change'))
  assert.equal(store.getItem('K-LEGACY').kind, 'change')
  assert.equal(
    store.listItems().find((it) => it.id === 'K-LEGACY').kind,
    'change',
  )
  assert.equal(itemKindOf({ cursor: firstStepIndex('change') }), 'change')
})

test('a stored task reads as task, through getItem and the list payload', () => {
  const assess = kindStepIndex('Assess', 'task')
  insertItem.run('K-TASK', 'Task item', 'Medium', assess, 'task')
  const item = store.getItem('K-TASK')
  assert.equal(item.kind, 'task')
  const view = store.listItems().find((it) => it.id === 'K-TASK')
  assert.equal(view.kind, 'task')
  assert.equal(view.currentStep.label, STEPS[assess].label)
  assert.equal(view.currentStep.phase, phasesFor('task')[STEPS[assess].phase])
})

test('creating an item with an unknown kind fails unknown_item_kind and writes nothing', () => {
  assert.deepEqual(
    store.createLocalItem({ title: 'Bad kind', outcome: 'o', metric: 'm', priority: 'Medium', kind: 'banana' }),
    { error: 'unknown_item_kind' },
  )
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_item WHERE id LIKE 'LOC-%'").get().n, 0)
})

test('creating an item without a kind stores a change at the first change step', () => {
  const id = store.createLocalItem({ title: 'Plain item', outcome: 'o', metric: 'm', priority: 'Medium' })
  const item = store.getItem(id)
  assert.equal(item.kind, 'change')
  assert.equal(item.cursor, firstStepIndex('change'))
})

test('index stability: change rows carry no kind marker and keep indices 0..N-1 in order', () => {
  const boundary = firstStepIndex('task')
  const changeRows = stepsFor('change')
  assert.deepEqual(
    changeRows.map((row) => row.index),
    changeRows.map((_, i) => i),
  )
  for (const row of changeRows) {
    assert.ok(!Object.prototype.hasOwnProperty.call(STEPS[row.index], 'itemKind'))
    assert.equal(STEPS[row.index].label, row.label)
  }
  assert.equal(endIndex('change'), boundary)
  // Global label resolution still lands on the change row at its own position.
  for (const row of changeRows) {
    assert.equal(requiredStepIndex(row.label), row.index)
    assert.equal(kindStepIndex(row.label, 'change'), row.index)
  }
})

test('index stability: every task row sits after every change row', () => {
  const changeMax = endIndex('change') - 1
  const taskRows = stepsFor('task')
  assert.ok(taskRows.length > 0)
  for (const row of taskRows) {
    assert.ok(row.index > changeMax, `task row "${row.label}" is not after the change rows`)
    assert.equal(STEPS[row.index].itemKind, 'task')
    assert.equal(kindStepIndex(row.label, 'task'), row.index)
  }
  assert.equal(firstStepIndex('task'), endIndex('change'))
  assert.equal(endIndex('task'), STEPS.length)
})

test('a change item stored with the old closed cursor still reads closed', () => {
  const closedCursor = endIndex('change')
  insertLegacyItem.run('K-OLD-CLOSED', 'Closed before kinds', 'Medium', closedCursor)
  const item = store.getItem('K-OLD-CLOSED')
  assert.equal(item.kind, 'change')
  assert.equal(isClosed(item), true)
  assert.equal(curStep(item), null)
  assert.equal(phaseIdx(item), phasesFor('change').length - 1)
})

test('restartPhase on a task restarts that kind\'s phase, never a change row', () => {
  insertItem.run('K-RESTART', 'Task restart', 'Medium', kindStepIndex('Run plan', 'task'), 'task')
  assert.deepEqual(store.restartPhase('K-RESTART', 1, 'try again'), { ok: true })
  assert.equal(store.getItem('K-RESTART').cursor, kindStepIndex('Assess', 'task'))
})

test('a send-back from a task gate walks to that kind\'s nearest agent step', () => {
  insertItem.run('K-SENDBACK', 'Task send-back', 'Medium', kindStepIndex('Approve the run', 'task'), 'task')
  assert.deepEqual(store.requestChanges('K-SENDBACK', 'run gate', 'needs work'), { ok: true })
  assert.equal(store.getItem('K-SENDBACK').cursor, kindStepIndex('Impact review', 'task'))
})

test('a send-back naming a change step from a task gate is an invalid target', () => {
  insertItem.run('K-CROSS', 'Task cross-kind target', 'Medium', kindStepIndex('Approve the run', 'task'), 'task')
  assert.deepEqual(store.requestChanges('K-CROSS', 'run gate', 'wrong kind', 'You', IMPLEMENT_STEP_INDEX), {
    error: 'invalid_target',
  })
  assert.equal(store.getItem('K-CROSS').cursor, kindStepIndex('Approve the run', 'task'))
})

test('approving a task gate advances within the task rows', () => {
  const gate = kindStepIndex('Approve the run', 'task')
  insertItem.run('K-ADVANCE', 'Task advance', 'Medium', gate, 'task')
  assert.deepEqual(store.approveGate('K-ADVANCE', gate, ''), { ok: true, closed: false })
  assert.equal(store.getItem('K-ADVANCE').cursor, kindStepIndex('Execute', 'task'))
})

test('a closed task reports its own final phase, not the change one', () => {
  assert.equal(
    phaseIdx({ cursor: endIndex('task'), kind: 'task' }),
    phasesFor('task').length - 1,
  )
  assert.equal(isClosed({ cursor: firstStepIndex('task'), kind: 'task' }), false)
})
