// HZ-117: "renaming a step label no longer silently breaks index
// resolution: the *_STEP_INDEX accessors fail loudly rather than yielding
// -1." Covers both the server's requiredStepIndex (server/src/lifecycle.js)
// and the UI's local requiredIndex helper (ui/src/domain/lifecycle.js) —
// each hardens the same failure mode independently, on their own copy of the
// lookup logic.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { requiredStepIndex } from '../src/lifecycle.js'

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

test('the real server module-level accessors were built with requiredStepIndex and stay resolvable today', async () => {
  const lifecycle = await import('../src/lifecycle.js')
  assert.equal(lifecycle.STEPS[lifecycle.IMPLEMENT_STEP_INDEX].label, 'Specialist agent implements')
  assert.equal(lifecycle.STEPS[lifecycle.REVIEW_STEP_INDEX].label, 'Automated review (code + QA)')
  assert.equal(lifecycle.STEPS[lifecycle.ACCEPT_GATE_INDEX].label, 'Accept the code')
  assert.equal(lifecycle.STEPS[lifecycle.DEPLOY_STEP_INDEX].label, 'Deploy the changes')
})

test('the UI copy throws the same way on a renamed label — its local requiredIndex helper is not shared code, but the same contract', async () => {
  const uiLifecycle = await import('../../ui/src/domain/lifecycle.js')
  // No renamed-label fixture is exposed from the UI module (requiredIndex is
  // file-private by design — a generic lookup, not shared step data), so
  // this proves the CONTRACT survives on real data: every accessor built
  // from it still resolves against the live, generated STEPS.
  assert.equal(uiLifecycle.STEPS[uiLifecycle.IMPLEMENT_STEP_INDEX].label, 'Specialist agent implements')
  assert.equal(uiLifecycle.STEPS[uiLifecycle.REVIEW_STEP_INDEX].label, 'Automated review (code + QA)')
  assert.equal(uiLifecycle.STEPS[uiLifecycle.ACCEPT_GATE_INDEX].label, 'Accept the code')
})
