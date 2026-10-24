// HZ-547 metric line 1: the board's Plan filter shows exactly the items one
// Plan filed (the server's spawnedBy link), also once that Plan has closed;
// it combines with the Priority chips, and its chip reads "<ID> · <title> ×".
// Show all keeps the Plan; without one it still clears every chip.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, within } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import Board from './Board'
import { IMPLEMENT_STEP_INDEX, endIndex } from '../../../domain/js/lifecycle.js'
import { PRIORITY } from '../../../domain/js/priorities.js'
import * as boardFilters from '../boardFilters'
import * as boardNarrowing from '../boardNarrowing'

afterEach(() => {
  cleanup()
  boardFilters._resetForTests()
  boardNarrowing._resetForTests()
})

const noop = () => {}

function item(id, extra = {}) {
  return {
    id,
    title: `Item ${id}`,
    priority: PRIORITY.MEDIUM,
    kind: 'change',
    lane: null,
    cursor: IMPLEMENT_STEP_INDEX,
    issue: null,
    pr: null,
    paused: false,
    rejected: false,
    abandoned_at: null,
    personas: { eng: 'fullstack' },
    activeRun: null,
    state_since: null,
    waiting_since: null,
    spawnedBy: null,
    ...extra,
  }
}

const fromP = { spawnedBy: { id: 'P-1', title: 'Adjusted cost basis' } }
// Closed Plan P-1 filed three: one closed, one High, one Low. Q-1 is another
// Plan's; U-1 nothing filed.
const ITEMS = [
  item('PC-1', { ...fromP, cursor: endIndex('change') }),
  item('PH-1', { ...fromP, priority: PRIORITY.HIGH }),
  item('PL-1', { ...fromP, priority: PRIORITY.LOW }),
  item('Q-1', { spawnedBy: { id: 'Q-9', title: 'Other plan' }, priority: PRIORITY.HIGH }),
  item('U-1', { priority: PRIORITY.HIGH }),
]
const PLAN_PROGRESS = [
  { id: 'P-1', kind: 'plan', title: 'Adjusted cost basis', closed: true, status: 'inProgress', total: 3, done: 1, abandoned: 0, inProgress: 2, stalled: 0, waiting: 0, waitingAtGate: [] },
  { id: 'Q-9', kind: 'plan', title: 'Other plan', closed: false, status: 'inProgress', total: 1, done: 0, abandoned: 0, inProgress: 1, stalled: 0, waiting: 0, waitingAtGate: [] },
]

function renderBoard() {
  return render(
    <Board
      items={ITEMS}
      planProgress={PLAN_PROGRESS}
      onOpen={noop}
      onOpenPlan={noop}
      onApprove={noop}
      onReject={noop}
      onTogglePause={noop}
      onNewItem={noop}
    />,
  )
}

const cardIds = (container) => [...container.querySelectorAll('.card .card__id')].map((n) => n.textContent).sort()
const chipIn = (getByRole, group, name) => within(getByRole('group', { name: group })).getByRole('button', { name })
const choosePlan = (getByRole, id) => fireEvent.change(getByRole('combobox', { name: 'Plan' }), { target: { value: id } })

test("choosing a closed Plan shows exactly its open items; Show all shows all it filed and keeps the Plan", () => {
  const { container, getByRole, getByText } = renderBoard()
  expect(cardIds(container)).toEqual(['PH-1', 'PL-1', 'Q-1', 'U-1'])

  choosePlan(getByRole, 'P-1')
  expect(cardIds(container)).toEqual(['PH-1', 'PL-1'])
  expect(container.querySelector('.board__meta').textContent).toBe('2 items from Plan P-1')
  expect(container.querySelector('.board__hidden-note').textContent).toContain('Hiding 1 closed')

  fireEvent.click(getByText('Show all'))
  expect(cardIds(container)).toEqual(['PC-1', 'PH-1', 'PL-1'])
  expect(container.querySelector('.board__plan-chip').textContent).toBe('P-1 · Adjusted cost basis ×')
})

test('a Priority chip narrows the Plan\'s items, and × clears the Plan', () => {
  const { container, getByRole } = renderBoard()
  choosePlan(getByRole, 'P-1')
  fireEvent.click(chipIn(getByRole, 'Priority', PRIORITY.HIGH))
  expect(cardIds(container)).toEqual(['PH-1'])
  expect(container.querySelector('.board__plan-chip').textContent).toBe('P-1 · Adjusted cost basis ×')

  fireEvent.click(getByRole('button', { name: 'Clear the Plan filter' }))
  expect(cardIds(container)).toEqual(['PH-1', 'Q-1', 'U-1'])
  expect(container.querySelector('.board__plan-chip')).toBeNull()
  expect(getByRole('combobox', { name: 'Plan' })).toBeTruthy()
})

test('without a Plan, Show all still clears the chips; with one, it keeps the Plan and the Priority chip', () => {
  const { container, getByRole, getByText } = renderBoard()
  fireEvent.click(chipIn(getByRole, 'Priority', PRIORITY.HIGH))
  fireEvent.click(getByText('Show all'))
  expect(chipIn(getByRole, 'Priority', PRIORITY.HIGH).getAttribute('aria-pressed')).toBe('false')
  expect(cardIds(container)).toEqual(['PC-1', 'PH-1', 'PL-1', 'Q-1', 'U-1'])

  choosePlan(getByRole, 'P-1')
  fireEvent.click(chipIn(getByRole, 'Priority', PRIORITY.HIGH))
  fireEvent.click(getByText('Show all'))
  expect(boardNarrowing.getBoardView().plan).toBe('P-1')
  expect(chipIn(getByRole, 'Priority', PRIORITY.HIGH).getAttribute('aria-pressed')).toBe('true')
  expect(cardIds(container)).toEqual(['PH-1'])
})

test('an unknown or malformed Plan id narrows to nothing, with no crash', () => {
  boardNarrowing.setBoardView({ plan: 'ZZ-999' })
  const { container, getByText } = renderBoard()
  expect(cardIds(container)).toEqual([])
  expect(getByText('No items from Plan ZZ-999.')).toBeTruthy()
  expect(container.querySelector('.board__plan-chip').textContent).toBe('ZZ-999 ×')

  boardNarrowing.setBoardView({ plan: '<script>' })
  expect(boardNarrowing.getBoardView().plan).toBeNull()
})
