// HZ-717: while the server can't reach the farm, the item page says so and,
// for an admin, links to Farm health. A reachable farm shows no banner.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

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

const BANNER = "The farm isn't reachable, so agent steps can't start or report back."

const item = {
  id: 'FU-1',
  title: 'An item mid-flight',
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

function renderTracker(props) {
  return render(
    <Tracker
      item={item}
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
      {...props}
    />,
  )
}

test('an unreachable farm shows the banner with a Farm health link', () => {
  const onOpenFarmHealth = vi.fn()
  const { getByText, getByRole } = renderTracker({ farmUnreachable: true, onOpenFarmHealth })
  expect(getByText(BANNER).closest('[role="status"]')).toBeTruthy()
  fireEvent.click(getByRole('button', { name: 'Farm health' }))
  expect(onOpenFarmHealth).toHaveBeenCalledTimes(1)
})

test('without the Farm health handler (a non-admin) the banner shows its text and no link', () => {
  const { getByText, queryByRole } = renderTracker({ farmUnreachable: true })
  expect(getByText(BANNER)).toBeTruthy()
  expect(queryByRole('button', { name: 'Farm health' })).toBeNull()
})

test('a reachable farm shows no banner', () => {
  const { queryByText } = renderTracker({ farmUnreachable: false, onOpenFarmHealth: noop })
  expect(queryByText(/farm isn't reachable/)).toBeNull()
})
