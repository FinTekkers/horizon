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
