// HZ-429: a Task's done Verify & report shows its stored verdict. A fail is a
// red circle-X with its 1-3 line summary, in the step list and in the
// Activity panel; a pass keeps the tick and shows no summary; a run with no
// stored verdict is a neutral '?'. Every other step keeps its icon.

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
import { STEPS, VERIFY_REPORT_STEP_INDEX, RUN_PLAN_STEP_INDEX, requiredStepIndex } from '../../../domain/js/lifecycle.js'

afterEach(() => cleanup())

const VERIFY = VERIFY_REPORT_STEP_INDEX
const ARCH = requiredStepIndex('Architecture review')
const SUMMARY = 'Command 1 crashed on import.\nNone of the 5 metric lines hold.'

const verifyEvent = (verdict, detail) => ({
  who: 'QA',
  text: 'completed “Verify & report” — ran 5 commands',
  detail,
  verdict,
  color: '#2E7D5B',
  initials: 'QA',
  created_at: '2026-10-12 10:00:00',
})

const noop = () => {}

function renderTracker(item) {
  return render(
    <Tracker
      item={{
        id: 'T-429',
        title: 'Backfill',
        desc: '',
        metric: '',
        guardrails: '',
        priority: 'Medium',
        kind: 'task',
        cursor: VERIFY + 1,
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

// The step row (rail icon + card) for one step index, found by its label.
function stepRow(container, index) {
  const label = [...container.querySelectorAll('.step-card__label')].find((el) => el.textContent === STEPS[index].label)
  return label.closest('.step')
}
const iconOf = (container, index) => stepRow(container, index).querySelector('.step__icon')
const activityPanel = (container) => container.querySelector('.tracker__activity')

const verifyOutput = (fields) => ({ output: 'ran 5 commands', attempt: 1, artifact: '## Verdict\n**fail**', label: STEPS[VERIFY].label, ...fields })

test('a fail shows the red circle-X and its summary in the step list', () => {
  const { container } = renderTracker({ stepOutputs: { [VERIFY]: verifyOutput({ verdict: 'fail', verdictSummary: SUMMARY }) } })
  const row = stepRow(container, VERIFY)
  const icon = iconOf(container, VERIFY)
  expect(icon.textContent).not.toContain('✓')
  expect(icon.classList.contains('step__icon--verdict-fail')).toBe(true)
  expect(within(row).getByRole('img', { name: /failed/i })).toBeTruthy()
  expect(within(row).getByTestId('verify-verdict-summary').textContent).toBe(SUMMARY)
  // The full report is still linked beside the summary.
  expect(within(row).getByText('View full artifact ↗')).toBeTruthy()
})

test('a fail shows the red circle-X and its summary in the Activity panel', () => {
  const { container } = renderTracker({
    stepOutputs: { [VERIFY]: verifyOutput({ verdict: 'fail', verdictSummary: SUMMARY }) },
    events: [verifyEvent('fail', SUMMARY)],
  })
  const panel = activityPanel(container)
  expect(within(panel).getByTestId('activity-verdict-fail')).toBeTruthy()
  expect(within(panel).getByRole('img', { name: /failed/i })).toBeTruthy()
  expect(within(panel).getByTestId('activity-verdict-summary').textContent).toBe(SUMMARY)
})

test('a pass keeps the tick, with no red X and no summary', () => {
  const { container } = renderTracker({ stepOutputs: { [VERIFY]: verifyOutput({ verdict: 'pass', verdictSummary: 'All good.' }) } })
  const row = stepRow(container, VERIFY)
  expect(iconOf(container, VERIFY).textContent).toBe('✓')
  expect(within(row).queryByRole('img', { name: /failed/i })).toBeNull()
  expect(within(row).queryByTestId('verify-verdict-summary')).toBeNull()
  expect(within(row).queryByText('All good.')).toBeNull()
})

test('a pass event in the Activity panel shows no badge and no summary', () => {
  const { container } = renderTracker({
    stepOutputs: { [VERIFY]: verifyOutput({ verdict: 'pass', verdictSummary: 'All good.' }) },
    events: [verifyEvent('pass', 'All good.')],
  })
  const panel = activityPanel(container)
  expect(within(panel).queryByTestId('activity-verdict-fail')).toBeNull()
  expect(within(panel).queryByRole('img', { name: /failed/i })).toBeNull()
  expect(within(panel).queryByText('All good.')).toBeNull()
})

test('a run with no stored verdict renders a neutral ?, not a tick or a red X', () => {
  const { container } = renderTracker({
    stepOutputs: { [VERIFY]: verifyOutput({ verdict: null, verdictSummary: null }) },
    events: [verifyEvent(null, null)],
  })
  const icon = iconOf(container, VERIFY)
  expect(icon.textContent).toBe('?')
  expect(icon.classList.contains('step__icon--verdict-unknown')).toBe(true)
  expect(container.querySelector('[data-testid="verify-verdict-fail"]')).toBeNull()
  expect(container.querySelector('[data-testid="activity-verdict-fail"]')).toBeNull()
})

test('before the outputs land, a done Verify & report shows no tick and no red X', () => {
  // No stepOutputs on the item: the Tracker subscribes and waits for a frame.
  const { container } = renderTracker({ stepOutputs: undefined })
  const icon = iconOf(container, VERIFY)
  expect(icon.textContent).not.toContain('✓')
  expect(icon.classList.contains('step__icon--verdict-loading')).toBe(true)
  expect(container.querySelector('[data-testid="verify-verdict-fail"]')).toBeNull()
})

test('a Change step and a Run plan Task step carrying a fail verdict both keep the tick', () => {
  const failing = { verdict: 'fail', verdictSummary: SUMMARY, output: 'ok', attempt: 1, artifact: null }
  const task = renderTracker({ stepOutputs: { [RUN_PLAN_STEP_INDEX]: failing, [VERIFY]: verifyOutput({ verdict: 'pass' }) } })
  expect(iconOf(task.container, RUN_PLAN_STEP_INDEX).textContent).toBe('✓')
  expect(within(stepRow(task.container, RUN_PLAN_STEP_INDEX)).queryByRole('img', { name: /failed/i })).toBeNull()
  cleanup()

  const change = renderTracker({ kind: 'change', cursor: ARCH + 1, stepOutputs: { [ARCH]: failing } })
  expect(iconOf(change.container, ARCH).textContent).toBe('✓')
  expect(change.container.querySelector('[data-testid="verify-verdict-fail"]')).toBeNull()
  expect(within(stepRow(change.container, ARCH)).queryByRole('img', { name: /failed/i })).toBeNull()
})
