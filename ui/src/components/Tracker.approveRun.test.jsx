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
import { APPROVE_FILE_GATE_INDEX, APPROVE_RUN_GATE_INDEX, kindStepIndex, requiredStepIndex } from '../../../domain/js/lifecycle.js'

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

// HZ-446: a Plan's Approve & file is human-only too — the same Autopilot line
// and a button named for the gate, but it approves no run plan, so none shows.
// Its File items row names no agent and renders as Horizon's.
test("a Plan's Approve & file card shows the human-only line, no run plan, and buttons named for the gate", () => {
  const planItem = { ...taskItem, id: 'PL-1', title: 'Retire the FIX gateway', kind: 'plan', cursor: APPROVE_FILE_GATE_INDEX }
  delete planItem.runPlan
  delete planItem.approvedPlanHash
  const onReject = vi.fn()
  const { container, getByRole, getByText } = render(<Harness item={planItem} onReject={onReject} />)
  const card = awaitingCard(container)
  expect(card.querySelector('.step-card__label').textContent).toBe('Approve & file')
  expect(card.textContent).toContain('Always a human · even on Autopilot')
  expect(card.querySelector('.step-card__run-plan')).toBeNull()
  expect(card.textContent).not.toContain('Run plan')

  fireEvent.click(getByRole('button', { name: 'Reject with feedback' }))
  expect(onReject).toHaveBeenCalledWith('PL-1', 'Approve & file')
  fireEvent.click(getByRole('button', { name: 'Approve & file' }))
  expect(getByRole('alertdialog').textContent).toContain('PL-1 · Approve & file')

  const fileItems = getByText('File items').closest('.step-card')
  expect(fileItems.textContent).toContain('Horizon')
  expect(kindStepIndex('File items', 'plan')).toBe(APPROVE_FILE_GATE_INDEX + 1)
})
