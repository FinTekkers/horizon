// HZ-540: domain/js/substeps.js, the one reader of an item's sub-step
// snapshot. An item with no snapshot reads [] and null everywhere, so every
// caller falls through to the global step.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { STEPS, ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } from '../../domain/js/lifecycle.js'
import { currentSubstep, decodeTarget, encodeTarget, stepLabel, substepReworkTargets, substepsAt, substepsOf } from '../../domain/js/substeps.js'

const OPENING = { id: 'golden-cases', label: 'Golden test cases', anchor: 1 }
const AUDIT = { id: 'impl-audit', label: 'Audit the change', anchor: IMPLEMENT_STEP_INDEX }

test('the snapshot reads from the served list or the raw column, and junk reads as none', () => {
  assert.deepEqual(substepsOf({ substeps: [OPENING, AUDIT] }), [OPENING, AUDIT])
  assert.deepEqual(substepsOf({ substeps_json: JSON.stringify([OPENING, AUDIT]) }), [OPENING, AUDIT])
  for (const item of [{}, null, { substeps_json: null }, { substeps_json: '{bad' }, { substeps_json: '{}' }]) assert.deepEqual(substepsOf(item), [])
  assert.deepEqual(substepsOf({ substeps: [OPENING, { id: 'no-label', anchor: 1 }] }), [OPENING])
  assert.deepEqual(substepsAt({ substeps: [OPENING, AUDIT] }, 1), [OPENING])
})

test('the item is at a sub-step only while its cursor is on that sub-step’s anchor', () => {
  const at = { cursor: IMPLEMENT_STEP_INDEX, substeps: [OPENING, AUDIT], substep_cursor: 'impl-audit' }
  assert.equal(currentSubstep(at), AUDIT)
  assert.equal(stepLabel(at), 'Audit the change')
  assert.equal(stepLabel(at, 1), STEPS[1].label)
  for (const item of [{ ...at, cursor: IMPLEMENT_STEP_INDEX + 1 }, { ...at, substep_cursor: null }, { ...at, substep_cursor: 'gone' }, { cursor: IMPLEMENT_STEP_INDEX }]) {
    assert.equal(currentSubstep(item), null)
    assert.equal(stepLabel(item), STEPS[item.cursor].label)
  }
})

test('send-back targets: sub-steps of the gate’s own legal targets, and none off a gate', () => {
  const item = { cursor: ACCEPT_GATE_INDEX, kind: 'change', substeps: [OPENING, AUDIT] }
  assert.deepEqual(substepReworkTargets(item), [
    { index: 1, substepId: 'golden-cases', label: 'Golden test cases' },
    { index: IMPLEMENT_STEP_INDEX, substepId: 'impl-audit', label: 'Audit the change' },
  ])
  assert.deepEqual(substepReworkTargets({ ...item, cursor: IMPLEMENT_STEP_INDEX }), [])
  assert.deepEqual(substepReworkTargets({ ...item, substeps: undefined }), [])
})

test('a picker value round-trips', () => {
  assert.equal(encodeTarget({ index: 11 }), '11')
  assert.equal(encodeTarget({ index: 11, substepId: 'impl-audit' }), '11:impl-audit')
  assert.deepEqual(decodeTarget('11'), { index: 11, substepId: null })
  assert.deepEqual(decodeTarget('11:impl-audit'), { index: 11, substepId: 'impl-audit' })
  for (const value of ['', null, 'x', 'x:y']) assert.equal(decodeTarget(value), null)
})
