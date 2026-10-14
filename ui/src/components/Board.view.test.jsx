// HZ-443: the board's narrowing controls — Waiting on me (sorted by wait, either
// direction), Priority and Kind — remembered across reloads, counted in the
// "Hiding …" summary, and safe against anything found in storage.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, within } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import Board from './Board'
import { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX, STEPS, firstStepIndex, kindStepIndex } from '../../../domain/js/lifecycle.js'
import { PRIORITIES, PRIORITY } from '../../../domain/js/priorities.js'
import * as boardFilters from '../boardFilters'
import * as boardNarrowing from '../boardNarrowing'

const STORAGE_KEY = 'horizon.boardView'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  boardFilters._resetForTests()
  boardNarrowing._resetForTests()
})

const noop = () => {}
const NOW = Date.parse('2026-10-14T12:00:00Z')
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString()

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
    gateAction: null,
    conflictRun: null,
    state_since: null,
    waiting_since: null,
    last_activity_at: new Date(NOW - 60_000).toISOString(),
    ...extra,
  }
}

const RULE_BLOCK = { rule: 'guardrail 6', needs: 'A release with the fix.', runId: 9, blockedAt: '2026-10-14 09:00:00' }

// All four in the Build column (phase 2): the sort is per column, so the order
// is only meaningful when they share one.
const WAITING_FIXTURE = [
  item('RUNNING', { activeRun: { id: 1, step_index: IMPLEMENT_STEP_INDEX, state: 'running' }, state_since: hoursAgo(2) }),
  item('PAUSED', { paused: true, waiting_since: hoursAgo(1) }),
  item('GATE', { cursor: ACCEPT_GATE_INDEX, state_since: hoursAgo(5), waiting_since: hoursAgo(5) }),
  item('RULE', { ruleBlock: RULE_BLOCK, waiting_since: hoursAgo(3) }),
]

function renderBoard(items, { showAll = true } = {}) {
  // Most cases want every card: the default filters hide closed ones.
  if (showAll) boardFilters.setActiveFilters([])
  return render(<Board items={items} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />)
}

const cardIds = (container) => [...container.querySelectorAll('.card .card__id')].map((n) => n.textContent)
const colIds = (container, phase) =>
  [...container.querySelectorAll('.col')[phase].querySelectorAll('.card .card__id')].map((n) => n.textContent)
const cardOf = (container, id) => [...container.querySelectorAll('.card')].find((c) => c.querySelector('.card__id').textContent === id)
const pressed = (container) => [...container.querySelectorAll('.board__narrow [aria-pressed="true"]')].map((b) => b.textContent)
const chipIn = (getByRole, group, name) => within(getByRole('group', { name: group })).getByRole('button', { name })

test('Waiting on me shows only gate, rule-blocked and paused items, longest wait first with one wait each; the toggle flips to most recent', () => {
  vi.useFakeTimers({ now: NOW })
  const { container, getByRole } = renderBoard(WAITING_FIXTURE)
  const buildCol = STEPS[IMPLEMENT_STEP_INDEX].phase
  expect(colIds(container, buildCol)).toEqual(['RUNNING', 'PAUSED', 'GATE', 'RULE'])

  fireEvent.click(getByRole('button', { name: 'Waiting on me' }))
  expect(getByRole('button', { name: 'Waiting on me' }).getAttribute('aria-pressed')).toBe('true')
  expect(colIds(container, buildCol)).toEqual(['GATE', 'RULE', 'PAUSED'])
  expect(cardIds(container)).toEqual(['GATE', 'RULE', 'PAUSED'])
  for (const [id, text] of [['GATE', 'waiting 5h'], ['RULE', 'waiting 3h'], ['PAUSED', 'waiting 1h']]) {
    const card = cardOf(container, id)
    expect([...card.querySelectorAll('.card__waiting')].map((n) => n.textContent)).toEqual([text])
    // One wait per card: the gate's own "Waiting on you · …" line gives way.
    expect(card.querySelector('.card__elapsed')).toBeNull()
  }

  fireEvent.click(getByRole('button', { name: 'Longest wait' }))
  expect(colIds(container, buildCol)).toEqual(['PAUSED', 'RULE', 'GATE'])
  expect(getByRole('button', { name: 'Most recent' })).toBeTruthy()
})

