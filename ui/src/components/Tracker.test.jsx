// Smoke test for the persona confirm control at the intake gate — the human
// leg of HZ-4's specialist routing (QA condition 1: this replaces any
// "manually verified" claim).

import { expect, test, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import Tracker from './Tracker'

afterEach(cleanup)

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
