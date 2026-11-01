// HZ-547 metric line 3: a filed item's card chip ("From Plan <ID>") and its
// item-page pill ("From Plan <ID> · x of y done") both open the board
// filtered to that Plan — chip, visible cards and `?plan=` in the URL. The
// card chip does not also open the card. An item nothing filed shows neither.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { IMPLEMENT_STEP_INDEX, endIndex } from '../../domain/js/lifecycle.js'
import * as boardFilters from './boardFilters'
import * as boardNarrowing from './boardNarrowing'

let items = []
let planProgress = []
const listeners = new Set()

vi.mock('./api', () => ({
  subscribe: (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  getItems: () => items,
  getCurrentUser: vi.fn(async () => ({ name: 'Test User', initials: 'TU', email: 'test@example.com' })),
  getSync: () => ({ connected: false }),
  getProjects: () => [],
  getActiveProjectId: () => null,
  // HZ-661: no board frame yet, so the first-project screen stays off.
  hasSnapshot: () => false,
  getFarm: () => null,
  getDurationEstimates: () => null,
  getDeployBlock: () => null,
  getPlanProgress: () => planProgress,
  approveGate: vi.fn(),
  requestChanges: vi.fn(),
  getRestartSent: () => null,
  setPaused: vi.fn(),
  restartPhase: vi.fn(),
  setPersona: vi.fn(),
  setStepProvider: vi.fn(),
  abandonItem: vi.fn(),
  addDependency: vi.fn(async () => ({ ok: true })),
  createItem: vi.fn(),
  setProjectEnabled: vi.fn(),
  logout: vi.fn(),
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
}))

import App from './App'

afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
  boardFilters._resetForTests()
  boardNarrowing._resetForTests()
})

function item(id, extra = {}) {
  return {
    id,
    title: `Item ${id}`,
    desc: '',
    metric: '',
    guardrails: '',
    priority: 'Medium',
    kind: 'change',
    cursor: IMPLEMENT_STEP_INDEX,
    paused: false,
    rejected: false,
    events: [],
    stepOutputs: {},
    activeRun: null,
    spawnedBy: null,
    ...extra,
  }
}

const fromP = { spawnedBy: { id: 'P-1', title: 'Adjusted cost basis' } }
const progress = (id, title, counts) => ({ id, kind: 'plan', title, closed: true, status: 'inProgress', abandoned: 0, inProgress: 0, stalled: 0, waiting: 0, waitingAtGate: [], ...counts })

function setUp() {
  items = [
    item('P-1', { kind: 'plan', cursor: endIndex('plan'), title: 'Adjusted cost basis' }),
    item('C-1', fromP),
    item('C-2', fromP),
    item('C-3', { ...fromP, cursor: endIndex('change') }),
    item('U-1'),
  ]
  planProgress = [progress('P-1', 'Adjusted cost basis', { total: 3, done: 1, inProgress: 2 })]
}

const cardIds = () => [...document.querySelectorAll('.card .card__id')].map((n) => n.textContent).sort()
const cardOf = (id) => [...document.querySelectorAll('.card')].find((c) => c.querySelector('.card__id').textContent === id)

async function expectBoardFilteredToP1() {
  await waitFor(() => expect(document.querySelector('.board__plan-chip')?.textContent).toBe('P-1 · Adjusted cost basis ×'))
  expect(cardIds()).toEqual(['C-1', 'C-2'])
  expect(window.location.pathname).toBe('/')
  expect(new URLSearchParams(window.location.search).get('plan')).toBe('P-1')
}

test("a filed item's card chip opens the board filtered to its Plan, not the item", async () => {
  setUp()
  const { findByText } = render(<App />)
  await findByText('Work in flight')
  expect(cardIds()).toEqual(['C-1', 'C-2', 'U-1'])

  fireEvent.click(within(cardOf('C-1')).getByRole('link', { name: 'From Plan P-1' }))
  await expectBoardFilteredToP1()
  expect(document.querySelector('.tracker__title')).toBeNull()
})

test("the item page's pill reads x of y done and opens the board filtered to its Plan", async () => {
  setUp()
  window.history.pushState({}, '', '/c-1')
  const { findByRole } = render(<App />)
  const pill = await findByRole('link', { name: 'From Plan P-1 · 1 of 3 done' })
  expect(pill.getAttribute('href')).toBe('/?plan=P-1')

  fireEvent.click(pill)
  await expectBoardFilteredToP1()
})

test('abandoned items count in y but not x', async () => {
  setUp()
  planProgress = [progress('P-1', 'Adjusted cost basis', { total: 3, done: 2, abandoned: 1, status: 'complete' })]
  window.history.pushState({}, '', '/c-1')
  const { findByRole } = render(<App />)
  expect(await findByRole('link', { name: 'From Plan P-1 · 2 of 3 done' })).toBeTruthy()
})

test('an item nothing filed shows neither the card chip nor the pill', async () => {
  setUp()
  const { findByText } = render(<App />)
  await findByText('Work in flight')
  expect(within(cardOf('U-1')).queryByRole('link', { name: /^From / })).toBeNull()
  cleanup()

  window.history.pushState({}, '', '/u-1')
  const page = render(<App />)
  await page.findByText('Item U-1')
  expect(page.queryByRole('link', { name: /^From / })).toBeNull()
  expect(document.querySelector('.tracker__from-plan')).toBeNull()
})

test('a /?plan= deep link filters the board, and clearing the chip drops it from the URL', async () => {
  setUp()
  window.history.pushState({}, '', '/?plan=P-1')
  render(<App />)
  await expectBoardFilteredToP1()

  fireEvent.click(document.querySelector('.board__plan-clear'))
  await waitFor(() => expect(window.location.search).toBe(''))
  expect(cardIds()).toEqual(['C-1', 'C-2', 'U-1'])
})

test('a Task parent reads "From Task" on the pill', async () => {
  setUp()
  planProgress = [{ ...progress('P-1', 'Adjusted cost basis', { total: 3, done: 1 }), kind: 'task' }]
  window.history.pushState({}, '', '/c-1')
  const { findByRole } = render(<App />)
  expect(await findByRole('link', { name: 'From Task P-1 · 1 of 3 done' })).toBeTruthy()
})
