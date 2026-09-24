// itemStatus() is the single place the board card, tracker header and status
// pill all read from — HZ-59 needs Abandoned to render as its own terminal
// state, never collapsing into Closed or any of the other statuses.

import { expect, test } from 'vitest'
import { itemStatus } from './status'
import { STEPS } from './lifecycle'

const base = { cursor: 0, paused: false, rejected: false, abandoned_at: null }

test('an abandoned item reads Abandoned, not Closed, even once its old cursor reached the end', () => {
  const item = { ...base, cursor: STEPS.length, abandoned_at: '2026-01-01 00:00:00' }
  const status = itemStatus(item)
  expect(status.label).toBe('Abandoned')
  expect(status).not.toEqual(itemStatus({ ...base, cursor: STEPS.length }))
})

test('an abandoned item mid-pipeline reads Abandoned, not the current agent or gate label', () => {
  const onAgentStep = { ...base, cursor: 11, abandoned_at: '2026-01-01 00:00:00' }
  expect(itemStatus(onAgentStep).label).toBe('Abandoned')

  const onGateStep = { ...base, cursor: 3, abandoned_at: '2026-01-01 00:00:00' }
  expect(itemStatus(onGateStep).label).toBe('Abandoned')
})

test('abandoned takes priority over paused and rejected — it is the more final state', () => {
  const item = { ...base, cursor: 11, abandoned_at: '2026-01-01 00:00:00', paused: true, rejected: true }
  expect(itemStatus(item).label).toBe('Abandoned')
})

test('a non-abandoned item is unaffected — abandoned_at absent reads as before', () => {
  const closed = { ...base, cursor: STEPS.length }
  expect(itemStatus(closed).label).toBe('Closed')
  const onGate = { ...base, cursor: 3 }
  expect(itemStatus(onGate, true).label).toBe('Awaiting your approval')
})

// HZ-54: a dispatched step must read distinctly as queued vs running, driven
// only by item.activeRun.state (never tmux/session details) and defaulting
// to today's "working" presentation whenever that field is absent — a farm
// that's down, old, or hasn't polled yet must never make the board look
// wrong or stalled.

import { expect, test } from 'vitest'
import { itemStatus, isQueued } from './status'

const baseItem = {
  id: 'T-1',
  cursor: 11, // "Specialist agent implements" — an Eng agent step
  paused: false,
  rejected: false,
  activeRun: null,
}

test('isQueued is false with no activeRun at all', () => {
  expect(isQueued(baseItem)).toBe(false)
})

test('isQueued is false when the farm reports the run as running', () => {
  const item = { ...baseItem, activeRun: { step_index: 11, state: 'running' } }
  expect(isQueued(item)).toBe(false)
})

test('isQueued is true only when the farm explicitly reports queued for the current step', () => {
  const item = { ...baseItem, activeRun: { step_index: 11, state: 'queued', reason: 'waiting for a free agent slot' } }
  expect(isQueued(item)).toBe(true)
})

test('isQueued is false when activeRun belongs to a superseded step, not the current cursor', () => {
  const item = { ...baseItem, cursor: 12, activeRun: { step_index: 11, state: 'queued' } }
  expect(isQueued(item)).toBe(false)
})

test('itemStatus shows the agent working label when the farm reports running', () => {
  const item = { ...baseItem, activeRun: { step_index: 11, state: 'running' } }
  expect(itemStatus(item).label).toBe('Eng agent')
  expect(itemStatus(item, true).label).toBe('Eng agent working')
})

test('itemStatus shows Queued, with the reason, when the farm reports queued', () => {
  const item = { ...baseItem, activeRun: { step_index: 11, state: 'queued', reason: 'waiting for a free agent slot (4/4 in use)' } }
  const status = itemStatus(item)
  expect(status.label).toBe('Queued')
  expect(status.reason).toBe('waiting for a free agent slot (4/4 in use)')
  // Queued must be visually distinct from the normal "agent working" blue.
  expect(status.color).not.toBe(itemStatus({ ...baseItem, activeRun: { step_index: 11, state: 'running' } }).color)
})

test('itemStatus falls back to "working" (today\'s behavior) when the farm never reports a state — fail soft', () => {
  const item = { ...baseItem, activeRun: { step_index: 11 } } // no state field at all: old/unreachable/silent farm
  expect(itemStatus(item).label).toBe('Eng agent')
})

test('itemStatus falls back to "working" when there is no activeRun at all — mock mode', () => {
  expect(itemStatus(baseItem).label).toBe('Eng agent')
})

test('closed, rejected, paused and awaiting-gate all take priority over a queued run', () => {
  const queuedRun = { step_index: 11, state: 'queued', reason: 'waiting' }
  expect(itemStatus({ ...baseItem, cursor: 16, activeRun: queuedRun }).label).toBe('Closed')
  expect(itemStatus({ ...baseItem, rejected: true, activeRun: queuedRun }).label).toBe('Changes requested')
  expect(itemStatus({ ...baseItem, paused: true, activeRun: queuedRun }).label).toBe('Paused')
})
