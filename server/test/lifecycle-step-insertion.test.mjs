// HZ-117 success metric: "a test inserts a step into the table and asserts
// nothing needs a literal index changed anywhere — lane routing, workspace
// mutation, turn budgets and provider eligibility all follow the new step
// automatically." This is the JS half (domain/js/lifecycle.js's derived
// lookups); the farm half (the farm-shaped projection, lane routing, workspace
// mutation, turn budgets, provider eligibility) is proven the same way in
// farm/tests/test_steps_insertion.py.
//
// Every assertion below reads an inserted/shifted step back off the
// fabricated table by its own label — no production step index (11, 12,
// 14, ...) is ever written in this file.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { agentStepIndexes, requiredStepIndex } from '../../domain/js/lifecycle.js'

const EXISTING_FARM_STEP = {
  phase: 0,
  kind: 'agent',
  agent: 'Eng',
  label: 'Existing Farm Step',
  runsIn: 'farm',
  workspaceMutating: false,
  providerOverrideEligible: true,
  providerLocked: false,
  maxTurns: 10,
  timeoutS: 100,
}

const INSERTED_STEP = {
  phase: 0,
  kind: 'agent',
  agent: 'Eng',
  label: 'Inserted Between Two Existing Steps',
  runsIn: 'farm',
  workspaceMutating: true,
  providerOverrideEligible: false,
  providerLocked: true,
  maxTurns: 77,
  timeoutS: 777,
}

const EXISTING_GATE = { phase: 0, kind: 'gate', gate: 'required', label: 'Existing Gate' }

const BEFORE_INSERT = [EXISTING_FARM_STEP, EXISTING_GATE]
const AFTER_INSERT = [EXISTING_FARM_STEP, INSERTED_STEP, EXISTING_GATE]

test('requiredStepIndex resolves the inserted step by label alone, no hardcoded position', () => {
  const idx = requiredStepIndex(INSERTED_STEP.label, AFTER_INSERT)
  assert.equal(AFTER_INSERT[idx], INSERTED_STEP)
})

test('inserting a step shifts a later step forward, and every existing lookup follows automatically', () => {
  const gateIndexBefore = BEFORE_INSERT.findIndex((s) => s.label === EXISTING_GATE.label)
  const gateIndexAfter = AFTER_INSERT.findIndex((s) => s.label === EXISTING_GATE.label)

  assert.equal(requiredStepIndex(EXISTING_GATE.label, BEFORE_INSERT), gateIndexBefore)
  assert.equal(requiredStepIndex(EXISTING_GATE.label, AFTER_INSERT), gateIndexAfter)
  assert.ok(gateIndexAfter > gateIndexBefore, 'the insertion must have shifted the later step forward')
})

test('agentStepIndexes includes the inserted step the moment it is added, with no allowlist to update', () => {
  const insertedIndex = AFTER_INSERT.findIndex((s) => s.label === INSERTED_STEP.label)
  assert.ok(agentStepIndexes(AFTER_INSERT).includes(insertedIndex))
})

// HZ-128 deleted toUiSteps along with the UI's separate generated JSON: the
// one JS binding now carries domain/steps.json's authored entries verbatim, so
// there is no second JS projection left to derive or test. Which shape shipped
// is pinned instead by domain-binding-hygiene.test.mjs — including the fact
// that the JS view now DOES carry the farm-only fields the old toUiSteps
// dropped.
//
// HZ-139 deleted the generator, and with it the farm-shaped projection this
// file used to assert here (toGeneratedSteps). That projection is now Python —
// domain/py/steps.py's _project_farm_view — and the same scenario, on the same
// fabricated 3-entry table, is asserted against the implementation that owns it
// in farm/tests/test_steps_insertion.py's
// test_project_farm_view_carries_the_inserted_step_at_its_own_index. Coverage
// moved languages; it was not dropped.
