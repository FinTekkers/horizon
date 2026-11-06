// HZ-803: a step card says when the result it shows finished, in the viewer's
// timezone, and labels an old result shown after a send-back or restart
// "previous attempt". Fixed clock and an explicit timeZone prop, so neither the
// host's clock nor its zone changes the text.

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-06T16:06:00Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const IMPL = IMPLEMENT_STEP_INDEX
const REVIEW = REVIEW_STEP_INDEX
const noop = () => {}

function item(fields) {
  return {
    id: 'HZ-803',
    title: 'Run times',
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
    ...fields,
  }
}

function tracker(fields, timeZone = 'UTC') {
  return (
    <Tracker
      item={item(fields)}
      runTimeZone={timeZone}
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
    />
  )
}

function stepRow(container, index) {
  const label = [...container.querySelectorAll('.step-card__label')].find((el) => el.textContent === STEPS[index].label)
  return label.closest('.step')
}
const runTimeOf = (container, index) => stepRow(container, index).querySelector('[data-testid="run-time"]')?.textContent ?? null

const run = (index, attempt, fields = {}) => ({
  output: 'ran',
  attempt,
  attemptCount: attempt,
  artifact: `## Attempt ${attempt}`,
  label: STEPS[index].label,
  startedAt: null,
  endedAt: null,
  ...fields,
})

test('a done step card shows its run’s finish time, absolute and relative', () => {
  const { container } = render(tracker({ stepOutputs: { [IMPL - 2]: run(IMPL - 2, 1, { endedAt: '2026-11-05 20:06:00' }) } }))
  expect(runTimeOf(container, IMPL - 2)).toBe('5 Nov 20:06 · 20 h ago')
})

test('the time is in the viewer’s timezone', () => {
  const { container } = render(tracker({ stepOutputs: { [IMPL - 2]: run(IMPL - 2, 1, { endedAt: '2026-11-05 20:06:00' }) } }, 'America/New_York'))
  expect(runTimeOf(container, IMPL - 2)).toBe('5 Nov 15:06 · 20 h ago')
})

test('a multi-attempt step shows the displayed attempt’s time, the one its link opens', () => {
  const { container } = render(
    tracker({ stepOutputs: { [IMPL - 2]: run(IMPL - 2, 2, { attemptCount: 3, endedAt: '2026-11-06 10:06:00' }) } }),
  )
  const row = stepRow(container, IMPL - 2)
  expect(row.querySelector('.step-card__artifact-link').textContent).toBe('attempt 2 of 3 ↗')
  expect(runTimeOf(container, IMPL - 2)).toBe('6 Nov 10:06 · 6 h ago')
})

test('a done step with no recorded finish time shows no time', () => {
  const { container } = render(tracker({ stepOutputs: { [IMPL - 2]: run(IMPL - 2, 1) } }))
  expect(runTimeOf(container, IMPL - 2)).toBeNull()
})

test('an old result after a send-back reads "previous attempt", then a newer finished run replaces it', () => {
  const sentBack = { reviewRejected: true, stepOutputs: { [REVIEW]: run(REVIEW, 1, { endedAt: '2026-11-05 20:06:00' }) } }
  const { container, rerender } = render(tracker(sentBack))
  // The card's own outcome line is unchanged; the time is its own line.
  expect(stepRow(container, REVIEW).querySelector('.step-card__meta').textContent).toBe('Failed, sent back · attempt 1')
  expect(runTimeOf(container, REVIEW)).toBe('previous attempt · 5 Nov 20:06 · 20 h ago')

  rerender(tracker({ cursor: REVIEW + 2, stepOutputs: { [REVIEW]: run(REVIEW, 2, { endedAt: '2026-11-06 15:36:00' }) } }))
  expect(runTimeOf(container, REVIEW)).toBe('6 Nov 15:36 · 30 min ago')
})
