// Smoke test for the persona confirm control at the intake gate — the human
// leg of HZ-4's specialist routing (QA condition 1: this replaces any
// "manually verified" claim) — plus the HZ-5 Live activity tail.

import { expect, test, vi } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { afterEach } from 'vitest'

const { getRunLogMock } = vi.hoisted(() => ({ getRunLogMock: vi.fn() }))
vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  getRunLog: getRunLogMock,
}))

import Tracker from './Tracker'

afterEach(() => {
  cleanup()
  getRunLogMock.mockReset()
})

const baseItem = {
  id: 'T-1',
  title: 'A work item',
  desc: '',
  metric: '',
  guardrails: '',
  priority: 'Medium',
  cursor: 3, // the "Approve & prioritize this work" gate
  paused: false,
  rejected: false,
  events: [],
  stepOutputs: {},
  activeRun: null,
}

const noop = () => {}

function renderTracker(item, onSetPersona = noop) {
  return render(
    <Tracker
      item={item}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onTogglePause={noop}
      onRestartPhase={noop}
      onSetPersona={onSetPersona}
    />,
  )
}

test('the intake gate shows the persona select, defaulting to the proposed persona', () => {
  const { getByLabelText } = renderTracker({ ...baseItem, persona: 'python_backend' })
  expect(getByLabelText('Specialist persona').value).toBe('python_backend')
})

test('an item with no persona defaults the select to fullstack', () => {
  const { getByLabelText } = renderTracker(baseItem)
  expect(getByLabelText('Specialist persona').value).toBe('fullstack')
})

test('changing the select fires setPersona with the chosen id', () => {
  const spy = vi.fn()
  const { getByLabelText } = renderTracker({ ...baseItem, persona: 'python_backend' }, spy)
  fireEvent.change(getByLabelText('Specialist persona'), { target: { value: 'frontend_ui' } })
  expect(spy).toHaveBeenCalledWith('T-1', 'frontend_ui')
})

test('the select is absent when the item is past the intake gate', () => {
  const { queryByLabelText } = renderTracker({ ...baseItem, cursor: 4, persona: 'python_backend' })
  expect(queryByLabelText('Specialist persona')).toBeNull()
})

// ---- HZ-5: Live activity tail on the running step ----

const runningItem = {
  ...baseItem,
  cursor: 11, // "Specialist agent implements" — an agent step
  activeRun: { id: 7, step_index: 11, attempt: 1, started_at: new Date().toISOString() },
}

test('the running step tails the run log and drains once after active goes false', async () => {
  getRunLogMock
    .mockResolvedValueOnce({ content: '[12:00:01] ⏺ Read(src/app.js)\n', next_offset: 30, active: false })
    .mockResolvedValueOnce({ content: '[12:00:02] final tail line\n', next_offset: 57, active: false })

  const { getByText } = renderTracker(runningItem)

  // The drain read's content must render — the run's last lines are not lost.
  await waitFor(() => getByText(/final tail line/))
  expect(getByText(/⏺ Read/)).toBeTruthy()

  // active:false stops polling after exactly one drain read at the new offset.
  expect(getRunLogMock.mock.calls).toEqual([
    [7, 0],
    [7, 30],
  ])
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(getRunLogMock).toHaveBeenCalledTimes(2)
})

test('no Live activity panel without an active run', () => {
  const { queryByText } = renderTracker({ ...baseItem, cursor: 11, activeRun: null })
  expect(queryByText('Live activity')).toBeNull()
})

test('the panel goes away when the run has no per-run log (PM-session 404)', async () => {
  const err = new Error('unknown run')
  err.status = 404
  getRunLogMock.mockRejectedValue(err)

  const { queryByText } = renderTracker(runningItem)
  await waitFor(() => expect(queryByText('Live activity')).toBeNull())
  expect(getRunLogMock).toHaveBeenCalledTimes(1)
})
