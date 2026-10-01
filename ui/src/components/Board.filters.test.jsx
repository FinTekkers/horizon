// HZ-80: the board's staleness/abandoned filters, plus HZ-143's closed
// filter (see the "---- closed ----" heading). Complements Board.test.jsx
// (HZ-54, queued-vs-running) with the success metric's own named cases —
// default hide/reveal with a visible one-click "show all", filters
// combining rather than overriding, and an empty result rendering an
// explanation instead of a blank board (distinguished from the genuine
// no-items-at-all case).

import { expect, test, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import * as boardFilters from '../boardFilters'
// Derived, never hardcoded — see filters.test.js for the same note.
import { STEPS } from '../../../domain/js/lifecycle.js'

import Board from './Board'

afterEach(() => {
  cleanup()
  boardFilters._resetForTests()
})

const noop = () => {}

function item(id, overrides = {}) {
  return {
    id,
    title: `Work item ${id}`,
    priority: 'Medium',
    cursor: 0,
    issue: null,
    pr: null,
    paused: false,
    rejected: false,
    personas: { eng: 'fullstack' },
    last_activity_at: new Date().toISOString(),
    ...overrides,
  }
}

function daysAgoIso(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
}

function renderBoard(items) {
  return render(<Board items={items} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />)
}

test('a stale item is hidden by default; the hidden count and a one-click reveal are visible without opening a menu', () => {
  const items = [item('FRESH-1'), item('STALE-1', { last_activity_at: daysAgoIso(45) })]
  const { queryByText, getByText } = renderBoard(items)

  expect(queryByText('Work item FRESH-1')).toBeTruthy()
  expect(queryByText('Work item STALE-1')).toBeNull()
  expect(getByText(/Hiding 1 stale/)).toBeTruthy()
  expect(getByText('1 items across the lifecycle')).toBeTruthy()

  fireEvent.click(getByText('Show all'))
  expect(queryByText('Work item STALE-1')).toBeTruthy()
})

test('an abandoned item is hidden by default, counted separately from stale, and revealed by its own chip', () => {
  const items = [
    item('FRESH-1'),
    item('STALE-1', { last_activity_at: daysAgoIso(45) }),
    item('ABANDONED-1', { abandoned_at: daysAgoIso(1) }),
  ]
  const { queryByText, getByText } = renderBoard(items)

  expect(getByText(/Hiding 1 stale, 1 abandoned/)).toBeTruthy()

  // Toggling off just the abandoned chip reveals only ABANDONED-1.
  fireEvent.click(getByText('Abandoned (1)'))
  expect(queryByText('Work item ABANDONED-1')).toBeTruthy()
  expect(queryByText('Work item STALE-1')).toBeNull()
})

test('an item that is both stale and abandoned stays hidden until BOTH filters are off — filters combine, not override', () => {
  const items = [item('BOTH-1', { last_activity_at: daysAgoIso(60), abandoned_at: daysAgoIso(60) })]
  const { queryByText, getByText } = renderBoard(items)

  expect(queryByText('Work item BOTH-1')).toBeNull()

  fireEvent.click(getByText(/Stale/))
  expect(queryByText('Work item BOTH-1')).toBeNull() // still caught by 'abandoned'

  fireEvent.click(getByText(/Abandoned/))
  expect(queryByText('Work item BOTH-1')).toBeTruthy() // now both are off
})

test('the active filters are evident from chip styling without opening any menu', () => {
  const { getByText } = renderBoard([item('A')])
  const staleChip = getByText(/Stale/)
  expect(staleChip.className).toContain('board__filter-chip--active')
  fireEvent.click(staleChip)
  expect(staleChip.className).not.toContain('board__filter-chip--active')
})

test('no items at all renders a distinct explanation from "all items filtered out"', () => {
  const { getByText, queryByText } = renderBoard([])
  expect(getByText('No work items yet.')).toBeTruthy()
  expect(queryByText(/hidden by the active filters/)).toBeNull()
})

test('every item hidden by filters renders an explanation and a way to reveal them, never a blank board', () => {
  const items = [item('STALE-1', { last_activity_at: daysAgoIso(45) }), item('STALE-2', { last_activity_at: daysAgoIso(90) })]
  const { getByText, queryByText } = renderBoard(items)

  expect(getByText(/All 2 items are hidden by the active filters/)).toBeTruthy()
  expect(queryByText('No work items yet.')).toBeNull()

  fireEvent.click(getByText('Show all'))
  expect(queryByText('Work item STALE-1')).toBeTruthy()
  expect(queryByText('Work item STALE-2')).toBeTruthy()
})

test('board__meta counts visible, non-abandoned items only', () => {
  const items = [
    item('SHOWN-1'),
    item('STALE-1', { last_activity_at: daysAgoIso(45) }), // hidden by default
    item('ABANDONED-1', { abandoned_at: daysAgoIso(1) }), // hidden by default
  ]
  const { getByText } = renderBoard(items)
  expect(getByText('1 items across the lifecycle')).toBeTruthy()
})

// ---- closed (HZ-143) ----

function closedItem(id, overrides = {}) {
  return item(id, { cursor: STEPS.length, ...overrides })
}

test('a Closed chip renders beside Stale and Abandoned, in registry order', () => {
  const { container } = renderBoard([item('A'), closedItem('C1')])
  const labels = [...container.querySelectorAll('.board__filter-chip')].map((el) => el.textContent)
  expect(labels).toEqual(['Stale (30+ days) (0)', 'Abandoned (0)', 'Closed (1)'])
})

test('the Closed chip is a button with an accessible name and a title explaining what it is doing', () => {
  const { getByRole } = renderBoard([item('A'), closedItem('C1')])
  const chip = getByRole('button', { name: 'Closed (1)' })
  expect(chip.tagName).toBe('BUTTON')
  expect(chip.title).toBe('Hiding 1 closed item(s) — click to show')
})

test('a closed item is hidden by default; its own chip reveals it and hides it again', () => {
  const { queryByText, getByText, getByRole } = renderBoard([item('A'), closedItem('C1')])

  expect(queryByText('Work item C1')).toBeNull()
  expect(getByText(/Hiding 1 closed/)).toBeTruthy()

  // Target the full chip label: once the card is revealed its StatusPill also
  // reads "Closed", so a /^Closed/ match would find two elements and throw.
  fireEvent.click(getByRole('button', { name: 'Closed (1)' }))
  expect(queryByText('Work item C1')).toBeTruthy()

  fireEvent.click(getByRole('button', { name: 'Closed (1)' }))
  expect(queryByText('Work item C1')).toBeNull()
})

test('the hidden note names each filter in registry order', () => {
  const items = [
    item('FRESH-1'),
    item('STALE-1', { last_activity_at: daysAgoIso(45) }),
    item('ABANDONED-1', { abandoned_at: daysAgoIso(1) }),
    closedItem('CLOSED-1'),
  ]
  const { getByText } = renderBoard(items)
  expect(getByText('Hiding 1 stale, 1 abandoned, 1 closed')).toBeTruthy()
})

test('a board of only closed items explains itself instead of going blank', () => {
  const { getByText, queryByText, container } = renderBoard([closedItem('C1')])
  expect(getByText(/All 1 items are hidden by the active filters/)).toBeTruthy()
  expect(queryByText('No work items yet.')).toBeNull()
  // The "Hiding N …" note is suppressed when nothing is shown — the
  // empty-state explanation above replaces it rather than stacking with it.
  expect(container.querySelector('.board__hidden-note')).toBeNull()
})

// A closed item is delivered work, not work in flight. Today it inflates the
// header count; hiding it by default makes that count more accurate, not
// less. Pinned so nobody later reads the drop as a regression.
test('board__meta drops a closed item once it is hidden by default', () => {
  const { getByText } = renderBoard([item('A'), closedItem('C1')])
  expect(getByText('1 items across the lifecycle')).toBeTruthy()
})

test('the Review column count includes a closed item only once it is revealed', () => {
  const { container, getByRole } = renderBoard([item('A'), closedItem('C1')])
  const review = [...container.querySelectorAll('.col')].find(
    (col) => col.querySelector('.col__name').textContent === 'Review',
  )
  expect(review.querySelector('.col__count').textContent).toBe('0')

  fireEvent.click(getByRole('button', { name: 'Closed (1)' }))
  expect(review.querySelector('.col__count').textContent).toBe('1')
})
