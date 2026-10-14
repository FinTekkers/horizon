// HZ-454: a mergeable PR at the Accept gate shows no merge-conflict banner —
// moved here from e2e/tests/07-merge-conflict.spec.js, which keeps the
// conflicted-PR journeys through the real server.

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
import { ACCEPT_GATE_INDEX, STEPS } from '../../../domain/js/lifecycle.js'

afterEach(() => cleanup())

const noop = () => {}

function renderAtAcceptGate(item) {
  return render(
    <Tracker
      item={{
        id: 'CLN-1',
        title: 'A PR at the Accept gate',
        desc: '',
        metric: '',
        guardrails: '',
        priority: 'Medium',
        cursor: ACCEPT_GATE_INDEX,
        pr: 501,
        paused: false,
        rejected: false,
        events: [],
        stepOutputs: {},
        activeRun: null,
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
      onAbandon={noop}
    />,
  )
}

const acceptCard = (container) =>
  [...container.querySelectorAll('.step-card__label')].find((el) => el.textContent === STEPS[ACCEPT_GATE_INDEX].label)

test('hides the merge-conflict banner for a normal mergeable PR', () => {
  const { container } = renderAtAcceptGate({ pr_mergeable: true })
  expect(acceptCard(container)).toBeTruthy()
  expect(container.querySelector('.step-card__conflict')).toBeNull()
})

// Not a moved case: pins the condition, so the absence above can't pass on a
// render that never shows the banner at all.
test('the same item with an unmergeable PR does show the banner', () => {
  const { container } = renderAtAcceptGate({ pr_mergeable: false })
  expect(container.querySelector('.step-card__conflict').textContent).toContain('PR #501 has merge conflicts')
})
