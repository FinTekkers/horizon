// HZ-51: the send-back destination picker is built from these two helpers —
// pin them directly so a future STEPS insertion/reorder can't silently widen
// or narrow what a human is offered, or drift from the server's own rule
// (STEPS[i].kind === 'agent' && i < gateIndex, no hardcoded positions).

import { expect, test } from 'vitest'
import { STEPS, ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX, reworkTargets, defaultReworkTarget } from './lifecycle'

const PRE_EXECUTION_GATE_INDEX = STEPS.findIndex((s) => s.label === 'Review before execution')

test('reworkTargets offers every agent step strictly earlier than the gate, and nothing else', () => {
  const options = reworkTargets(PRE_EXECUTION_GATE_INDEX)
  expectAllEarlierAgentSteps(options, PRE_EXECUTION_GATE_INDEX)
})

function expectAllEarlierAgentSteps(options, gateIndex) {
  expect(options.every(({ index }) => index < gateIndex)).toBe(true)
  expect(options.every(({ index }) => STEPS[index].kind === 'agent')).toBe(true)
  const expectedCount = STEPS.filter((s, i) => i < gateIndex && s.kind === 'agent').length
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
