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
