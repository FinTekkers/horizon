// HZ-360: while a Horizon self-deploy drains, a card at Accept the code reads
// Queued to merge with the drain's latest end and whose Accept is waiting —
// and offers no Approve or Send back. A stale tab whose Approve the server
// held shows the same, from the real data layer.

import { expect, test, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import Board from './Board'
import { ACCEPT_GATE_INDEX } from '../../../domain/js/lifecycle.js'
import { clockTime } from '../domain/status'
import * as boardFilters from '../boardFilters'

const LATEST_END = '2026-10-08T19:37:52.000Z'
const BLOCK = { blocked: true, startedAt: '2026-10-08T19:12:52.000Z', latestEnd: LATEST_END }
const QUEUED_TEXT = `Queued to merge: Horizon is deploying, merges resume after it (by about ${clockTime(LATEST_END)})`

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
  boardFilters._resetForTests()
})

const noop = () => {}

function item(id, extra = {}) {
  return {
    id,
    title: `Item ${id}`,
    priority: 'Medium',
    cursor: ACCEPT_GATE_INDEX,
    issue: null,
    pr: 354,
    pr_url: 'https://example.test/pr/354',
    paused: false,
    rejected: false,
    abandoned_at: null,
    personas: { eng: 'fullstack' },
    activeRun: null,
    gateAction: null,
    conflictRun: null,
    state_since: null,
    blockedBy: [],
    dependents: [],
    acceptWaiting: null,
    ...extra,
  }
}

function renderBoard(items, deployBlock, viewerName = 'Dana') {
  return render(
    <Board
      items={items}
      durationEstimates={null}
      deployBlock={deployBlock}
      viewerName={viewerName}
      onOpen={noop}
      onApprove={noop}
      onReject={noop}
      onTogglePause={noop}
      onNewItem={noop}
    />,
  )
}

const cardOf = (container, id) => [...container.querySelectorAll('.card')].find((c) => c.querySelector('.card__id')?.textContent === id)
const buttons = (card) => [...card.querySelectorAll('button')].map((b) => b.textContent)

test('a card at Accept the code during a drain reads Queued to merge, names the approver, and has no gate buttons', () => {
  const { container } = renderBoard(
    [
      item('Q-auto', { acceptWaiting: { source: 'autopilot' } }),
      item('Q-you', { acceptWaiting: { source: 'human', actor: 'Dana' } }),
      item('Q-sam', { acceptWaiting: { source: 'human', actor: 'Sam' } }),
      item('Q-none'),
    ],
    BLOCK,
  )
  const expected = { 'Q-auto': 'Approved by Autopilot', 'Q-you': 'Approved by you', 'Q-sam': 'Approved by Sam', 'Q-none': null }
  for (const [id, approvedBy] of Object.entries(expected)) {
    const card = cardOf(container, id)
    expect(card.querySelector('.status-pill').textContent).toBe('Queued to merge')
    expect(card.querySelector('.card__queued').textContent).toContain(QUEUED_TEXT)
    expect(card.querySelector('.card__queued-by')?.textContent ?? null).toBe(approvedBy)
    expect(buttons(card)).not.toContain('Approve')
    expect(buttons(card)).not.toContain('Send back')
  }
})

test('with no drain the same card keeps Approve and Send back', () => {
  const { container } = renderBoard([item('Q-1')], null)
  const card = cardOf(container, 'Q-1')
  expect(card.querySelector('.card__queued')).toBeNull()
  expect(buttons(card)).toEqual(expect.arrayContaining(['Approve', 'Send back']))
})

class MockEventSource {
  constructor() {
    MockEventSource.instances.push(this)
  }
  addEventListener() {}
  close() {}
}
MockEventSource.instances = []

beforeEach(() => {
  MockEventSource.instances = []
})

test('a stale tab that clicks Approve and gets {held: true} shows the card queued, not approved', async () => {
  vi.stubGlobal('EventSource', MockEventSource)
  localStorage.setItem('horizon_gate_pin', 'test-pin')
  const serverApi = await import('../api/serverApi')
  serverApi.subscribe(() => {})
  // This tab never heard of the drain: no deployBlock in its snapshot.
  MockEventSource.instances.at(-1).onmessage({ data: JSON.stringify({ items: [item('Q-stale')] }) })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, held: true, latestEnd: LATEST_END, actor: 'Dana' }) })),
  )
  await serverApi.approveGate('Q-stale', '')
  localStorage.clear()

  const { container } = renderBoard(serverApi.getItems(), serverApi.getDeployBlock())
  const card = cardOf(container, 'Q-stale')
  expect(card.querySelector('.card__queued').textContent).toContain(QUEUED_TEXT)
  expect(card.querySelector('.card__queued-by').textContent).toBe('Approved by you')
  expect(card.textContent).not.toMatch(/Approved by Autopilot/)
  expect(buttons(card)).not.toContain('Approve')
})
