// HZ-422: a step that fell back from a usage-limited model says so under
// "Ran on", and an item whose every model is limited says it is waiting for
// the reset. Both texts are built by the server; the card renders them as sent.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'

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
const NOTE = 'fell back from Claude · Opus 5.5: usage limit until 2026-10-12 14:00 UTC'
const WAIT = 'Waiting for usage limits to reset, earliest 2026-10-12 14:00 UTC'

const baseItem = {
  id: 'T-1',
  title: 'A work item',
  desc: '',
  metric: '',
  guardrails: '',
  priority: 'Medium',
  cursor: ARCH + 1,
  paused: false,
  rejected: false,
  events: [],
  stepOutputs: {},
  activeRun: null,
  providerChoices: {},
}

const noop = () => {}

function renderTracker(item) {
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
      onSetStepProvider={noop}
      onAbandon={noop}
    />,
  )
}

function card(container, index) {
  const label = [...container.querySelectorAll('.step-card__label')].find((el) => el.textContent === STEPS[index].label)
  return label.closest('.step-card')
}

const ranOn = (extra) => ({ output: 'done', attempt: 1, artifact: null, attemptCount: 0, provider: 'muse', model: 'muse-spark-1.3', ...extra })

test('a run on a fallback model shows the model that ran and what it fell back from', () => {
  const { container } = renderTracker({ stepOutputs: { [ARCH]: ranOn({ fallbackNote: NOTE }) } })
  const scope = within(card(container, ARCH))
  expect(scope.getByText('Ran on Muse (muse-spark-1.3)')).toBeTruthy()
  expect(scope.getByText(NOTE)).toBeTruthy()
})

test('an item waiting on usage limits shows the wait text', () => {
  const { getByText } = renderTracker({ usageWait: { until: '2026-10-12T14:00:00.000Z', text: WAIT } })
  expect(getByText(WAIT)).toBeTruthy()
})

test('with fallbackNote and usageWait null, neither text appears and "Ran on" is unchanged', () => {
  const { container, queryByText } = renderTracker({ usageWait: null, stepOutputs: { [ARCH]: ranOn({ fallbackNote: null }) } })
  const scope = within(card(container, ARCH))
  expect(scope.getByText('Ran on Muse')).toBeTruthy()
  expect(queryByText(/fell back from/)).toBeNull()
  expect(queryByText(/Waiting for usage limits/)).toBeNull()
})
