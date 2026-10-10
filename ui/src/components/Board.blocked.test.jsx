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
  // HZ-385: the intent the button shows, not a flip of the cached item.
  expect(onTogglePause).toHaveBeenCalledWith('HZ-336', true)
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

// HZ-385: Resume work sends paused: false, and the button stays disabled until
// the answer arrives, so a second click sends nothing.
test('Resume work on a card sends (id, false) once and is disabled while it runs', async () => {
  let finish
  const onTogglePause = vi.fn(() => new Promise((resolve) => (finish = resolve)))
  const { container } = render(board([item('HZ-336', { paused: true })], { onTogglePause }))
  const resume = () => [...cardOf(container, 'HZ-336').querySelectorAll('button')].find((b) => b.textContent === 'Resume work')
  fireEvent.click(resume())
  fireEvent.click(resume())
  expect(onTogglePause).toHaveBeenCalledTimes(1)
  expect(onTogglePause).toHaveBeenCalledWith('HZ-336', false)
  expect(resume().disabled).toBe(true)
  await act(async () => finish({ ok: true, paused: false }))
  expect(resume().disabled).toBe(false)
})

// HZ-365: a rule-blocked card shows the pill, the first line of what's needed
// in a soft-red box with a link to the item page's banner, and any Blocked by
// line — and no Pause work.
test('a rule-blocked card shows the first line of needs, a See what to do link to #rule-block, the Blocked by line, and no Pause work', () => {
  const onOpen = vi.fn()
  const ruleBlock = {
    rule: 'guardrail 6',
    needs: 'A ledger-models release with the fix.\n\nCause: the proto has no settlement field.',
    runId: 9,
    blockedAt: '2026-10-08 14:02:11',
  }
  const { container, getByRole } = render(board([blocked('LS-17', { ruleBlock })], { onOpen }))
  const card = cardOf(container, 'LS-17')
  expect(card.querySelector('.status-pill').textContent).toBe('Blocked by a rule')
  expect(buttonNames(card)).not.toContain('Pause work')

  const box = card.querySelector('.card__rule-block')
  expect(box.textContent).toBe('A ledger-models release with the fix.See what to do')
  expect(box.textContent).not.toContain('Cause:')
  expect(box.hasAttribute('style')).toBe(false)
  expect(card.querySelector('.dep-pill--blocked').textContent).toBe('Blocked by HZ-327, HZ-328')

  const link = getByRole('link', { name: 'See what to do' })
  expect(link.getAttribute('href').endsWith('/ls-17#rule-block')).toBe(true)
  link.addEventListener('click', (e) => e.preventDefault()) // jsdom cannot navigate
  fireEvent.click(link)
  expect(onOpen).not.toHaveBeenCalled()
})
