// HZ-128 guardrail 9: "do not rename, reorder, add or remove a step, or change
// any step label."
//
// PERMANENT. This file is the one place the 16 labels are written out by hand,
// in order, so a change to domain/steps.json that renames or reorders a step
// fails here rather than propagating silently through a regenerated binding.
// It replaces the throwaway fidelity check that proved domain/steps.json was
// byte-equal to the old server/src/lifecycle.js at the moment of the move —
// that file could only be written once, this one holds forever.
//
// Every other step test derives what it expects. This one does not, on purpose:
// a table that derives its own expectations cannot catch a deliberate edit.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  STEPS,
  PHASES,
  IMPLEMENT_STEP_INDEX,
  REVIEW_STEP_INDEX,
  ACCEPT_GATE_INDEX,
  DEPLOY_STEP_INDEX,
} from '../../domain/js/lifecycle.js'

// [label, phase, kind] — hand-written, in pipeline order.
const PINNED = [
  ['Define the outcome', 0, 'agent'],
  ['Define how we measure success', 0, 'agent'],
  ['Set guardrails', 0, 'agent'],
  ['Approve & prioritize this work', 0, 'gate'],
  ['Plan options & trade-offs (pros / cons)', 1, 'agent'],
  ['Approve the high-level design', 1, 'gate'],
  ['Draft implementation plan', 1, 'agent'],
  ['Architecture review', 1, 'agent'],
  ['QA reviews the test plan', 1, 'agent'],
  ['Summarize reviews & recommend', 1, 'agent'],
  ['Review before execution', 1, 'gate'],
  ['Specialist agent implements', 2, 'agent'],
  ['Automated review (code + QA)', 2, 'agent'],
  ['Accept the code', 2, 'gate'],
  ['Deploy the changes', 3, 'agent'],
  ['Review the work & close', 4, 'gate'],
]

test('the pipeline is exactly 16 steps', () => {
  assert.equal(STEPS.length, 16)
  assert.equal(PINNED.length, 16)
})

test('every step keeps its label, phase and kind, at its own position', () => {
  PINNED.forEach(([label, phase, kind], i) => {
    assert.equal(STEPS[i].label, label, `step ${i} is "${STEPS[i].label}", pinned as "${label}"`)
    assert.equal(STEPS[i].phase, phase, `step ${i} ("${label}") moved phase`)
    assert.equal(STEPS[i].kind, kind, `step ${i} ("${label}") changed kind`)
  })
})

test('the five phases keep their names and order', () => {
  assert.deepEqual(PHASES, ['Plan', 'Technical Plan', 'Execute', 'Deploy', 'Review'])
})

test('every derived index still resolves to the step it is named for', () => {
  assert.equal(STEPS[IMPLEMENT_STEP_INDEX].label, 'Specialist agent implements')
  assert.equal(STEPS[REVIEW_STEP_INDEX].label, 'Automated review (code + QA)')
  assert.equal(STEPS[ACCEPT_GATE_INDEX].label, 'Accept the code')
  assert.equal(STEPS[DEPLOY_STEP_INDEX].label, 'Deploy the changes')
})

test('every gate is required, and no gate carries an agent or a lane', () => {
  for (const step of STEPS) {
    if (step.kind !== 'gate') continue
    assert.equal(step.gate, 'required', `gate "${step.label}" is no longer required`)
    assert.ok(!('agent' in step))
    assert.ok(!('runsIn' in step))
  }
})

test('the farm-lane steps keep their turn budgets and provider rules', () => {
  // Hand-written, same rationale as the label pins: a budget silently halved
  // is a behaviour change nobody would notice from a derived assertion.
  const PINNED_BUDGETS = {
    'Plan options & trade-offs (pros / cons)': [40, 1140, false, true, false],
    'Draft implementation plan': [40, 1140, false, true, false],
    'Architecture review': [40, 1140, false, true, false],
    'QA reviews the test plan': [40, 1140, false, true, false],
    'Specialist agent implements': [160, 2700, true, true, false],
    'Automated review (code + QA)': [60, 1800, true, true, false],
    'Deploy the changes': [40, 900, false, false, true],
  }
  const farmSteps = STEPS.filter((s) => s.runsIn === 'farm')
  assert.equal(farmSteps.length, Object.keys(PINNED_BUDGETS).length)
  for (const step of farmSteps) {
    const pinned = PINNED_BUDGETS[step.label]
    assert.ok(pinned, `farm-lane step "${step.label}" is not pinned here`)
    const [maxTurns, timeoutS, workspaceMutating, providerOverrideEligible, providerLocked] = pinned
    assert.equal(step.maxTurns, maxTurns, `"${step.label}" maxTurns`)
    assert.equal(step.timeoutS, timeoutS, `"${step.label}" timeoutS`)
    assert.equal(step.workspaceMutating, workspaceMutating, `"${step.label}" workspaceMutating`)
    assert.equal(step.providerOverrideEligible, providerOverrideEligible, `"${step.label}" providerOverrideEligible`)
    assert.equal(step.providerLocked, providerLocked, `"${step.label}" providerLocked`)
  }
})

test('the two review steps keep their declared required inputs', () => {
  const requires = Object.fromEntries(STEPS.filter((s) => s.requires).map((s) => [s.label, s.requires]))
  assert.deepEqual(requires, {
    'Architecture review': ['Draft implementation plan'],
    'QA reviews the test plan': ['Draft implementation plan'],
  })
})
