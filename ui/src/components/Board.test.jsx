// HZ-54: the board itself — not just the per-item drawer — must tell a
// queued step apart from an executing one. Reproduces the exact scenario
// the ticket was filed against: six dispatched step_run rows, one agent
// actually running, five sitting in the farm's queue.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import Board from './Board'

afterEach(() => {
  cleanup()
})

const noop = () => {}

function makeItem(id, state) {
  return {
    id,
    title: `Work item ${id}`,
    priority: 'Medium',
    cursor: 11, // "Specialist agent implements" — an Eng agent step, phase "Execute"
    issue: null,
    pr: null,
    paused: false,
    rejected: false,
    persona: 'fullstack',
    activeRun: {
      id: Number(id.split('-')[1]) || 1,
      step_index: 11,
      attempt: 1,
      started_at: new Date().toISOString(),
      state,
      reason: state === 'queued' ? 'waiting for a free agent slot (4/4 in use)' : null,
    },
  }
}

test('one running and five queued dispatched steps render as one "working" card and five "Queued" cards, not six in progress', () => {
  const items = [
    makeItem('HZ-22', 'running'),
    makeItem('HZ-50', 'queued'),
    makeItem('HZ-46', 'queued'),
    makeItem('HZ-51', 'queued'),
    makeItem('HZ-38', 'queued'),
    makeItem('HZ-28', 'queued'),
  ]
  const { getAllByText } = render(
    <Board items={items} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />,
  )
  expect(getAllByText('Queued')).toHaveLength(5)
  expect(getAllByText('Eng agent')).toHaveLength(1)
})

test('a queued card carries the farm-reported reason as a tooltip', () => {
  const items = [makeItem('HZ-50', 'queued')]
  const { getByText } = render(
    <Board items={items} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />,
  )
  expect(getByText('Queued').closest('.status-pill').title).toBe('waiting for a free agent slot (4/4 in use)')
})

test('a dispatched step with no farm state at all still reads "working" — fail soft to today\'s presentation', () => {
  const items = [
    {
      ...makeItem('HZ-1', 'running'),
      activeRun: { id: 1, step_index: 11, attempt: 1, started_at: new Date().toISOString() },
    },
  ]
  const { getByText, queryByText } = render(
    <Board items={items} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />,
  )
  expect(getByText('Eng agent')).toBeTruthy()
  expect(queryByText('Queued')).toBeNull()
})

// ---- HZ-95: dependency badges on the board card ----

function depItem(id, deps) {
  return { ...makeItem(id, 'running'), activeRun: null, blockedBy: [], dependents: [], ...deps }
}

test('a card blocked by another item names the blocker, never bare "Blocked"', () => {
  const items = [depItem('HZ-90', { blockedBy: [{ id: 'HZ-89', title: 'The prerequisite', abandoned: false }] })]
  const { getByText } = render(
    <Board items={items} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />,
  )
  expect(getByText(/Blocked by HZ-89/)).toBeTruthy()
})

test('a card with dependents shows what is waiting behind it', () => {
  const items = [depItem('HZ-91', { dependents: [{ id: 'HZ-92', title: 'Waiting item', abandoned: false }] })]
  const { getByText } = render(
    <Board items={items} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />,
  )
  expect(getByText('Blocks 1')).toBeTruthy()
})

test('a card with both a blocker and dependents shows both, each visually distinct', () => {
  const items = [
    depItem('HZ-93', {
      blockedBy: [{ id: 'HZ-89', title: 'The prerequisite', abandoned: false }],
      dependents: [{ id: 'HZ-92', title: 'Waiting item', abandoned: false }],
    }),
  ]
  const { getByText, container } = render(
    <Board items={items} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />,
  )
  expect(getByText(/Blocked by HZ-89/)).toBeTruthy()
  expect(getByText('Blocks 1')).toBeTruthy()
  const blocked = container.querySelector('.dep-pill--blocked')
  const blocks = container.querySelector('.dep-pill--dependents')
  expect(blocked.className).not.toBe(blocks.className)
})

test('an item with neither direction renders no dependency badge at all, unchanged from before HZ-95', () => {
  const items = [depItem('HZ-94', {})]
  const { container, queryByText } = render(
    <Board items={items} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />,
  )
  expect(container.querySelector('.dep-badges')).toBeNull()
  expect(queryByText(/Blocked/)).toBeNull()
  expect(queryByText(/Blocks/)).toBeNull()
})

test('a blocked card and a paused card render distinct badges/pills, not one collapsed indicator', () => {
  const items = [
    depItem('HZ-95', { blockedBy: [{ id: 'HZ-89', title: 'The prerequisite', abandoned: false }] }),
    { ...makeItem('HZ-96', 'running'), activeRun: null, paused: true, blockedBy: [], dependents: [] },
  ]
  const { getByText, container } = render(
    <Board items={items} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />,
  )
  expect(getByText('Paused')).toBeTruthy()
  expect(getByText(/Blocked by HZ-89/)).toBeTruthy()
  const pausedPill = getByText('Paused').closest('.status-pill')
  const blockedPill = container.querySelector('.dep-pill--blocked')
  expect(pausedPill.className).not.toBe(blockedPill.className)
})
