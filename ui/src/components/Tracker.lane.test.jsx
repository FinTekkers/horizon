// HZ-435: a trivial item shows its lane, and the rows its lane skips (the
// options, design gate, architecture review and summary rows) read as
// skipped — never as pending, and never as done. A skipped row holds no phase
// open. An item with no lane renders exactly as before.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(() => () => {}),
}))

import Tracker from './Tracker'
import { STEPS, requiredStepIndex } from '../../../domain/js/lifecycle.js'

afterEach(() => cleanup())

const SKIPPED = [
  'Plan options & trade-offs (pros / cons)',
  'Approve the high-level design',
  'Architecture review',
  'Summarize reviews & recommend',
].map((label) => requiredStepIndex(label))
const PLAN = requiredStepIndex('Draft implementation plan')
const PLAN_GATE = requiredStepIndex('Review before execution')

const noop = () => {}

function renderTracker(item) {
  return render(
    <Tracker
      item={{
        id: 'HZ-500',
        title: 'Delete two lines',
        desc: '',
        metric: '',
        guardrails: '',
        priority: 'Medium',
        kind: 'change',
        lane: 'trivial',
        cursor: PLAN,
        paused: false,
        rejected: false,
        events: [],
        activeRun: null,
        providerChoices: {},
        ...item,
      }}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onResolveConflicts={noop}
      onTogglePause={noop}
      onRestartPhase={noop}
      onSetPersona={noop}
      onSetStepProvider={noop}
      onAbandon={noop}
    />,
  )
}

function stepRow(container, index) {
  const label = [...container.querySelectorAll('.step-card__label')].find((el) => el.textContent === STEPS[index].label)
  return label.closest('.step')
}
const phaseHead = (container, name) =>
  [...container.querySelectorAll('.phase__head')].find((el) => el.querySelector('.phase__name').textContent === name)

test('a trivial item shows its lane and reads Skipped on rows 4, 5, 7 and 9', () => {
  const { container, getByTestId } = renderTracker({})
  expect(getByTestId('lane-badge').textContent).toBe('trivial')
  for (const index of SKIPPED) {
    const row = stepRow(container, index)
    expect(within(row).getByText('Skipped — trivial lane')).toBeTruthy()
    expect(row.querySelector('.step__icon--skipped')).toBeTruthy()
  }
  // The rows it runs keep their own status.
  expect(within(stepRow(container, PLAN)).queryByText(/Skipped/)).toBeNull()
  expect(within(stepRow(container, PLAN_GATE)).getByText('Queued')).toBeTruthy()
})

test('a phase whose only open rows are skipped reads Complete', () => {
  // At step 6 the Plan phase's rows are done and nothing in it is skipped;
  // at gate 10 every Technical Plan row is done or skipped.
  const { container } = renderTracker({ cursor: PLAN_GATE + 1 })
  expect(within(phaseHead(container, 'Technical Plan')).getByText('Complete')).toBeTruthy()
})

test('a closed trivial item still shows the skipped rows as skipped', () => {
  const { container } = renderTracker({ cursor: requiredStepIndex('Review the work & close') + 1 })
  for (const index of SKIPPED) expect(within(stepRow(container, index)).getByText('Skipped — trivial lane')).toBeTruthy()
})

test('an item with no lane shows no lane badge and skips nothing', () => {
  const { container, queryByTestId } = renderTracker({ lane: null })
  expect(queryByTestId('lane-badge')).toBeNull()
  expect(container.querySelectorAll('[data-testid="step-skipped"]').length).toBe(0)
  expect(within(stepRow(container, SKIPPED[0])).queryByText(/Skipped/)).toBeNull()
})
