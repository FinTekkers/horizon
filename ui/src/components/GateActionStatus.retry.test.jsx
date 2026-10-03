// HZ-231: Retry sits beside the reason of an Accept run that timed out, was
// interrupted or failed — on the Board card and the Tracker — and on no other
// state. A blocked run (a red check or a merge conflict) keeps Resolve
// conflicts and never gets Retry.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
}))

import Board from './Board'
import Tracker from './Tracker'
import { ACCEPT_GATE_INDEX } from '../../../domain/js/lifecycle.js'

afterEach(() => {
  cleanup()
})

const noop = () => {}
const PR = 42

function action(kind, state, extra = {}) {
  return {
    kind,
    state,
    detail: null,
    since: new Date().toISOString(),
    deadline: null,
    finishedAt: state === 'running' ? null : new Date().toISOString(),
    reason: null,
    failingCheck: null,
    startedBeforeRestart: false,
    ...extra,
  }
}

function item(gateAction, extra = {}) {
  return {
    id: 'RTY-1',
    title: 'Retry item',
    desc: '',
    metric: '',
    guardrails: '',
    priority: 'Medium',
    cursor: ACCEPT_GATE_INDEX,
    issue: null,
    pr: PR,
    pr_url: 'https://example.test/pr/42',
    pr_mergeable: true,
    paused: false,
    rejected: false,
    events: [],
    stepOutputs: {},
    activeRun: null,
    personas: { eng: 'fullstack' },
    gateAction,
    conflictRun: null,
    ...extra,
  }
}

function renderTracker(it, handlers = {}) {
  return render(
    <Tracker
      item={it}
      onBack={noop}
      onApprove={handlers.onApprove || noop}
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

function renderBoard(it, handlers = {}) {
  return render(
    <Board items={[it]} onOpen={handlers.onOpen || noop} onApprove={handlers.onApprove || noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />,
  )
}

const VIEWS = [
  ['Board card', renderBoard],
  ['Tracker', renderTracker],
]

// `retry` is declared, not derived, so a change to isRetryable fails here.
const ROWS = [
  { name: 'premerge running', action: action('premerge', 'running', { detail: 'npm test' }), retry: false },
  { name: 'premerge merged', action: action('premerge', 'merged'), retry: false },
  { name: 'premerge blocked with failingCheck', action: action('premerge', 'blocked', { failingCheck: 'unit-tests' }), retry: false },
  { name: 'premerge blocked (conflict, no failingCheck)', action: action('premerge', 'blocked', { reason: 'merge conflict with main' }), retry: false },
  { name: 'premerge failed', action: action('premerge', 'failed', { reason: 'GitHub refused the merge' }), retry: true },
  { name: 'premerge timed_out', action: action('premerge', 'timed_out', { reason: 'checks ran past the deadline' }), retry: true },
  { name: 'premerge interrupted', action: action('premerge', 'interrupted', { reason: 'Horizon restarted mid-run' }), retry: true },
  { name: 'resolve running', action: action('resolve', 'running'), retry: false },
  { name: 'resolve failed', action: action('resolve', 'failed', { reason: 'agent crashed' }), retry: false },
  { name: 'resolve timed_out', action: action('resolve', 'timed_out'), retry: false },
]

const CASES = VIEWS.flatMap(([view, renderView]) => ROWS.map((row) => ({ view, renderView, ...row })))

test.each(CASES)('$view, $name: Retry shown = $retry', ({ renderView, action: a, retry }) => {
  const { container } = renderView(item(a))
  const status = container.querySelector('.gate-action-status')
  const retryButtons = [...container.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Retry')
  if (retry) {
    expect(retryButtons).toHaveLength(1)
    // Beside the reason, inside the same status line.
    expect(status.contains(retryButtons[0])).toBe(true)
    expect(status.querySelector('.gate-action-status__note').textContent).toBe(a.reason)
    expect(retryButtons[0].disabled).toBe(false)
  } else {
    expect(retryButtons).toHaveLength(0)
  }
})

test.each(VIEWS)('%s: Retry calls Accept\'s onApprove with the gate label, and does not open the card', (_, renderView) => {
  const onApprove = vi.fn()
  const onOpen = vi.fn()
  const { getByRole } = renderView(item(action('premerge', 'timed_out')), { onApprove, onOpen })
  getByRole('button', { name: 'Retry' }).click()
  expect(onApprove).toHaveBeenCalledTimes(1)
  expect(onApprove).toHaveBeenCalledWith('RTY-1', 'Accept the code')
  expect(onOpen).not.toHaveBeenCalled()
})

test('Tracker: a conflict-blocked item keeps Resolve conflicts and gets no Retry', () => {
  const { container, getByRole } = renderTracker(
    item(action('premerge', 'blocked', { reason: 'merge conflict with main' }), { pr_mergeable: false }),
  )
  expect(getByRole('button', { name: 'Resolve conflicts…' }).disabled).toBe(false)
  expect([...container.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Retry')).toBe(false)
})
