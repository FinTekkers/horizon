// HZ-62: mock mode's approveGate must report the same { ok, closed } shape
// the server does, so App.jsx's post-approval navigation works identically
// whether VITE_MOCK is on or off.

import { expect, test, vi, afterEach } from 'vitest'
import * as mockApi from './mockApi'
import { STEPS } from '../domain/lifecycle'

afterEach(() => {
  vi.useRealTimers()
})

test('approving an intermediate gate reports closed: false', async () => {
  vi.useFakeTimers()
  // BF-131 seeds at cursor 5 — "Approve the high-level design", not the last gate.
  const before = mockApi.getItems().find((it) => it.id === 'BF-131')
  expect(STEPS[before.cursor].label).toBe('Approve the high-level design')

  const result = await mockApi.approveGate('BF-131', '')

  expect(result).toEqual({ ok: true, closed: false })
  expect(mockApi.getItems().find((it) => it.id === 'BF-131').cursor).toBe(before.cursor + 1)
  vi.clearAllTimers()
})

test('approving the closing gate reports closed: true', async () => {
  vi.useFakeTimers()
  // BF-090 seeds at cursor 15 — "Review the work & close", the last gate.
  const before = mockApi.getItems().find((it) => it.id === 'BF-090')
  expect(before.cursor).toBe(STEPS.length - 1)
  expect(STEPS[before.cursor].label).toBe('Review the work & close')

  const result = await mockApi.approveGate('BF-090', '')

  expect(result).toEqual({ ok: true, closed: true })
  expect(mockApi.getItems().find((it) => it.id === 'BF-090').cursor).toBe(STEPS.length)
  vi.clearAllTimers()
})
