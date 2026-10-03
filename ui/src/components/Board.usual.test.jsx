// HZ-230: active Board cards show the usual duration after the HZ-228 elapsed
// label ('12m · usually ~20m'), switching to an amber 'running long' past
// twice that. Cards waiting on a human show elapsed only.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import Board from './Board'
import { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } from '../../../domain/js/lifecycle.js'
import * as boardFilters from '../boardFilters'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  boardFilters._resetForTests()
})

const noop = () => {}
const NOW = Date.parse('2026-10-02T12:00:00Z')
const ago = (mins) => new Date(NOW - mins * 60_000).toISOString()
const est = (medianSec) => ({ medianSec, count: 5 })
const BANNED = /\b(left|remaining|ETA|done in)\b/i

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

const agent = (id, mins) =>
  item(id, { activeRun: { id: 1, step_index: IMPLEMENT_STEP_INDEX, state: 'running' }, state_since: ago(mins) })
const gateRun = (id, kind, mins) =>
  item(id, {
    cursor: ACCEPT_GATE_INDEX,
    pr: 7,
    gateAction: { kind, state: 'running', detail: null, since: ago(mins), startedBeforeRestart: false },
    state_since: ago(mins),
  })

function renderBoard(items, durationEstimates) {
  boardFilters.setActiveFilters([])
  return render(
    <Board
      items={items}
      durationEstimates={durationEstimates}
      onOpen={noop}
      onApprove={noop}
      onReject={noop}
      onTogglePause={noop}
      onNewItem={noop}
    />,
  )
}

const cardOf = (container, id) => {
  const card = [...container.querySelectorAll('.card')].find((c) => c.querySelector('.card__id')?.textContent === id)
  expect(card).toBeTruthy()
  return card
}
const elapsedOf = (container, id) => cardOf(container, id).querySelector('.card__elapsed')?.textContent ?? null

test('an agent card shows elapsed plus the usual time, or elapsed only with no estimate', () => {
  vi.useFakeTimers({ now: NOW })
  const { container, rerender } = renderBoard([agent('U-AGENT', 12)], { [IMPLEMENT_STEP_INDEX]: est(1200) })
  expect(elapsedOf(container, 'U-AGENT')).toBe('Implementing · 12m · usually ~20m')
  rerender(
    <Board
      items={[agent('U-AGENT', 12)]}
      durationEstimates={{ [IMPLEMENT_STEP_INDEX]: null }}
      onOpen={noop}
      onApprove={noop}
      onReject={noop}
      onTogglePause={noop}
      onNewItem={noop}
    />,
  )
  expect(elapsedOf(container, 'U-AGENT')).toBe('Implementing · 12m')
})

test('Accept and Resolve cards read the premerge and resolve estimates', () => {
  vi.useFakeTimers({ now: NOW })
  const items = [gateRun('U-PREMERGE', 'premerge', 3), gateRun('U-RESOLVE', 'resolve', 4)]
  const { container, unmount } = renderBoard(items, { premerge: est(300), resolve: est(1200) })
  expect(elapsedOf(container, 'U-PREMERGE')).toBe('Running checks · 3m · usually ~5m')
  expect(elapsedOf(container, 'U-RESOLVE')).toBe('Resolving conflicts · 4m · usually ~20m')
  unmount()

  const nulls = renderBoard(items, { premerge: null, resolve: null })
  expect(elapsedOf(nulls.container, 'U-PREMERGE')).toBe('Running checks · 3m')
  expect(elapsedOf(nulls.container, 'U-RESOLVE')).toBe('Resolving conflicts · 4m')
})

test('an hour-plus estimate uses the elapsed label form', () => {
  vi.useFakeTimers({ now: NOW })
  const { container } = renderBoard([agent('U-HOURS', 12)], { [IMPLEMENT_STEP_INDEX]: est(3900) })
  expect(elapsedOf(container, 'U-HOURS')).toBe('Implementing · 12m · usually ~1h 05m')
})

test('the label switches to running long on the Board tick that passes twice the usual time', () => {
  // 30s short of 2 × 10m, so the next minute's tick lands 30s past it.
  vi.useFakeTimers({ now: NOW })
  const since = new Date(NOW - (2 * 600 - 30) * 1000).toISOString()
  const { container } = renderBoard([item('U-LONG', { state_since: since })], { [IMPLEMENT_STEP_INDEX]: est(600) })
  const card = cardOf(container, 'U-LONG')
  expect(elapsedOf(container, 'U-LONG')).toBe('Implementing · 19m · usually ~10m')
  expect(card.querySelector('.card__usual--long')).toBeNull()
  expect(card.querySelector('.card__elapsed').textContent).not.toMatch(BANNED)

  act(() => vi.advanceTimersByTime(60_000))
  expect(elapsedOf(container, 'U-LONG')).toBe('Implementing · 20m · running long')
  const long = card.querySelector('.card__usual')
  expect(long.textContent).toBe('running long')
  expect(long.classList.contains('card__usual--long')).toBe(true)
  expect(card.querySelector('.card__elapsed').textContent).not.toMatch(BANNED)
})

test.each([3, 5, 10, 13, 15])('a card waiting on a human at gate %i shows elapsed only', (cursor) => {
  vi.useFakeTimers({ now: NOW })
  const all = {
    ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String(i), est(60)])),
    premerge: est(60),
    resolve: est(60),
  }
  const { container } = renderBoard([item('U-GATE', { cursor, state_since: ago(25) })], all)
  const text = elapsedOf(container, 'U-GATE')
  expect(text).toBe('Waiting on you · 25m')
  expect(text).not.toMatch(/usually|running long/)
})

test('with no estimates at all every card renders as before', () => {
  vi.useFakeTimers({ now: NOW })
  const { container } = renderBoard([agent('U-NONE', 12), gateRun('U-NONE-GATE', 'premerge', 6)], undefined)
  expect(elapsedOf(container, 'U-NONE')).toBe('Implementing · 12m')
  expect(elapsedOf(container, 'U-NONE-GATE')).toBe('Running checks · 6m')
})
