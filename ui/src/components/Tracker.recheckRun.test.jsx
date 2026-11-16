// HO-842: a Task paused at Execute because the dispatch re-check refused
// (prereq_drift) offers Re-check and run in its hold banner, in place of
// Retry — never on a Change item or any other failure. A double click sends
// one request; a refusal for a host still missing a check lists each one by
// kind and name.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(),
}))

import Tracker from './Tracker'
import { EXECUTE_STEP_INDEX, IMPLEMENT_STEP_INDEX, RUN_PLAN_STEP_INDEX } from '../../../domain/js/lifecycle.js'
import { REASON } from '../../../domain/js/reasons.js'
import { holdFor } from '../domain/hold'

afterEach(cleanup)

const noop = () => {}
const pauseEvent = (reason, cause) => ({ created_at: '2026-11-16 10:00:00', text: `agent step failed (${reason}): ${cause} — item paused; resume to retry` })
const refused = {
  id: 'T-842',
  title: 'Backfill',
  desc: '',
  metric: '',
  guardrails: '',
  priority: 'High',
  kind: 'task',
  cursor: EXECUTE_STEP_INDEX,
  project_id: 7,
  paused: true,
  rejected: false,
  events: [pauseEvent(REASON.PREREQ_DRIFT, 'prerequisites changed since approval — failed: MDI_DB_URL')],
  stepOutputs: {},
  activeRun: null,
  ruleBlock: null,
  usageWait: null,
  isolationRefusal: null,
}

function renderTracker(item, onRecheckRun = vi.fn(() => Promise.resolve({ ok: true }))) {
  const onTogglePause = vi.fn(() => Promise.resolve({ ok: true }))
  const view = render(
    <Tracker
      item={item}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onSetPersona={noop}
      onAbandon={noop}
      onAddDependency={noop}
      onAmendRule={noop}
      onTogglePause={onTogglePause}
      onRecheckRun={onRecheckRun}
    />,
  )
  return { ...view, onRecheckRun, onTogglePause }
}

test('the refusal mark on a Task at Execute shows Re-check and run in the banner, and no Retry', async () => {
  expect(holdFor(refused).action).toEqual({ key: 'recheckRun', label: 'Re-check and run' })
  const { getByRole, queryByRole, container, onRecheckRun, onTogglePause } = renderTracker(refused)
  const button = getByRole('button', { name: 'Re-check and run' })
  expect(container.querySelector('[data-hold-banner="runFailed"]').contains(button)).toBe(true)
  expect(queryByRole('button', { name: 'Retry' })).toBeNull()
  await act(async () => {
    fireEvent.click(button)
  })
  expect(onRecheckRun).toHaveBeenCalledTimes(1)
  expect(onRecheckRun).toHaveBeenCalledWith('T-842')
  expect(onTogglePause).not.toHaveBeenCalled()
})

test('any other failure, a Change item or another step keeps Retry and never shows Re-check and run', () => {
  const others = [
    { ...refused, events: [pauseEvent(REASON.TIMEOUT, 'step timed out')] },
    { ...refused, events: [pauseEvent(REASON.JOB_BUDGET_EXCEEDED, 'the job ran past its budget')] },
    // A Change item has no Execute: the same refusal text on one is not the mark.
    { ...refused, kind: 'change', cursor: IMPLEMENT_STEP_INDEX },
    { ...refused, cursor: RUN_PLAN_STEP_INDEX },
  ]
  for (const item of others) {
    expect(holdFor(item).action.key).toBe('retry')
    const { getByRole, queryByRole } = renderTracker(item)
    expect(getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(queryByRole('button', { name: 'Re-check and run' })).toBeNull()
    cleanup()
  }
})

test('a double click sends one Re-check and run', async () => {
  let finish
  const onRecheckRun = vi.fn(() => new Promise((resolve) => (finish = resolve)))
  const { getByRole } = renderTracker(refused, onRecheckRun)
  const button = getByRole('button', { name: 'Re-check and run' })
  await act(async () => {
    fireEvent.click(button)
    fireEvent.click(button)
  })
  expect(onRecheckRun).toHaveBeenCalledTimes(1)
  await act(async () => finish({ ok: true }))
})

test('a host still missing checks lists each unmet one by kind and name, never a value', async () => {
  const err = Object.assign(new Error('prerequisites_unmet'), {
    unmet: [
      { kind: 'env', name: 'MDI_DB_URL' },
      { kind: 'file', name: '/etc/fintekkers/creds.json' },
    ],
  })
  const { getByRole, getByTestId, getAllByTestId, container } = renderTracker(refused, vi.fn(() => Promise.reject(err)))
  await act(async () => {
    fireEvent.click(getByRole('button', { name: 'Re-check and run' }))
  })
  expect(getByTestId('recheck-run-refusal').textContent).toMatch(/still misses what the run plan needs/)
  expect(getAllByTestId('recheck-run-unmet').map((li) => li.textContent)).toEqual(['env MDI_DB_URL', 'file /etc/fintekkers/creds.json'])
  expect(container.textContent).not.toMatch(/postgres:\/\//)
})

test('another refusal shows its own reason and no unmet list', async () => {
  const { getByRole, getByTestId, queryAllByTestId } = renderTracker(refused, vi.fn(() => Promise.reject(new Error('plan_changed'))))
  await act(async () => {
    fireEvent.click(getByRole('button', { name: 'Re-check and run' }))
  })
  expect(getByTestId('recheck-run-refusal').textContent).toMatch(/run plan changed since it was approved/)
  expect(queryAllByTestId('recheck-run-unmet')).toHaveLength(0)
})