test('each Priority chip alone shows only its items; a second chip adds to it', () => {
  const items = PRIORITIES.map((p, i) => item(`P-${i}`, { priority: p }))
  const { container, getByRole } = renderBoard(items)
  PRIORITIES.forEach((p, i) => {
    fireEvent.click(chipIn(getByRole, 'Priority', p))
    expect(cardIds(container)).toEqual([`P-${i}`])
    fireEvent.click(chipIn(getByRole, 'Priority', p))
  })
  expect(cardIds(container)).toHaveLength(PRIORITIES.length)

  fireEvent.click(chipIn(getByRole, 'Priority', PRIORITY.CRITICAL))
  fireEvent.click(chipIn(getByRole, 'Priority', PRIORITY.LOW))
  expect(cardIds(container).sort()).toEqual([`P-${PRIORITIES.indexOf(PRIORITY.CRITICAL)}`, `P-${PRIORITIES.indexOf(PRIORITY.LOW)}`].sort())
})

const KIND_FIXTURE = [
  item('K-TASK', { kind: 'task', cursor: firstStepIndex('task'), priority: PRIORITY.HIGH }),
  item('K-CHANGE', { priority: PRIORITY.HIGH }),
  item('K-TRIVIAL', { lane: 'trivial', priority: PRIORITY.HIGH }),
  item('K-CHANGE-LOW', { priority: PRIORITY.LOW }),
  item('K-TRIVIAL-LOW', { lane: 'trivial', priority: PRIORITY.LOW }),
]

test('each Kind chip alone: Trivial is a change with the trivial label, Change is a change without it', () => {
  const { container, getByRole } = renderBoard(KIND_FIXTURE)
  for (const [name, ids] of [
    ['Task', ['K-TASK']],
    ['Change', ['K-CHANGE', 'K-CHANGE-LOW']],
    ['Trivial', ['K-TRIVIAL', 'K-TRIVIAL-LOW']],
  ]) {
    fireEvent.click(chipIn(getByRole, 'Kind', name))
    expect(cardIds(container).sort()).toEqual([...ids].sort())
    fireEvent.click(chipIn(getByRole, 'Kind', name))
  }
})

// HZ-446: a Plan is a third kind — its own badge, its own Kind chip and its
// own phase names on the card.
test('a Plan card reads Plan with its own phase name, and the Kind chip Plan shows only Plans', () => {
  const inventory = kindStepIndex('Inventory current state', 'plan')
  const items = [...KIND_FIXTURE, item('K-PLAN', { kind: 'plan', cursor: inventory, priority: PRIORITY.HIGH })]
  const { container, getByRole } = renderBoard(items)
  const chips = within(getByRole('group', { name: 'Kind' })).getAllByRole('button').map((b) => b.textContent)
  expect(chips).toEqual(['Change', 'Task', 'Plan', 'Trivial'])

  const plan = cardOf(container, 'K-PLAN')
  expect(plan.querySelector('.kind-badge').textContent).toBe('Plan')
  expect(plan.querySelector('.card__phase').textContent).toBe('Inventory')
  expect(cardOf(container, 'K-TASK').querySelector('.kind-badge').textContent).toBe('Task')

  fireEvent.click(chipIn(getByRole, 'Kind', 'Plan'))
  expect(cardIds(container)).toEqual(['K-PLAN'])
  fireEvent.click(chipIn(getByRole, 'Kind', 'Plan'))
  expect(cardIds(container)).toHaveLength(items.length)
})

test('Priority and Kind combine; Clear in the empty state and Show all each restore the full board with nothing pressed', () => {
  const { container, getByRole, getByText } = renderBoard(KIND_FIXTURE)
  fireEvent.click(chipIn(getByRole, 'Priority', PRIORITY.LOW))
  fireEvent.click(chipIn(getByRole, 'Kind', 'Trivial'))
  expect(cardIds(container)).toEqual(['K-TRIVIAL-LOW'])

  // Narrowed to nothing: an explanation and a Clear button, never a blank board.
  fireEvent.click(chipIn(getByRole, 'Kind', 'Trivial'))
  fireEvent.click(chipIn(getByRole, 'Kind', 'Task'))
  expect(cardIds(container)).toEqual([])
  expect(getByText(/No items match the selected filters/)).toBeTruthy()
  fireEvent.click(getByRole('button', { name: 'Clear' }))
  expect(cardIds(container)).toHaveLength(KIND_FIXTURE.length)
  expect(pressed(container)).toEqual([])

  // Show all now clears the narrowing as well as the hide filters.
  fireEvent.click(chipIn(getByRole, 'Priority', PRIORITY.HIGH))
  fireEvent.click(getByRole('button', { name: 'Waiting on me' }))
  fireEvent.click(getByRole('button', { name: 'Waiting on me' }))
  expect(cardIds(container)).toHaveLength(3)
  fireEvent.click(getByRole('button', { name: 'Show all' }))
  expect(cardIds(container)).toHaveLength(KIND_FIXTURE.length)
  expect(pressed(container)).toEqual([])
})

