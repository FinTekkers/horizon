// HZ-51: the send-back destination picker is built from these two helpers —
// pin them directly so a future STEPS insertion/reorder can't silently widen
// or narrow what a human is offered, or drift from the server's own rule
// (STEPS[i].kind === 'agent' && i < gateIndex, no hardcoded positions).
//
// HZ-128: these helpers moved to domain/js/lifecycle.js — one copy, shared
// with the server. The picker is a UI concern, so its rules stay pinned from
// the UI suite; the lookup is now requiredStepIndex(label, steps), the
// server's name and argument order (the UI's requiredIndex(steps, label) was
// the discarded half of that split).

import { expect, test } from 'vitest'
import {
  STEPS,
  ACCEPT_GATE_INDEX,
  IMPLEMENT_STEP_INDEX,
  reworkTargets,
  defaultReworkTarget,
  requiredStepIndex,
} from '../../../domain/js/lifecycle.js'

const PRE_EXECUTION_GATE_INDEX = STEPS.findIndex((s) => s.label === 'Review before execution')

const FABRICATED_STEPS = [
  { phase: 0, kind: 'agent', agent: 'PM', label: 'Define the outcome', runsIn: 'pm' },
  { phase: 2, kind: 'gate', gate: 'required', label: 'Accept the code' },
]

test('requiredStepIndex resolves a label that is actually present', () => {
  expect(requiredStepIndex('Accept the code', FABRICATED_STEPS)).toBe(1)
})

test('requiredStepIndex throws — never returns -1 — for a label that was renamed out from under it', () => {
  expect(() => requiredStepIndex('Accept the code', [FABRICATED_STEPS[0]])).toThrow(/no step labeled/)
})

test('requiredStepIndex names the missing label in its error, so the failure is actionable', () => {
  expect(() => requiredStepIndex('This Label Does Not Exist', FABRICATED_STEPS)).toThrow(/This Label Does Not Exist/)
})

test('reworkTargets offers every agent step strictly earlier than the gate, and nothing else', () => {
  const options = reworkTargets(PRE_EXECUTION_GATE_INDEX)
  expectAllEarlierAgentSteps(options, PRE_EXECUTION_GATE_INDEX)
})

function expectAllEarlierAgentSteps(options, gateIndex) {
  // Targets stay inside the gate's own kind: phase numbers and labels repeat
  // across kinds, so only the gate's kind counts here (HZ-377).
  const kind = STEPS[gateIndex].itemKind ?? 'change'
  expect(options.every(({ index }) => index < gateIndex)).toBe(true)
  expect(options.every(({ index }) => STEPS[index].kind === 'agent')).toBe(true)
  expect(options.every(({ index }) => (STEPS[index].itemKind ?? 'change') === kind)).toBe(true)
  const expectedCount = STEPS.filter((s, i) => i < gateIndex && s.kind === 'agent' && (s.itemKind ?? 'change') === kind).length
  expect(options.length).toBe(expectedCount)
}

test('reworkTargets never offers a gate or a step at/after the gate itself', () => {
  const options = reworkTargets(PRE_EXECUTION_GATE_INDEX)
  expect(options.some(({ index }) => STEPS[index].kind === 'gate')).toBe(false)
  expect(options.some(({ index }) => index >= PRE_EXECUTION_GATE_INDEX)).toBe(false)
})

test('reworkTargets sweeps every gate in the pipeline, not just one', () => {
  STEPS.forEach((step, i) => {
    if (step.kind !== 'gate') return
    expectAllEarlierAgentSteps(reworkTargets(i), i)
  })
})

test('defaultReworkTarget mirrors the server: Accept-the-code routes to implement', () => {
  expect(defaultReworkTarget(ACCEPT_GATE_INDEX)).toBe(IMPLEMENT_STEP_INDEX)
})

test('defaultReworkTarget mirrors the server: any other gate walks back to the nearest agent step', () => {
  expect(defaultReworkTarget(PRE_EXECUTION_GATE_INDEX)).toBe(PRE_EXECUTION_GATE_INDEX - 1)
  expect(STEPS[defaultReworkTarget(PRE_EXECUTION_GATE_INDEX)].kind).toBe('agent')
})
