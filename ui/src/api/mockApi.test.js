// Parity tests for mockApi's requestChanges against the server's
// store.js requestChanges (HZ-51): explicit-target routing, the Accept-gate
// exception, and server-side-style validation must not diverge, or mock mode
// stops being a faithful stand-in for the real backend.
//
// Each test claims one seeded fixture item and never revisits it, since
// `items` is module-level state shared across tests in this file.

import { expect, test } from 'vitest'
import { requestChanges, getItems } from './mockApi'
import { STEPS, ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } from '../domain/lifecycle'

const findItem = (id) => getItems().find((it) => it.id === id)

const PRE_EXECUTION_GATE_INDEX = STEPS.findIndex((s) => s.label === 'Review before execution')

test('no target: rejecting the Accept-the-code gate sends the item to implement, not the nearest agent step (Review)', () => {
  const before = findItem('BF-097')
  expect(before.cursor).toBe(ACCEPT_GATE_INDEX)
  requestChanges('BF-097', 'Accept the code', 'this has a bug')
  expect(findItem('BF-097').cursor).toBe(IMPLEMENT_STEP_INDEX)
})

test('no target: rejecting any other gate still walks back to the nearest agent step', () => {
  const before = findItem('BF-128')
  const gateIdx = before.cursor
  expect(STEPS[gateIdx].kind).toBe('gate')
  requestChanges('BF-128', 'target label', 'needs another pass')
  const after = findItem('BF-128')
  expect(after.cursor).toBeLessThan(gateIdx)
  expect(STEPS[after.cursor].kind).toBe('agent')
})

test('explicit target: a send-back can name a specific earlier agent step directly', () => {
  const before = findItem('BF-140')
  expect(before.cursor).toBe(PRE_EXECUTION_GATE_INDEX)
  const draftPlanIdx = STEPS.findIndex((s) => s.label === 'Draft implementation plan')
  requestChanges('BF-140', 'Review before execution', 'the plan skips a step', draftPlanIdx)
  expect(findItem('BF-140').cursor).toBe(draftPlanIdx)
})

test('invalid target: pointing at a gate instead of an agent step is a no-op', () => {
  const before = findItem('BF-131')
  const gateIdx = before.cursor
  const targetGateIdx = STEPS.findIndex((s, i) => i < gateIdx && s.kind === 'gate')
  requestChanges('BF-131', 'x', 'y', targetGateIdx)
  expect(findItem('BF-131').cursor).toBe(gateIdx) // unchanged
})

test('invalid target: at or after the current gate is a no-op (no forward moves, no same-gate loops)', () => {
  const before = findItem('BF-090')
  const gateIdx = before.cursor
  requestChanges('BF-090', 'x', 'y', gateIdx)
  expect(findItem('BF-090').cursor).toBe(gateIdx)
})

test('invalid target: supplied while the item is mid agent-step (not parked at a gate) is a no-op', () => {
  const before = findItem('BF-119')
  expect(STEPS[before.cursor].kind).toBe('agent')
  requestChanges('BF-119', 'x', 'y', 0)
  expect(findItem('BF-119').cursor).toBe(before.cursor)
})
