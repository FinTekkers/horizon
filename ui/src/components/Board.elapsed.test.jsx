// HZ-228: every active Board card shows how long it has been in its current
// state, from the server's state_since, ticked by one Board-wide clock.
// Paused rule: a paused card shows no timer (there is no pause timestamp).

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import Board from './Board'
import { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX, STEPS } from '../../../domain/js/lifecycle.js'
import * as boardFilters from '../boardFilters'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  boardFilters._resetForTests()
})

const noop = () => {}
const NOW = Date.parse('2026-10-02T12:00:00Z')
const ago = (mins) => new Date(NOW - mins * 60_000).toISOString()
const GATE_INDEX = IMPLEMENT_STEP_INDEX - 1

function item(id, extra = {}) {
  return {
    id,
    title: `Item ${id}`,
    priority: 'Medium',
    cursor: IMPLEMENT_STEP_INDEX,
    issue: null,
    pr: null,
    paused: false,
    rejected: false,
    abandoned_at: null,
    personas: { eng: 'fullstack' },
    activeRun: null,
    gateAction: null,
    conflictRun: null,
    state_since: null,
    last_activity_at: '2026-10-02 11:59:00',
    ...extra,
  }
}

function renderBoard(items) {
  // Show every card: the default filters hide closed and abandoned ones.
  boardFilters.setActiveFilters([])
  return render(
    <Board items={items} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />,
  )
}

const elapsedOf = (container, id) => {
  const card = [...container.querySelectorAll('.card')].find((c) => c.textContent.includes(id))
  expect(card).toBeTruthy()
  return card.querySelector('.card__elapsed')?.textContent ?? null
}

test('agent step, human gate and running pre-merge each show their label and minutes', () => {
  vi.useFakeTimers({ now: NOW })
  const { container } = renderBoard([
    item('E-AGENT', { activeRun: { id: 1, step_index: IMPLEMENT_STEP_INDEX, state: 'running' }, state_since: ago(12) }),
    item('E-GATE', { cursor: GATE_INDEX, state_since: ago(25) }),
    item('E-CHECKS', {
      cursor: ACCEPT_GATE_INDEX,
      pr: 7,
      gateAction: { kind: 'premerge', state: 'running', detail: null, since: ago(6), startedBeforeRestart: false },
      state_since: ago(6),
    }),
  ])
  expect(elapsedOf(container, 'E-AGENT')).toBe('Implementing · 12m')
  expect(elapsedOf(container, 'E-GATE')).toBe('Waiting on you · 25m')
  expect(elapsedOf(container, 'E-CHECKS')).toBe('Running checks · 6m')
})

test('paused, closed and abandoned cards show no timer', () => {
  vi.useFakeTimers({ now: NOW })
  const { container } = renderBoard([
    // A stale client payload still carrying a time must not show a paused timer.
    item('E-PAUSED', { paused: true, state_since: ago(3) }),
    item('E-CLOSED', { cursor: STEPS.length, state_since: null }),
    item('E-ABANDONED', { cursor: GATE_INDEX, abandoned_at: '2026-10-02 11:00:00', state_since: null }),
  ])
  expect(elapsedOf(container, 'E-PAUSED')).toBeNull()
  expect(elapsedOf(container, 'E-CLOSED')).toBeNull()
  expect(elapsedOf(container, 'E-ABANDONED')).toBeNull()
})

test('the label ticks forward each minute with no new props', () => {
  vi.useFakeTimers({ now: NOW })
  const { container } = renderBoard([item('E-TICK', { cursor: GATE_INDEX, state_since: new Date(NOW - 61_000).toISOString() })])
  expect(elapsedOf(container, 'E-TICK')).toBe('Waiting on you · 1m')
  act(() => vi.advanceTimersByTime(60_000))
  expect(elapsedOf(container, 'E-TICK')).toBe('Waiting on you · 2m')
})

test('one interval drives every card, and it is cleared on unmount', () => {
  vi.useFakeTimers({ now: NOW })
  // Spied rather than vi.getTimerCount(), which also counts React's own timers.
  const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
  const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
  const { unmount } = renderBoard([
    item('E-1', { cursor: GATE_INDEX, state_since: ago(1) }),
    item('E-2', { cursor: GATE_INDEX, state_since: ago(2) }),
    item('E-3', { cursor: GATE_INDEX, state_since: ago(3) }),
  ])
  expect(setIntervalSpy).toHaveBeenCalledTimes(1)
  const timer = setIntervalSpy.mock.results[0].value
  expect(clearIntervalSpy).not.toHaveBeenCalled()
  unmount()
  expect(clearIntervalSpy).toHaveBeenCalledWith(timer)
  expect(setIntervalSpy).toHaveBeenCalledTimes(1)
})
