// HZ-561: a step ahead of the cursor that already ran (the item moved back
// past it, e.g. review sent it back to implement) shows its newest finished
// attempt's outcome and links that attempt's artifact, not the queued look. A
// step that never ran, or is running again, renders exactly as before, and so
// do the current step and the steps behind the cursor.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: (id, i, a) => (a ? `/api/items/${id}/artifacts/${i}/${a}` : `/api/items/${id}/artifacts/${i}`),
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(() => () => {}),
}))

import Tracker from './Tracker'
import { STEPS, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX } from '../../../domain/js/lifecycle.js'

afterEach(() => cleanup())

const IMPL = IMPLEMENT_STEP_INDEX
const REVIEW = REVIEW_STEP_INDEX
// The last agent step behind the cursor (the one just before it is a gate).
const BEHIND = IMPL - 2

const noop = () => {}

function renderTracker(item) {
  return render(
    <Tracker
      item={{
        id: 'HZ-561',
        title: 'Ran-ahead step',
        desc: '',
        metric: '',
        guardrails: '',
        priority: 'Medium',
        kind: 'change',
        cursor: IMPL,
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
      onForwardToAccept={noop}
    />,
  )
}

function stepRow(container, index) {
  const label = [...container.querySelectorAll('.step-card__label')].find((el) => el.textContent === STEPS[index].label)
  return label.closest('.step')
}
const iconOf = (container, index) => stepRow(container, index).querySelector('.step__icon')
const metaOf = (container, index) => stepRow(container, index).querySelector('.step-card__meta').textContent

const run = (index, attempt, fields = {}) => ({
  output: 'ran',
  attempt,
  attemptCount: attempt,
  artifact: `## Attempt ${attempt}`,
  label: STEPS[index].label,
  ...fields,
})
const behindOutputs = { [BEHIND]: run(BEHIND, 1), [IMPL]: run(IMPL, 1) }

test('metric 1: a review that failed and sent the item back shows that outcome and links attempt 1', () => {
  const { container } = renderTracker({ reviewRejected: true, stepOutputs: { ...behindOutputs, [REVIEW]: run(REVIEW, 1) } })
  const row = stepRow(container, REVIEW)
  expect(metaOf(container, REVIEW)).toBe('Failed, sent back · attempt 1')
  expect(within(row).queryByText('Queued')).toBeNull()
  const link = within(row).getByRole('link', { name: 'View attempt 1 ↗' })
  expect(link.getAttribute('href')).toBe('/api/items/HZ-561/artifacts/12/1')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(iconOf(container, REVIEW).classList.contains('step__icon--ran-ahead')).toBe(true)
  expect(iconOf(container, REVIEW).classList.contains('step__icon--verdict-fail')).toBe(true)
  expect(row.querySelector('.step-card').classList.contains('step-card--ran-ahead-failed')).toBe(true)
})

test('metric 2: with two finished attempts it shows attempt 2 and links /12/2', () => {
  const { container } = renderTracker({ reviewRejected: true, stepOutputs: { ...behindOutputs, [REVIEW]: run(REVIEW, 2) } })
  const row = stepRow(container, REVIEW)
  expect(metaOf(container, REVIEW)).toBe('Failed, sent back · attempt 2')
  const link = within(row).getByRole('link', { name: 'View attempt 2 ↗' })
  expect(link.getAttribute('href')).toBe('/api/items/HZ-561/artifacts/12/2')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(within(row).queryByRole('link', { name: /attempt 1/ })).toBeNull()
})

test('metric 3: a running attempt 2 shows the running state, not attempt 1', () => {
  const { container } = renderTracker({
    cursor: REVIEW,
    activeRun: { step_index: REVIEW, attempt: 2, state: 'running', started_at: new Date().toISOString() },
    stepOutputs: { ...behindOutputs, [REVIEW]: run(REVIEW, 1) },
  })
  const row = stepRow(container, REVIEW)
  expect(metaOf(container, REVIEW)).toContain('In progress…')
  expect(metaOf(container, REVIEW)).toContain('attempt 2')
  expect(metaOf(container, REVIEW)).not.toContain('attempt 1')
  expect(within(row).queryByTestId('ran-ahead-artifact')).toBeNull()
  expect(row.querySelector('.step-card--ran-ahead')).toBeNull()
})

test('metric 4: a step ahead of the cursor that never ran still shows as queued', () => {
  const { container } = renderTracker({ reviewRejected: true, stepOutputs: behindOutputs })
  const row = stepRow(container, REVIEW)
  expect(metaOf(container, REVIEW)).toBe('Queued')
  const icon = iconOf(container, REVIEW)
  expect(icon.className).toBe('step__icon step__icon--pending')
  expect(icon.textContent).toBe('')
  expect(row.querySelector('.step-card').className).toBe('step-card')
  expect(within(row).queryByRole('link')).toBeNull()
})

test('the current step renders exactly as without the ran-ahead review', () => {
  const before = renderTracker({ reviewRejected: true, stepOutputs: behindOutputs })
  const baseline = stepRow(before.container, IMPL).outerHTML
  cleanup()
  const { container } = renderTracker({ reviewRejected: true, stepOutputs: { ...behindOutputs, [REVIEW]: run(REVIEW, 1) } })
  const row = stepRow(container, IMPL)
  expect(row.outerHTML).toBe(baseline)
  expect(metaOf(container, IMPL)).toBe('In progress…')
  expect(iconOf(container, IMPL).className).toBe('step__icon step__icon--active')
  expect(row.querySelector('.step-card--ran-ahead')).toBeNull()
  expect(within(row).queryByTestId('ran-ahead-artifact')).toBeNull()
  expect(within(row).getByRole('button', { name: `Forward to ${STEPS[REVIEW + 1].label}` })).toBeTruthy()
})

test('a step behind the cursor renders exactly as without the ran-ahead review', () => {
  const before = renderTracker({ reviewRejected: true, stepOutputs: behindOutputs })
  const baseline = stepRow(before.container, BEHIND).outerHTML
  cleanup()
  const { container } = renderTracker({ reviewRejected: true, stepOutputs: { ...behindOutputs, [REVIEW]: run(REVIEW, 1) } })
  const row = stepRow(container, BEHIND)
  expect(row.outerHTML).toBe(baseline)
  expect(metaOf(container, BEHIND)).toBe('Completed')
  const link = within(row).getByRole('link', { name: 'View full artifact ↗' })
  expect(link.getAttribute('href')).toBe(`/api/items/HZ-561/artifacts/${BEHIND}`)
})

test('a passed review a human later sent back reads "Completed earlier", not failed', () => {
  const { container } = renderTracker({ reviewRejected: false, stepOutputs: { ...behindOutputs, [REVIEW]: run(REVIEW, 1) } })
  const row = stepRow(container, REVIEW)
  expect(metaOf(container, REVIEW)).toBe('Completed earlier · attempt 1')
  expect(iconOf(container, REVIEW).classList.contains('step__icon--verdict-fail')).toBe(false)
  expect(row.querySelector('.step-card--ran-ahead-failed')).toBeNull()
  expect(within(row).getByRole('link', { name: 'View attempt 1 ↗' }).getAttribute('href')).toBe('/api/items/HZ-561/artifacts/12/1')
})

test('a newest attempt with no artifact stays queued', () => {
  const { container } = renderTracker({ reviewRejected: true, stepOutputs: { ...behindOutputs, [REVIEW]: run(REVIEW, 1, { artifact: null }) } })
  expect(metaOf(container, REVIEW)).toBe('Queued')
  expect(within(stepRow(container, REVIEW)).queryByRole('link')).toBeNull()
})
