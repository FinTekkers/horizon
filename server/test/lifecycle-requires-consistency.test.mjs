// HZ-105 success metric: "each step declares its required inputs explicitly,
// and a test asserts every step's declaration is consistent with STEPS (no
// step requires an artifact that cannot exist by then)." A step's `requires`
// entry is only meaningful if it names a real step that necessarily ran
// before it — this file is the guard against a future edit renaming or
// reordering a step without updating the steps that depend on it.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { STEPS, requiredStepIndex } from '../../domain/js/lifecycle.js'

const stepsWithRequires = STEPS.map((s, index) => ({ ...s, index })).filter((s) => s.requires?.length)

test('sanity: at least one step declares requires, or this file is testing nothing', () => {
  assert.ok(stepsWithRequires.length > 0)
})

test('every requires label resolves to a real STEPS entry', () => {
  for (const step of stepsWithRequires) {
    for (const label of step.requires) {
      // requiredStepIndex throws (rather than returning -1) if the label
      // doesn't resolve — that throw itself is the assertion here.
      assert.doesNotThrow(
        () => requiredStepIndex(label),
        `"${step.label}" requires "${label}", which is not a step in STEPS`,
      )
    }
  }
})

test('every required artifact necessarily exists before the requiring step runs', () => {
  for (const step of stepsWithRequires) {
    for (const label of step.requires) {
      const dependencyIndex = requiredStepIndex(label)
      assert.ok(
        dependencyIndex < step.index,
        `"${step.label}" (index ${step.index}) requires "${label}" (index ${dependencyIndex}), which has not necessarily run yet`,
      )
    }
  }
})

test('a required step is an agent step that actually produces an artifact, not a gate', () => {
  for (const step of stepsWithRequires) {
    for (const label of step.requires) {
      const dependencyIndex = requiredStepIndex(label)
      assert.equal(STEPS[dependencyIndex].kind, 'agent', `"${label}" is a gate — gates never produce an artifact`)
    }
  }
})
