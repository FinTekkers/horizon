// HZ-384: a Task's Approve the run gate is the existing amber awaiting card
// with two additions — the "Always a human · even on Autopilot" line and the
// run plan's size — and its two buttons named for what they do. Approve the
// run opens the same ConfirmGateDialog every gate uses, whose confirm goes
// through the PIN prompt (serverApi.test.js covers that leg).

import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(),
}))

import Tracker from './Tracker'
import ConfirmGateDialog from './ConfirmGateDialog'
import { APPROVE_RUN_GATE_INDEX, requiredStepIndex } from '../../../domain/js/lifecycle.js'

afterEach(() => {
  cleanup()
})

const noop = () => {}

const taskItem = {
  id: 'TK-1',
  title: 'Backfill the ledger',
  kind: 'task',
  desc: '',
  metric: '',
  guardrails: '',
  priority: 'High',
  cursor: APPROVE_RUN_GATE_INDEX,
  paused: false,
  rejected: false,
  events: [],
  stepOutputs: {},
  activeRun: null,
  runPlan: { commands: 3, budgetMinutes: 20, hash: 'abc123' },
  approvedPlanHash: null,
}

// App's own wiring, in miniature: Approve opens ConfirmGateDialog.
function Harness({ item, onReject }) {
  const [confirm, setConfirm] = useState(null)
  return (
    <>
      <Tracker
        item={item}
        onBack={noop}
        onApprove={(itemId, gateLabel) => setConfirm({ itemId, gateLabel })}
        onApproveWithComments={noop}
        onReject={onReject}
        onResolveConflicts={noop}
        onTogglePause={noop}
        onRestartPhase={noop}
        onSetPersona={noop}
        onAbandon={noop}
      />
      {confirm && <ConfirmGateDialog itemId={confirm.itemId} gateLabel={confirm.gateLabel} onConfirm={noop} onCancel={noop} />}
    </>
  )
}

const awaitingCard = (container) => container.querySelector('.step-card--awaiting')

test("the Task's awaiting card shows the human-only line, the plan's size, and both buttons", () => {
  const onReject = vi.fn()
  const { container, getByRole } = render(<Harness item={taskItem} onReject={onReject} />)
  const card = awaitingCard(container)
  expect(card.querySelector('.step-card__label').textContent).toBe('Approve the run')
  expect(card.textContent).toContain('Always a human · even on Autopilot')
  expect(card.querySelector('.step-card__run-plan').textContent).toBe('Run plan: 3 commands · budget 20 min')

  fireEvent.click(getByRole('button', { name: 'Reject with feedback' }))
  expect(onReject).toHaveBeenCalledWith('TK-1', 'Approve the run')

  fireEvent.click(getByRole('button', { name: 'Approve the run' }))
  const dialog = getByRole('alertdialog')
  expect(dialog.textContent).toContain('Approve this gate?')
  expect(dialog.textContent).toContain('TK-1 · Approve the run')
})

test('one command reads singular; no plan block reads "not found"', () => {
  const { container, rerender } = render(<Harness item={{ ...taskItem, runPlan: { commands: 1, budgetMinutes: 5, hash: 'h' } }} onReject={noop} />)
  expect(container.querySelector('.step-card__run-plan').textContent).toBe('Run plan: 1 command · budget 5 min')
  rerender(<Harness item={{ ...taskItem, runPlan: null }} onReject={noop} />)
  expect(container.querySelector('.step-card__run-plan').textContent).toBe('Run plan: not found')
})

test("a change item's gate card is unchanged: no human-only line, the usual button names", () => {
  const changeItem = { ...taskItem, id: 'CH-1', kind: 'change', cursor: requiredStepIndex('Approve the high-level design') }
  delete changeItem.runPlan
  const { container, getByRole } = render(<Harness item={changeItem} onReject={noop} />)
  const card = awaitingCard(container)
  expect(card.textContent).not.toContain('Always a human')
  expect(card.querySelector('.step-card__run-plan')).toBeNull()
  expect(getByRole('button', { name: 'Approve' })).toBeTruthy()
  expect(getByRole('button', { name: 'Send back with feedback' })).toBeTruthy()
})
