// HZ-357: the "Runs on" picker on the item page's step list. Every state the
// metric names: an eligible step that hasn't started (or is being re-run) has
// the select, a non-default choice is highlighted, a running step is
// read-only, a finished step shows what it ran on, a step that can't be
// switched says "Claude only", and a gate shows nothing. Eligibility is read
// from domain/steps.json, so the indices below are derived, not typed.

import { afterEach, expect, test, vi } from 'vitest'
import { render, fireEvent, cleanup, within } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(),
}))

import Tracker from './Tracker'
import { STEPS, requiredStepIndex } from '../../../domain/js/lifecycle.js'

afterEach(() => cleanup())

const ARCH = requiredStepIndex('Architecture review')
const QA = requiredStepIndex('QA reviews the test plan')
const GATE = requiredStepIndex('Review before execution')
const INTAKE = requiredStepIndex('Approve & prioritize this work')

const baseItem = {
  id: 'T-1',
  title: 'A work item',
  desc: '',
  metric: '',
  guardrails: '',
  priority: 'Medium',
  cursor: INTAKE,
  paused: false,
  rejected: false,
  events: [],
  stepOutputs: {},
  activeRun: null,
  providerChoices: {},
}

const noop = () => {}

function renderTracker(item, onSetStepProvider = noop) {
  return render(
    <Tracker
      item={{ ...baseItem, ...item }}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onResolveConflicts={noop}
      onTogglePause={noop}
      onRestartPhase={noop}
      onSetPersona={noop}
      onSetStepProvider={onSetStepProvider}
      onAbandon={noop}
    />,
  )
}

// The step card for one step index, found by its label.
function card(container, index) {
  const label = [...container.querySelectorAll('.step-card__label')].find((el) => el.textContent === STEPS[index].label)
  return label.closest('.step-card')
}

test('sanity: the step under test is eligible and the others are not', () => {
  expect(STEPS[ARCH].providerOverrideEligible).toBe(true)
  expect(STEPS[QA].kind).toBe('agent')
  expect(STEPS[QA].providerOverrideEligible).toBe(false)
  expect(STEPS[GATE].kind).toBe('gate')
})

test('a pending eligible step offers Default (Claude), Claude and Muse, and a change saves it', () => {
  const onSetStepProvider = vi.fn(() => Promise.resolve({ ok: true }))
  const { container } = renderTracker({}, onSetStepProvider)
  const select = within(card(container, ARCH)).getByLabelText('Runs on')

  expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
    ['default', 'Default (Claude)'],
    ['claude', 'Claude'],
    ['muse', 'Muse'],
  ])
  expect(select.value).toBe('default')
  expect(select.className).not.toMatch(/--override/)

  fireEvent.change(select, { target: { value: 'muse' } })
  expect(onSetStepProvider).toHaveBeenCalledWith('T-1', ARCH, 'muse')
})

test('a saved non-default choice is shown and highlighted', () => {
  const { container } = renderTracker({ providerChoices: { [ARCH]: 'muse' } })
  const select = within(card(container, ARCH)).getByLabelText('Runs on')
  expect(select.value).toBe('muse')
  expect(select.className).toMatch(/step-card__provider-select--override/)
})

test('a failed save puts the saved value back and says why', async () => {
  const onSetStepProvider = vi.fn(() => Promise.reject(new Error('closed')))
  const { container } = renderTracker({}, onSetStepProvider)
  const scope = within(card(container, ARCH))
  fireEvent.change(scope.getByLabelText('Runs on'), { target: { value: 'muse' } })
  expect((await scope.findByRole('alert')).textContent).toBe('This item is closed.')
  expect(scope.getByLabelText('Runs on').value).toBe('default')
})

test('a finished step shows the provider it ran on, with no select', () => {
  const { container } = renderTracker({
    cursor: ARCH + 1,
    stepOutputs: { [ARCH]: { output: 'done', attempt: 1, artifact: null, attemptCount: 0, provider: 'muse' } },
  })
  const scope = within(card(container, ARCH))
  expect(scope.getByText('Ran on Muse')).toBeTruthy()
  expect(scope.queryByLabelText('Runs on')).toBeNull()
})

test('a running step shows its provider read-only', () => {
  const { container } = renderTracker({
    cursor: ARCH,
    providerChoices: { [ARCH]: 'muse' },
    activeRun: { step_index: ARCH, state: 'running', attempt: 1, started_at: new Date().toISOString() },
  })
  const scope = within(card(container, ARCH))
  expect(scope.getByText('Runs on Muse')).toBeTruthy()
  expect(scope.queryByLabelText('Runs on')).toBeNull()
})

test('a step being re-run, at the cursor with an earlier run on record, offers the select again', () => {
  const { container } = renderTracker({
    cursor: ARCH,
    rejected: true,
    stepOutputs: { [ARCH]: { output: 'v1', attempt: 1, artifact: null, attemptCount: 0, provider: 'claude' } },
  })
  const scope = within(card(container, ARCH))
  expect(scope.getByLabelText('Runs on')).toBeTruthy()
  expect(scope.queryByText('Ran on Claude')).toBeNull()
})

test('a step that is not eligible shows "Claude only" and no select', () => {
  const { container } = renderTracker({})
  const scope = within(card(container, QA))
  expect(scope.getByText('Claude only')).toBeTruthy()
  expect(scope.queryByLabelText('Runs on')).toBeNull()
})

test('a gate shows no provider at all', () => {
  const { container } = renderTracker({})
  const gate = card(container, GATE)
  expect(within(gate).queryByLabelText('Runs on')).toBeNull()
  expect(gate.querySelector('.step-card__provider')).toBeNull()
})
