// HZ-662: an item the farm holds because its tenant project is missing a
// credential reference or run user says why. The server builds the text; the
// card renders it as sent. An owner's item (isolationRefusal null) shows no
// hold line, exactly as before.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(),
}))

import Tracker from './Tracker'
import { requiredStepIndex } from '../../../domain/js/lifecycle.js'

afterEach(() => cleanup())

const REASON = 'tenant project needs github_token_ref before the farm runs it'

const baseItem = {
  id: 'AC-1',
  title: 'A tenant item',
  desc: '',
  metric: '',
  guardrails: '',
  priority: 'Medium',
  cursor: requiredStepIndex('Architecture review'),
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

test('a held tenant item shows the refusal reason as a status line', () => {
  const { getByText } = renderTracker({ isolationRefusal: REASON })
  const line = getByText(REASON)
  expect(line.closest('[role="status"]')).toBeTruthy()
})

test('an item with no refusal shows no hold line', () => {
  const { container, queryByText } = renderTracker({ isolationRefusal: null })
  expect(queryByText(/before the farm runs it/)).toBeNull()
  expect(container.querySelector('[data-testid="isolation-hold"]')).toBeNull()
})
