// HZ-128 guardrail 9: "do not rename, reorder, add or remove a step, or change
// any step label."
//
// PERMANENT. This file is the one place the labels are written out by hand,
// in order, so a change to domain/steps.json that renames or reorders a step
// fails here rather than propagating silently through a regenerated binding.
// It replaces the throwaway fidelity check that proved domain/steps.json was
// byte-equal to the old server/src/lifecycle.js at the moment of the move —
// that file could only be written once, this one holds forever.
//
// HZ-377 is the approved exception to "do not add a step": it appends the 11
// task rows after the 16 change rows, pinned below in PINNED_TASK with the
// same hand-written rationale.
//
// HZ-446 is the second: it appends the 12 plan rows (owner-approved 14 Oct)
// after the task rows, pinned in PINNED_PLAN. PINNED and PINNED_TASK are
// unchanged.
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
  APPROVE_FILE_GATE_INDEX,
  gateStepIndexes,
  humanOnlyGateIndexes,
  isHumanOnlyGate,
  isServerStep,
  phasesFor,
  stepsFor,
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

// HZ-377: the task lifecycle, appended after every change row — same
// hand-written rationale as PINNED, so a rename or reorder fails here.
const PINNED_TASK = [
  ['Define the outcome', 0, 'agent'],
  ["How we'll verify", 0, 'agent'],
  ['Guardrails', 0, 'agent'],
  ['Approve & prioritize', 0, 'gate'],
  ['Assess', 1, 'agent'],
  ['Run plan', 1, 'agent'],
  ['Impact review', 1, 'agent'],
  ['Approve the run', 1, 'gate'],
  ['Execute', 2, 'agent'],
  ['Verify & report', 2, 'agent'],
  ['Review & close', 3, 'gate'],
]

// HZ-446: the plan lifecycle, appended after every task row — same
// hand-written rationale as PINNED.
const PINNED_PLAN = [
  ['Define the question', 0, 'agent'],
  ['Set guardrails', 0, 'agent'],
  ['Approve & prioritize', 0, 'gate'],
  ['Inventory current state', 1, 'agent'],
  ['Design options & recommendation', 2, 'agent'],
  ['Approve the design', 2, 'gate'],
  ['Draft items', 3, 'agent'],
  ['Review drafts: coverage & overlap', 3, 'agent'],
  ['Review drafts: metrics & size', 3, 'agent'],
  ['Approve & file', 3, 'gate'],
  ['File items', 4, 'agent'],
  ['Review & close', 4, 'gate'],
]

test('the pipeline is exactly 16 change steps plus 11 task steps plus 12 plan steps', () => {
  assert.equal(PINNED.length, 16)
  assert.equal(PINNED_TASK.length, 11)
  assert.equal(PINNED_PLAN.length, 12)
  assert.equal(STEPS.length, PINNED.length + PINNED_TASK.length + PINNED_PLAN.length)
})

test('every step keeps its label, phase and kind, at its own position', () => {
  PINNED.forEach(([label, phase, kind], i) => {
    assert.equal(STEPS[i].label, label, `step ${i} is "${STEPS[i].label}", pinned as "${label}"`)
    assert.equal(STEPS[i].phase, phase, `step ${i} ("${label}") moved phase`)
    assert.equal(STEPS[i].kind, kind, `step ${i} ("${label}") changed kind`)
  })
  PINNED_TASK.forEach(([label, phase, kind], j) => {
    const i = PINNED.length + j
    assert.equal(STEPS[i].label, label, `step ${i} is "${STEPS[i].label}", pinned as "${label}"`)
    assert.equal(STEPS[i].phase, phase, `step ${i} ("${label}") moved phase`)
    assert.equal(STEPS[i].kind, kind, `step ${i} ("${label}") changed kind`)
  })
})

test('HZ-446: the plan rows keep their order, phases and kinds, after every task row', () => {
  const first = PINNED.length + PINNED_TASK.length
  assert.deepEqual(
    stepsFor('plan').map((s) => [s.label, s.phase, s.kind]),
    PINNED_PLAN,
  )
  assert.equal(stepsFor('plan')[0].index, first)
  assert.deepEqual(phasesFor('plan'), ['Scope', 'Inventory', 'Design', 'Draft', 'File'])
})

test('HZ-446: the plan has four human gates, and only Approve & file is human-only', () => {
  assert.deepEqual(gateStepIndexes(STEPS, 'plan'), [29, 32, 36, 38])
  assert.deepEqual(
    gateStepIndexes(STEPS, 'plan').map((i) => STEPS[i].label),
    ['Approve & prioritize', 'Approve the design', 'Approve & file', 'Review & close'],
  )
  assert.equal(APPROVE_FILE_GATE_INDEX, 36)
  assert.equal(isHumanOnlyGate(36), true)
  assert.deepEqual(
    humanOnlyGateIndexes().filter((i) => STEPS[i].itemKind === 'plan'),
    [36],
  )
})

test('HZ-446: a plan never runs a job, never mutates a workspace, and files on the server lane', () => {
  for (const step of stepsFor('plan')) {
    assert.notEqual(step.runsIn, 'job', `plan step "${step.label}" runs a job`)
    assert.notEqual(step.workspaceMutating, true, `plan step "${step.label}" mutates a workspace`)
  }
  assert.deepEqual(
    stepsFor('plan').filter((s) => isServerStep(s.index)).map((s) => [s.index, s.label]),
    [[37, 'File items']],
  )
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
    // HZ-383: a Task's three read-only planning steps, provider-locked.
    Assess: [40, 1140, false, false, true],
    'Run plan': [40, 1140, false, false, true],
    'Impact review': [40, 1140, false, false, true],
    // HZ-378: Verify & report, read-only QA.
    'Verify & report': [40, 1140, false, false, true],
    // HZ-446: a Plan's read-only farm steps, provider-locked.
    'Inventory current state': [40, 1140, false, false, true],
    'Design options & recommendation': [40, 1140, false, false, true],
    'Draft items': [40, 1140, false, false, true],
    'Review drafts: coverage & overlap': [40, 1140, false, false, true],
    'Review drafts: metrics & size': [40, 1140, false, false, true],
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
    // HZ-383: each later Task planning step reads the earlier ones whole.
    'Run plan': ['Assess'],
    'Impact review': ['Assess', 'Run plan'],
  })
})
