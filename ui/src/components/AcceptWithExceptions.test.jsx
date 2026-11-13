// HO-844: Accept with exceptions at a Task's Review & close. The button shows
// only while the server's item carries `acceptWithExceptions`; the dialog
// needs a non-blank reason for each open line and sends { lineId, reason }
// pairs with the offer's hash; a closed item lists every exception.

import { afterEach, expect, test, vi } from 'vitest'
import { render, fireEvent, cleanup, within, waitFor } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(),
  getPlanDraft: vi.fn(async () => null),
  savePlanDraft: vi.fn(),
}))

import Tracker from './Tracker'
import { AcceptWithExceptionsDialog } from './AcceptWithExceptions'
import { TASK_REVIEW_CLOSE_GATE_INDEX, endIndex } from '../../../domain/js/lifecycle.js'
import { servedMoves } from './fixtures/servedMoves'

afterEach(cleanup)

const noop = () => {}
const OFFER = {
  openLines: [
    { id: '2', text: 'Every row has a region.' },
    { id: '3', text: 'The report lists the totals.' },
  ],
  linesHash: 'hash-1',
}
const taskItem = {
  id: 'TK-9',
  title: 'Backfill regions',
  kind: 'task',
  desc: '',
  metric: '1. The backfill exits 0.\n2. Every row has a region.\n3. The report lists the totals.',
  guardrails: '',
  priority: 'High',
  cursor: TASK_REVIEW_CLOSE_GATE_INDEX,
  paused: false,
  rejected: false,
  events: [],
  stepOutputs: {},
  activeRun: null,
  moves: servedMoves({ approve: { key: 'task.review-close', label: 'Review & close' }, targets: [], canAbandon: true, amend: null }),
}

const renderTracker = (item, onAcceptWithExceptions = vi.fn()) =>
  render(
    <Tracker
      item={item}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onMove={noop}
      onResolveConflicts={noop}
      onTogglePause={noop}
      onSetPersona={noop}
      onAbandon={noop}
      onAcceptWithExceptions={onAcceptWithExceptions}
    />,
  )

test('the button shows beside Approve only while the server offers it', () => {
  const { container, rerender } = renderTracker({ ...taskItem, acceptWithExceptions: OFFER })
  const card = container.querySelector('.step-card--awaiting')
  expect(within(card).getByRole('button', { name: 'Accept with exceptions' })).toBeTruthy()
  expect(within(card).getByRole('button', { name: 'Approve' })).toBeTruthy()

  rerender(
    <Tracker item={taskItem} onBack={noop} onApprove={noop} onApproveWithComments={noop} onMove={noop} onResolveConflicts={noop} onTogglePause={noop} onSetPersona={noop} onAbandon={noop} onAcceptWithExceptions={vi.fn()} />,
  )
  expect(within(container.querySelector('.step-card--awaiting')).queryByRole('button', { name: 'Accept with exceptions' })).toBeNull()
})

test('Close stays disabled while any reason is blank or whitespace; it sends trimmed pairs and the hash', async () => {
  const onSubmit = vi.fn(async () => ({ ok: true }))
  const onClose = vi.fn()
  const { getByRole, getByLabelText } = render(<AcceptWithExceptionsDialog itemId="TK-9" offer={OFFER} onSubmit={onSubmit} onClose={onClose} />)
  const dialog = getByRole('dialog', { name: 'Accept with exceptions' })
  expect(dialog.textContent).toContain('Line 2: Every row has a region.')
  expect(dialog.textContent).toContain('Line 3: The report lists the totals.')
  const close = getByRole('button', { name: 'Close with exceptions' })
  expect(close.disabled).toBe(true)

  fireEvent.change(getByLabelText('Reason for metric line 2'), { target: { value: '  Checked by hand.  ' } })
  fireEvent.change(getByLabelText('Reason for metric line 3'), { target: { value: ' \t\n ' } })
  expect(close.disabled).toBe(true)
  fireEvent.change(getByLabelText('Reason for metric line 3'), { target: { value: 'Needs the staging login.' } })
  expect(close.disabled).toBe(false)

  fireEvent.click(close)
  expect(onSubmit).toHaveBeenCalledWith(
    'TK-9',
    [
      { lineId: '2', reason: 'Checked by hand.' },
      { lineId: '3', reason: 'Needs the staging login.' },
    ],
    'hash-1',
  )
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})

test("a refusal shows the server's reason and keeps the dialog open", async () => {
  const onSubmit = vi.fn(async () => {
    throw new Error('open_lines_changed')
  })
  const onClose = vi.fn()
  const { getByRole, getByLabelText, findByRole } = render(<AcceptWithExceptionsDialog itemId="TK-9" offer={OFFER} onSubmit={onSubmit} onClose={onClose} />)
  fireEvent.change(getByLabelText('Reason for metric line 2'), { target: { value: 'a' } })
  fireEvent.change(getByLabelText('Reason for metric line 3'), { target: { value: 'b' } })
  fireEvent.click(getByRole('button', { name: 'Close with exceptions' }))
  expect((await findByRole('alert')).textContent).toContain('open metric lines changed')
  expect(onClose).not.toHaveBeenCalled()
})

test('a closed Task lists every exception with its metric line and reason', () => {
  const exceptions = [
    { id: 1, decisionId: 7, lineId: '2', metricLine: 'Every row has a region.', reason: 'Checked by hand.', decidedBy: 'Dana', createdAt: '2026-11-12 10:00:00' },
    { id: 2, decisionId: 7, lineId: '3', metricLine: 'The report lists the totals.', reason: 'Needs the staging login.', decidedBy: 'Dana', createdAt: '2026-11-12 10:00:00' },
  ]
  const { getByRole } = renderTracker({ ...taskItem, cursor: endIndex('task'), moves: null, exceptions })
  const list = getByRole('region', { name: 'Accepted with exceptions' })
  expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'Line 2: Every row has a region. — Checked by hand.',
    'Line 3: The report lists the totals. — Needs the staging login.',
  ])
  expect(list.textContent).toContain('Dana · 2026-11-12 10:00:00')
})
