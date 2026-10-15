// HZ-454: an unlabelled item shows no lane badge and skips nothing — moved
// here from e2e/tests/43-trivial-lane.spec.js, which keeps the trivial-lane
// journey through the real server.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'

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

const noop = () => {}

test('an unlabelled item shows no lane badge and skips nothing', () => {
  const { container, queryByTestId, queryByText } = render(
    <Tracker
      item={{
        id: 'HZ-E2E-FULL-LANE',
        title: 'An unlabelled item',
        desc: '',
        metric: '',
        guardrails: '',
        priority: 'Medium',
        kind: 'change',
        lane: null,
        cursor: requiredStepIndex('Draft implementation plan'),
        paused: true,
        rejected: false,
        events: [],
        stepOutputs: {},
        activeRun: null,
      }}
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
  // A row the trivial lane would skip is on the page.
  const options = STEPS[requiredStepIndex('Plan options & trade-offs (pros / cons)')].label
  expect([...container.querySelectorAll('.step-card__label')].some((el) => el.textContent === options)).toBe(true)
  expect(queryByTestId('lane-badge')).toBeNull()
  expect(queryByText('Skipped — trivial lane')).toBeNull()
})
