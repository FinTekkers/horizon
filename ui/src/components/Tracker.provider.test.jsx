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
const DEPLOY = requiredStepIndex('Deploy the changes')
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
  expect(STEPS[DEPLOY].kind).toBe('agent')
  expect(STEPS[DEPLOY].providerOverrideEligible).toBe(false)
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
  const scope = within(card(container, DEPLOY))
  expect(scope.getByText('Claude only')).toBeTruthy()
  expect(scope.queryByLabelText('Runs on')).toBeNull()
})

test('a gate shows no provider at all', () => {
  const { container } = renderTracker({})
  const gate = card(container, GATE)
  expect(within(gate).queryByLabelText('Runs on')).toBeNull()
  expect(gate.querySelector('.step-card__provider')).toBeNull()
})

// HZ-369: typed by label on purpose — this pins the metric's exact list, so a
// flag flipped on any other step fails here instead of passing silently.
const RUNS_ON_LABELS = [
  'Plan options & trade-offs (pros / cons)',
  'Draft implementation plan',
  'Architecture review',
  'QA reviews the test plan',
  'Summarize reviews & recommend',
  'Specialist agent implements',
  'Automated review (code + QA)',
]

test('the "Runs on" select renders on exactly steps 4, 6, 7, 8, 9, 11 and 12', () => {
  const { container } = renderTracker({})
  // Change item renders change-kind steps only: Task rows (itemKind "task")
  // have no card here, so they must not be iterated (HZ-377).
  const withSelect = STEPS.flatMap((s, i) => {
    if ((s.itemKind ?? 'change') !== 'change') return []
    return within(card(container, i)).queryByLabelText('Runs on') ? [i] : []
  })
  expect(withSelect).toEqual(RUNS_ON_LABELS.map((label) => requiredStepIndex(label)))
  expect(withSelect).toEqual([4, 6, 7, 8, 9, 11, 12])
})

// HZ-370: the PM steps before intake (0-2) take a choice too, while not done.
test('a re-run of the intake steps offers the select on steps 0, 1 and 2', () => {
  const { container } = renderTracker({ cursor: 0 })
  const before = STEPS.slice(0, INTAKE).flatMap((s, i) => (within(card(container, i)).queryByLabelText('Runs on') ? [i] : []))
  expect(before).toEqual([0, 1, 2])
})

test('Default names the project default when the project sets one, and stays "Default (Claude)" otherwise', () => {
  const { container } = renderTracker({ cursor: 0, projectProviderDefaults: { 0: 'muse' } })
  const option = (i) => within(card(container, i)).getByLabelText('Runs on').querySelector('option[value="default"]')
  expect(option(0).textContent).toBe('Default (Muse, project)')
  expect(option(1).textContent).toBe('Default (Claude)')
})

test('the tool-allowlist note shows on the implement and review dropdowns only', () => {
  const { container } = renderTracker({})
  const note = "Muse ignores the farm's tool allowlist."
  for (const label of RUNS_ON_LABELS) {
    const index = requiredStepIndex(label)
    const shown = within(card(container, index)).queryByText(note) !== null
    expect([label, shown]).toEqual([label, ['Specialist agent implements', 'Automated review (code + QA)'].includes(label)])
  }
})
