// HZ-117 success metric: "a test inserts a step into the table and asserts
// nothing needs a literal index changed anywhere — lane routing, workspace
// mutation, turn budgets and provider eligibility all follow the new step
// automatically." This is the JS half (server/src/lifecycle.js's own derived
// views); the farm half (lane routing, workspace mutation, turn budgets,
// provider eligibility) is proven the same way in
// farm/tests/test_steps_insertion.py.
//
// Every assertion below reads an inserted/shifted step back off the
// fabricated table by its own label — no production step index (11, 12,
// 14, ...) is ever written in this file.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { agentStepIndexes, requiredStepIndex, toGeneratedSteps, toUiSteps } from '../src/lifecycle.js'

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

test('toGeneratedSteps carries the inserted step at its own computed index with its own fields, untouched by neighbors', () => {
  const generated = toGeneratedSteps(AFTER_INSERT)
  const insertedIndex = AFTER_INSERT.findIndex((s) => s.label === INSERTED_STEP.label)
  const entry = generated.find((g) => g.label === INSERTED_STEP.label)

  assert.ok(entry, 'the inserted farm step must appear in the generated view')
  assert.equal(entry.index, insertedIndex)
  assert.equal(entry.workspaceMutating, INSERTED_STEP.workspaceMutating)
  assert.equal(entry.providerOverrideEligible, INSERTED_STEP.providerOverrideEligible)
  assert.equal(entry.providerLocked, INSERTED_STEP.providerLocked)
  assert.equal(entry.maxTurns, INSERTED_STEP.maxTurns)
  assert.equal(entry.timeoutS, INSERTED_STEP.timeoutS)

  // The pre-existing step's own fields must be unaffected by the insertion.
  const existingEntry = generated.find((g) => g.label === EXISTING_FARM_STEP.label)
  assert.equal(existingEntry.maxTurns, EXISTING_FARM_STEP.maxTurns)
})

test('toUiSteps places the inserted step at its own index, both kinds included, no presentation tokens', () => {
  const ui = toUiSteps(AFTER_INSERT)
  const insertedIndex = AFTER_INSERT.findIndex((s) => s.label === INSERTED_STEP.label)

  assert.equal(ui.length, AFTER_INSERT.length)
  assert.equal(ui[insertedIndex].label, INSERTED_STEP.label)
  assert.equal(ui[insertedIndex].kind, 'agent')
  assert.ok(!('color' in ui[insertedIndex]), 'toUiSteps must never carry presentation tokens')
  assert.ok(!('maxTurns' in ui[insertedIndex]), 'toUiSteps must never carry farm-only budget fields')
})
