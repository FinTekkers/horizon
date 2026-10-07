// HZ-335: a card held up by an open dependency reads Blocked — never an agent
// working, never Pause work, no elapsed line or "usually ~Xm". It names each
// blocker as a link from item.blockedBy (HZ-95: read as the API gives it).

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import Board from './Board'
import { IMPLEMENT_STEP_INDEX, phaseIdx } from '../../../domain/js/lifecycle.js'
import * as boardFilters from '../boardFilters'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  boardFilters._resetForTests()
})

const noop = () => {}
const NOW = Date.parse('2026-10-07T12:00:00Z')
const ago = (mins) => new Date(NOW - mins * 60_000).toISOString()
const ESTIMATES = { [IMPLEMENT_STEP_INDEX]: { medianSec: 600, count: 5 } }

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
    state_since: ago(12),
    last_activity_at: '2026-10-07 11:59:00',
    blockedBy: [],
    dependents: [],
    ...extra,
  }
}

const blocked = (id, extra = {}) =>
  item(id, {
    blocked: true,
    blockedBy: [
      { id: 'HZ-327', title: 'Flaky checks', abandoned: false },
      { id: 'HZ-328', title: 'Another blocker', abandoned: false },
    ],
    ...extra,
  })

function board(items, props = {}) {
  return (
    <Board
      items={items}
      durationEstimates={ESTIMATES}
      onOpen={noop}
      onApprove={noop}
      onReject={noop}
      onTogglePause={noop}
      onNewItem={noop}
      {...props}
    />
  )
}

const cardOf = (container, id) => {
  const card = [...container.querySelectorAll('.card')].find((c) => c.querySelector('.card__id')?.textContent === id)
  expect(card).toBeTruthy()
  return card
}
const buttonNames = (card) => [...card.querySelectorAll('button')].map((b) => b.textContent)

test('a blocked card reads Blocked, offers no Pause work, and links each blocker without opening the card', () => {
  const onOpen = vi.fn()
  const { container } = render(board([blocked('HZ-334')], { onOpen }))
  const card = cardOf(container, 'HZ-334')
  expect(card.querySelector('.status-pill').textContent).toBe('Blocked')
  expect(buttonNames(card)).not.toContain('Pause work')
  expect(buttonNames(card)).not.toContain('Resume work')

  const pill = card.querySelector('.dep-pill--blocked')
  expect(pill.textContent).toBe('Blocked by HZ-327, HZ-328')
  const links = [...pill.querySelectorAll('a')]
  expect(links.map((a) => a.textContent)).toEqual(['HZ-327', 'HZ-328'])
  expect(links[0].getAttribute('href').endsWith('/hz-327')).toBe(true)
  expect(links[1].getAttribute('href').endsWith('/hz-328')).toBe(true)

  fireEvent.click(links[0])
  expect(onOpen).not.toHaveBeenCalled()
})

test('a blocked card is still counted in the header and its column under the default filters', () => {
  vi.useFakeTimers({ now: NOW })
  const items = [blocked('HZ-334'), item('HZ-336')]
  const { container } = render(board(items))
  expect(container.querySelector('.board__meta').textContent).toBe('2 items across the lifecycle')
  const col = container.querySelectorAll('.col')[phaseIdx(items[0])]
  expect(col.querySelector('.col__count').textContent).toBe('2')
})

test('a blocked card shows no elapsed time or usual-duration line, even after the clock advances', () => {
  vi.useFakeTimers({ now: NOW })
  const items = [blocked('HZ-334', { state_since: ago(19) })]
  const { container, rerender } = render(board(items))
  const card = () => cardOf(container, 'HZ-334')
  expect(card().querySelector('.card__elapsed')).toBeNull()
  expect(card().querySelector('.card__usual')).toBeNull()

  act(() => vi.advanceTimersByTime(2 * 60 * 60_000))
  rerender(board(items))
  expect(card().querySelector('.card__elapsed')).toBeNull()
  expect(card().textContent).not.toMatch(/running long|usually ~/)
})

test('when the blocker is removed or closes, the next snapshot brings back the working pill, Pause work and the timer', () => {
  vi.useFakeTimers({ now: NOW })
  const { container, rerender } = render(board([blocked('HZ-334')]))
  expect(cardOf(container, 'HZ-334').querySelector('.status-pill').textContent).toBe('Blocked')

  rerender(board([blocked('HZ-334', { blocked: false, blockedBy: [] })]))
  const card = cardOf(container, 'HZ-334')
  expect(card.querySelector('.status-pill').textContent).toBe('Eng agent')
  expect(buttonNames(card)).toContain('Pause work')
  expect(card.querySelector('.card__elapsed').textContent).toBe('Implementing · 12m · usually ~10m')
})

test('rendering a blocked card makes no fetch', () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('unexpected fetch')))
  render(board([blocked('HZ-334')]))
  expect(spy).not.toHaveBeenCalled()
})

// Guardrail: Pause and Resume behave as before for items that are not blocked.
test.each([
  ['blocked: false', { blocked: false }],
  ['blocked absent', {}],
])('a non-blocked agent-step card (%s) still offers Pause work', (_, extra) => {
  const onTogglePause = vi.fn()
  const { container } = render(board([item('HZ-336', extra)], { onTogglePause }))
  const card = cardOf(container, 'HZ-336')
  const pause = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Pause work')
  expect(pause).toBeTruthy()
  fireEvent.click(pause)
  expect(onTogglePause).toHaveBeenCalledWith('HZ-336')
})

test('a paused card offers Resume work, whether or not it is also blocked', () => {
  const { container } = render(board([item('HZ-336', { paused: true }), blocked('HZ-334', { paused: true })]))
  for (const id of ['HZ-336', 'HZ-334']) {
    const card = cardOf(container, id)
    expect(card.querySelector('.status-pill').textContent).toBe('Paused')
    expect(buttonNames(card)).toContain('Resume work')
    expect(buttonNames(card)).not.toContain('Pause work')
  }
})