test('the selections, sort direction and narrowed board survive a reload of stored state', () => {
  vi.useFakeTimers({ now: NOW })
  const items = [...WAITING_FIXTURE, item('LOW-GATE', { cursor: ACCEPT_GATE_INDEX, priority: PRIORITY.LOW, waiting_since: hoursAgo(9) })]
  const first = renderBoard(items)
  fireEvent.click(first.getByRole('button', { name: 'Waiting on me' }))
  fireEvent.click(first.getByRole('button', { name: 'Longest wait' }))
  fireEvent.click(chipIn(first.getByRole, 'Priority', PRIORITY.MEDIUM))
  fireEvent.click(chipIn(first.getByRole, 'Kind', 'Change'))
  const before = cardIds(first.container)
  expect(before).toEqual(['PAUSED', 'RULE', 'GATE'])
  first.unmount()

  boardNarrowing._reloadForTests()
  const { container, getByRole } = renderBoard(items)
  expect(pressed(container).sort()).toEqual(['Waiting on me', PRIORITY.MEDIUM, 'Change'].sort())
  expect(getByRole('button', { name: 'Most recent' })).toBeTruthy()
  expect(cardIds(container)).toEqual(before)
  expect(cardOf(container, 'GATE').querySelector('.card__waiting').textContent).toBe('waiting 5h')
})

test('the Hiding summary counts the narrowing alongside Stale and Closed, and an item caught by both counts once', () => {
  const staleAt = new Date(Date.now() - 45 * 86_400_000).toISOString()
  const items = [
    item('KEEP', { priority: PRIORITY.HIGH }),
    item('OFF-PRIORITY'),
    // Stale AND off-priority: hidden by Stale first, so it is not "filtered" too.
    item('STALE', { last_activity_at: staleAt }),
    item('CLOSED', { cursor: STEPS.length }),
  ]
  const { container, getByRole, getByText } = renderBoard(items, { showAll: false })
  expect(getByText(/Hiding 1 stale, 1 closed$/)).toBeTruthy()
  fireEvent.click(chipIn(getByRole, 'Priority', PRIORITY.HIGH))
  expect(getByText('Hiding 1 stale, 1 closed, 1 filtered')).toBeTruthy()
  expect(cardIds(container)).toEqual(['KEEP'])
  expect(items.length - cardIds(container).length).toBe(3)
})

test('with nothing selected the board is unchanged: every card, in order, with no wait line and no chip pressed', () => {
  vi.useFakeTimers({ now: NOW })
  const { container } = renderBoard(WAITING_FIXTURE)
  expect(cardIds(container)).toEqual(WAITING_FIXTURE.map((it) => it.id))
  expect(container.querySelector('.card__waiting')).toBeNull()
  expect(cardOf(container, 'GATE').querySelector('.card__elapsed').textContent).toMatch(/^Waiting on you · 5h 00m$/)
  expect(pressed(container)).toEqual([])
})

for (const [label, stored] of [
  ['bad JSON', '{not json'],
  ['wrong types and unknown values', JSON.stringify({ priorities: ['Urgent'], kinds: 7, sortDir: 'sideways' })],
]) {
  test(`stored state with ${label} falls back to nothing selected: every card renders`, () => {
    localStorage.setItem(STORAGE_KEY, stored)
    boardNarrowing._reloadForTests()
    const { container, getByRole } = renderBoard(KIND_FIXTURE)
    expect(cardIds(container)).toHaveLength(KIND_FIXTURE.length)
    expect(pressed(container)).toEqual([])
    expect(getByRole('button', { name: 'Waiting on me' }).getAttribute('aria-pressed')).toBe('false')
  })
}
