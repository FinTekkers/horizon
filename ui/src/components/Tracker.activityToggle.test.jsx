// HZ-488: the Activity column's minimize toggle — minimized hides the rows
// and shows an expand strip, the choice persists across items and reloads,
// both controls are labelled buttons, and blocked storage keeps the page
// working expanded.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: (itemId, stepIndex) => `https://example.test/api/items/${itemId}/steps/${stepIndex}/output`,
  runLogViewUrl: (runId) => `https://example.test/api/runs/${runId}/log/view`,
  subscribeStepOutputs: vi.fn(),
}))

import Tracker from './Tracker'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

const baseItem = {
  id: 'T-1',
  title: 'A work item',
  desc: '',
  metric: '',
  guardrails: '',
  priority: 'Medium',
  cursor: 3,
  paused: false,
  rejected: false,
  events: [],
  stepOutputs: {},
  activeRun: null,
}

const noop = () => {}

function renderTracker(item) {
  return render(
    <Tracker
      item={item}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onResolveConflicts={noop}
      onTogglePause={noop}
      onRestartPhase={noop}
      onSetPersona={noop}
      onAbandon={noop}
    />,
  )
}

function renderTrackerWith(item) {
  const rendered = renderTracker(item)
  return {
    ...rendered,
    rerenderItem: (next) =>
      rendered.rerender(
        <Tracker
          item={next}
          onBack={noop}
          onApprove={noop}
          onApproveWithComments={noop}
          onReject={noop}
          onResolveConflicts={noop}
          onTogglePause={noop}
          onRestartPhase={noop}
          onSetPersona={noop}
          onAbandon={noop}
        />,
      ),
  }
}

test('clicking Minimize hides the rows, shows the expand strip and widens Lifecycle; Expand restores both', () => {
  const { container, getByLabelText, queryByLabelText } = renderTracker(baseItem)
  const body = container.querySelector('.tracker__body')
  expect(container.querySelectorAll('.activity-row').length).toBeGreaterThan(0)
  expect(queryByLabelText('Expand Activity')).toBeNull()

  fireEvent.click(getByLabelText('Minimize Activity'))

  expect(container.querySelectorAll('.activity-row').length).toBe(0)
  expect(container.querySelector('.activity-empty')).toBeNull()
  const expand = getByLabelText('Expand Activity')
  expect(expand.textContent).toContain('Activity')
  // jsdom does no layout, so the modifier class stands in for Lifecycle widening.
  expect(body.classList.contains('tracker__body--activity-min')).toBe(true)

  fireEvent.click(expand)

  expect(container.querySelectorAll('.activity-row').length).toBeGreaterThan(0)
  expect(queryByLabelText('Expand Activity')).toBeNull()
  expect(body.classList.contains('tracker__body--activity-min')).toBe(false)
})

test('minimized stays minimized across a re-render on another item; clearing the stored choice shows expanded', () => {
  const first = renderTrackerWith(baseItem)
  fireEvent.click(first.getByLabelText('Minimize Activity'))
  expect(first.queryByLabelText('Expand Activity')).not.toBeNull()

  first.rerenderItem({ ...baseItem, id: 'T-2', title: 'Another item' })
  expect(first.queryByLabelText('Expand Activity')).not.toBeNull()
  expect(first.container.querySelectorAll('.activity-row').length).toBe(0)
  first.unmount()

  // A reload reads the stored choice back.
  const reloaded = renderTracker({ ...baseItem, id: 'T-2', title: 'Another item' })
  expect(reloaded.queryByLabelText('Expand Activity')).not.toBeNull()
  reloaded.unmount()

  // Clearing the stored choice restores the expanded default.
  localStorage.clear()
  const fresh = renderTracker({ ...baseItem, id: 'T-2', title: 'Another item' })
  expect(fresh.queryByLabelText('Minimize Activity')).not.toBeNull()
  expect(fresh.container.querySelectorAll('.activity-row').length).toBeGreaterThan(0)
})

test('both controls are buttons with aria-expanded and an aria-label', () => {
  const { getByLabelText } = renderTracker(baseItem)
  const minimize = getByLabelText('Minimize Activity')
  expect(minimize.tagName).toBe('BUTTON')
  expect(minimize.getAttribute('aria-expanded')).toBe('true')

  fireEvent.click(minimize)

  const expand = getByLabelText('Expand Activity')
  expect(expand.tagName).toBe('BUTTON')
  expect(expand.getAttribute('aria-expanded')).toBe('false')
})

test('blocked storage renders expanded and the toggle still works', () => {
  const storageProto = Object.getPrototypeOf(localStorage)
  vi.spyOn(storageProto, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(storageProto, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })

  const { container, getByLabelText } = renderTracker(baseItem)
  expect(getByLabelText('Minimize Activity')).not.toBeNull()
  expect(container.querySelectorAll('.activity-row').length).toBeGreaterThan(0)

  fireEvent.click(getByLabelText('Minimize Activity'))
  expect(container.querySelectorAll('.activity-row').length).toBe(0)
  expect(getByLabelText('Expand Activity')).not.toBeNull()
})
