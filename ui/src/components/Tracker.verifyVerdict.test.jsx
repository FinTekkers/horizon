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
import {
  STEPS,
  VERIFY_REPORT_STEP_INDEX,
  RUN_PLAN_STEP_INDEX,
  REVIEW_STEP_INDEX,
  DEPLOY_STEP_INDEX,
  TASK_REVIEW_CLOSE_GATE_INDEX,
  endIndex,
  requiredStepIndex,
} from '../../../domain/js/lifecycle.js'

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

// ---- HO-848: HO-841's Verify outcome and Execute cause ----

const outcomeRow = (output) => {
  const { container } = renderTracker({ stepOutputs: { [VERIFY]: verifyOutput({ verdictSummary: SUMMARY, ...output }) } })
  return { container, row: stepRow(container, VERIFY), icon: iconOf(container, VERIFY) }
}

test('done_proof_incomplete has its own icon, label and outcome line, unlike work_failed; both show the summary', () => {
  const proof = outcomeRow({ verdict: 'fail', verifyOutcome: 'done_proof_incomplete', executeCause: null })
  expect(proof.icon.classList.contains('step__icon--verdict-proof')).toBe(true)
  expect(proof.icon.classList.contains('step__icon--verdict-fail')).toBe(false)
  expect(within(proof.row).getByRole('img', { name: 'Done, proof incomplete' })).toBeTruthy()
  expect(within(proof.row).queryByRole('img', { name: /failed/i })).toBeNull()
  expect(within(proof.row).getByTestId('verify-outcome').textContent).toBe('Done, proof incomplete')
  expect(within(proof.row).getByTestId('verify-verdict-proof-incomplete')).toBe(proof.icon)
  expect(within(proof.row).getByTestId('verify-verdict-summary').textContent).toBe(SUMMARY)
  cleanup()

  const failed = outcomeRow({ verdict: 'fail', verifyOutcome: 'work_failed', executeCause: null })
  expect(failed.icon.classList.contains('step__icon--verdict-fail')).toBe(true)
  expect(failed.icon.classList.contains('step__icon--verdict-proof')).toBe(false)
  expect(within(failed.row).getByRole('img', { name: 'Verify & report failed' })).toBeTruthy()
  expect(within(failed.row).queryByRole('img', { name: 'Done, proof incomplete' })).toBeNull()
  expect(within(failed.row).getByTestId('verify-outcome').textContent).toBe('Verify & report failed')
  expect(within(failed.row).getByTestId('verify-verdict-fail')).toBe(failed.icon)
  expect(within(failed.row).getByTestId('verify-verdict-summary').textContent).toBe(SUMMARY)
})

test('an Execute cause shows beside the verdict; no cause shows no chip', () => {
  const caused = outcomeRow({ verdict: 'fail', verifyOutcome: 'work_failed', executeCause: 'prereq' })
  const line = within(caused.row).getByTestId('verify-outcome')
  expect(within(line).getByTestId('verify-execute-cause').textContent).toBe('prereq')
  expect(line.textContent).toBe('Verify & report failedprereq')
  cleanup()

  const none = outcomeRow({ verdict: 'fail', verifyOutcome: 'work_failed', executeCause: null })
  expect(within(none.row).getByTestId('verify-outcome')).toBeTruthy()
  expect(none.container.querySelector('[data-testid="verify-execute-cause"]')).toBeNull()
})

test('a historic fail with no stored outcome looks exactly like work_failed, with no cause', () => {
  const current = outcomeRow({ verdict: 'fail', verifyOutcome: 'work_failed', executeCause: null })
  const currentClass = current.icon.className
  const currentLabel = within(current.row).getByRole('img', { name: /failed/i }).getAttribute('aria-label')
  const currentLine = within(current.row).getByTestId('verify-outcome').textContent
  cleanup()

  const historic = outcomeRow({ verdict: 'fail' })
  expect(historic.icon.className).toBe(currentClass)
  expect(within(historic.row).getByRole('img', { name: /failed/i }).getAttribute('aria-label')).toBe(currentLabel)
  expect(within(historic.row).getByTestId('verify-outcome').textContent).toBe(currentLine)
  expect(historic.container.querySelector('[data-testid="verify-execute-cause"]')).toBeNull()
})

// HO-841's stepOutputs() reads an outcome off every step row, so a failed
// Review or Deploy arrives with verifyOutcome too. Their rendering is unchanged.
test('Review, Deploy and Review & close with the HO-841 outcome fields keep their icons and show no outcome or cause', () => {
  const plain = { output: 'ok', attempt: 1, artifact: '## Verdict\n**fail**', verdict: 'fail', verdictSummary: SUMMARY }
  const cases = [
    { kind: 'change', cursor: endIndex('change'), indexes: [REVIEW_STEP_INDEX, DEPLOY_STEP_INDEX] },
    { kind: 'task', cursor: endIndex('task') + 1, indexes: [TASK_REVIEW_CLOSE_GATE_INDEX] },
  ]
  for (const { kind, cursor, indexes } of cases) {
    const outputsWith = (extra) => Object.fromEntries(indexes.map((i) => [i, { ...plain, ...extra }]))
    const baseline = renderTracker({ kind, cursor, stepOutputs: outputsWith({}) })
    const before = indexes.map((i) => iconOf(baseline.container, i).className)
    const beforeMeta = indexes.map((i) => stepRow(baseline.container, i).querySelector('.step-card__meta').textContent)
    cleanup()

    for (const extra of [
      { verifyOutcome: 'work_failed', executeCause: null },
      { verifyOutcome: 'done_proof_incomplete', executeCause: 'prereq' },
    ]) {
      const { container } = renderTracker({ kind, cursor, stepOutputs: outputsWith(extra) })
      expect(indexes.map((i) => iconOf(container, i).className)).toEqual(before)
      expect(indexes.map((i) => stepRow(container, i).querySelector('.step-card__meta').textContent)).toEqual(beforeMeta)
      for (const i of indexes) {
        const row = stepRow(container, i)
        expect(within(row).queryByTestId('verify-outcome')).toBeNull()
        expect(within(row).queryByTestId('verify-execute-cause')).toBeNull()
        expect(within(row).queryByRole('img', { name: 'Done, proof incomplete' })).toBeNull()
        expect(row.querySelector('.step__icon--verdict-proof')).toBeNull()
      }
      cleanup()
    }
  }
})

test('an unknown Execute cause shows no chip and never its raw value', () => {
  const { row, container } = outcomeRow({ verdict: 'fail', verifyOutcome: 'work_failed', executeCause: 'bogus' })
  expect(within(row).getByTestId('verify-outcome').textContent).toBe('Verify & report failed')
  expect(container.querySelector('[data-testid="verify-execute-cause"]')).toBeNull()
  expect(container.textContent).not.toContain('bogus')
})

test('an unknown outcome, or no verdict at all, renders the neutral ? and no outcome line', () => {
  for (const output of [{ verdict: 'fail', verifyOutcome: 'bogus', executeCause: 'prereq' }, { verdict: null, verdictSummary: null }]) {
    const { icon, row, container } = outcomeRow(output)
    expect(icon.textContent).toBe('?')
    expect(icon.classList.contains('step__icon--verdict-unknown')).toBe(true)
    expect(within(row).queryByTestId('verify-outcome')).toBeNull()
    expect(container.querySelector('[data-testid="verify-execute-cause"]')).toBeNull()
    expect(container.textContent).not.toContain('bogus')
    cleanup()
  }
})
