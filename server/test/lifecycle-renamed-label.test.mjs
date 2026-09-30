// HZ-117: "renaming a step label no longer silently breaks index
// resolution: the *_STEP_INDEX accessors fail loudly rather than yielding
// -1."
//
// HZ-128 collapsed the two lookup helpers into one. There used to be a second
// test here pinning the UI copy's accessors against its own generated table;
// with a single domain/js/lifecycle.js it became a byte-duplicate of the
// real-accessors test below, so it is retired. The fabricated-table throw path
// is still covered from the UI suite too (ui/src/domain/lifecycle.test.js),
// against the same one helper.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { requiredStepIndex } from '../../domain/js/lifecycle.js'

const FABRICATED_STEPS = [
  { phase: 0, kind: 'agent', agent: 'PM', label: 'Define the outcome', runsIn: 'pm' },
  { phase: 2, kind: 'gate', gate: 'required', label: 'Accept the code' },
]

test('requiredStepIndex resolves a label that is actually present', () => {
  assert.equal(requiredStepIndex('Accept the code', FABRICATED_STEPS), 1)
})

test('requiredStepIndex throws — never returns -1 — for a label that was renamed out from under it', () => {
  assert.throws(() => requiredStepIndex('Accept the code', [FABRICATED_STEPS[0]]), /no step labeled/)
})

test('requiredStepIndex names the missing label in its error, so the failure is actionable', () => {
  assert.throws(
    () => requiredStepIndex('This Label Does Not Exist', FABRICATED_STEPS),
    /This Label Does Not Exist/,
  )
})

test('the real module-level accessors were built with requiredStepIndex and stay resolvable today', async () => {
  const lifecycle = await import('../../domain/js/lifecycle.js')
  assert.equal(lifecycle.STEPS[lifecycle.IMPLEMENT_STEP_INDEX].label, 'Specialist agent implements')
  assert.equal(lifecycle.STEPS[lifecycle.REVIEW_STEP_INDEX].label, 'Automated review (code + QA)')
  assert.equal(lifecycle.STEPS[lifecycle.ACCEPT_GATE_INDEX].label, 'Accept the code')
  assert.equal(lifecycle.STEPS[lifecycle.DEPLOY_STEP_INDEX].label, 'Deploy the changes')
})
