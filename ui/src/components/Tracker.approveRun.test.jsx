// HZ-384: a Task's Approve the run gate is the existing amber awaiting card
// with two additions — the "Always a human · even on Autopilot" line and the
// run plan's size — and its two buttons named for what they do. Approve the
// run opens the same ConfirmGateDialog every gate uses, whose confirm goes
// through the PIN dialog (serverApi.test.js covers that leg). HZ-711: its
// second button is Return to…, offered by the item's `moves`.

import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { render, fireEvent, cleanup, screen, within } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(),
  // HZ-449: the Approve & file card's items table; no draft here.
  getPlanDraft: vi.fn(async () => null),
  savePlanDraft: vi.fn(),
}))

import Tracker from './Tracker'
import ConfirmGateDialog from './ConfirmGateDialog'
import { APPROVE_FILE_GATE_INDEX, APPROVE_RUN_GATE_INDEX, kindStepIndex, requiredStepIndex } from '../../../domain/js/lifecycle.js'
import { servedMoves } from './fixtures/servedMoves'

afterEach(() => {
  cleanup()
})

const noop = () => {}

// One return target per gate, as the snapshot lists it (the default one).
const returnTo = (key, label, redo) => ({ key, label, action: 'return', isDefault: true, redo, reapprovals: [], stopsRunning: false })

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
  runPlan: { commands: 3, budgetMinutes: 20, hash: 'abc123', runner: 'container', imagePinned: true, runnerWarning: null },
  approvedPlanHash: null,
  moves: servedMoves({
    approve: { key: 'task.approve-run', label: 'Approve the run' },
    targets: [returnTo('task.run-plan', 'Run plan', 'Redoes 3 steps, from “Run plan” to “Approve the run”.')],
    canAbandon: true,
    amend: null,
  }),
}

// App's own wiring, in miniature: Approve opens ConfirmGateDialog.
function Harness({ item, onMove = noop }) {
  const [confirm, setConfirm] = useState(null)
  return (
    <>
      <Tracker
        item={item}
        onBack={noop}
        onApprove={(itemId, gateLabel) => setConfirm({ itemId, gateLabel })}
        onApproveWithComments={noop}
        onMove={onMove}
        onResolveConflicts={noop}
        onTogglePause={noop}
        onSetPersona={noop}
        onAbandon={noop}
      />
      {confirm && <ConfirmGateDialog itemId={confirm.itemId} gateLabel={confirm.gateLabel} onConfirm={noop} onCancel={noop} />}
    </>
  )
}

const awaitingCard = (container) => container.querySelector('.step-card--awaiting')
// HZ-711: a gate's step label is a button named for the step and what a click
// on it offers there (the hint is its own span, so no space is guaranteed).
const STEP_NAME = (label) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*Approve$`)

test("the Task's awaiting card shows the human-only line, the plan's size, and both buttons", () => {
  const onMove = vi.fn()
  const { container, getByRole } = render(<Harness item={taskItem} onMove={onMove} />)
  const card = awaitingCard(container)
  expect(card.querySelector('.step-card__label')).toBe(within(card).getByRole('button', { name: STEP_NAME('Approve the run') }))
  expect(card.textContent).toContain('Always a human · even on Autopilot')
  expect(card.querySelector('.step-card__run-plan').textContent).toBe('Run plan: 3 commands · budget 20 min · Container')

  expect(within(card).queryByRole('button', { name: 'Reject with feedback' })).toBeNull()
  fireEvent.click(within(card).getByRole('button', { name: 'Return to…' }))
  expect(onMove).toHaveBeenCalledWith('TK-1', 'return', null)

  fireEvent.click(getByRole('button', { name: 'Approve the run' }))
  const dialog = getByRole('alertdialog')
  expect(dialog.textContent).toContain('Approve this gate?')
  expect(dialog.textContent).toContain('TK-1 · Approve the run')
})

test('one command reads singular; no plan block reads "not found"', () => {
  const { container, rerender } = render(<Harness item={{ ...taskItem, runPlan: { commands: 1, budgetMinutes: 5, hash: 'h', runner: 'container', imagePinned: true } }} />)
  expect(container.querySelector('.step-card__run-plan').textContent).toBe('Run plan: 1 command · budget 5 min · Container')
  rerender(<Harness item={{ ...taskItem, runPlan: null }} />)
  expect(container.querySelector('.step-card__run-plan').textContent).toBe('Run plan: not found')
})

// HZ-491: the card names the effective runner the server sent — Container,
// or Host with why. Found by its visible text, and again after a fresh mount
// from the same server item — what a page reload renders.
test('the card shows the effective runner: "Container" or "Host — no container image for this repo"', () => {
  const host = { commands: 2, budgetMinutes: 10, hash: 'h', runner: 'host', imagePinned: false, runnerWarning: null }
  const { container, rerender, unmount } = render(<Harness item={{ ...taskItem, runPlan: host }} />)
  expect(screen.getByText(/Host — no container image for this repo/)).toBeTruthy()
  const line = () => awaitingCard(container).querySelector('.step-card__run-plan').textContent
  expect(line()).toBe('Run plan: 2 commands · budget 10 min · Host — no container image for this repo')
  rerender(<Harness item={{ ...taskItem, runPlan: { ...host, runner: 'container', imagePinned: true } }} />)
  expect(line()).toBe('Run plan: 2 commands · budget 10 min · Container')
  expect(screen.queryByText(/Host —/)).toBeNull()
  // An explicit `runner: host` in a repo with an image.
  rerender(<Harness item={{ ...taskItem, runPlan: { ...host, imagePinned: true } }} />)
  expect(line()).toBe('Run plan: 2 commands · budget 10 min · Host — the plan asks for the host')

  unmount()
  render(<Harness item={{ ...taskItem, runPlan: host }} />)
  expect(screen.getByText(/Host — no container image for this repo/)).toBeTruthy()
})

// HZ-491: an explicit container plan in a repo with no image is warned about
// on the card, before approval; any other plan shows no warning.
test('an explicit container plan with no image shows the "no container image for this repo" warning', () => {
  const plan = { commands: 1, budgetMinutes: 5, hash: 'h', runner: 'container', imagePinned: false, runnerWarning: 'no container image for this repo' }
  const { container, rerender } = render(<Harness item={{ ...taskItem, runPlan: plan }} />)
  const warning = () => awaitingCard(container).querySelector('[data-testid="run-plan-runner-warning"]')
  expect(warning().textContent).toContain('no container image for this repo')
  rerender(<Harness item={{ ...taskItem, runPlan: { ...plan, imagePinned: true, runnerWarning: null } }} />)
  expect(warning()).toBeNull()
})

// HZ-770: metric lines the plan's proof leaves uncovered are warned about on
// the card. A warning only: Approve the run stays enabled, so a plan written
// before the rule still approves.
test('uncovered metric lines show "metric lines 3, 4 have no proof" and Approve stays enabled', () => {
  const plan = { ...taskItem.runPlan, uncoveredLines: [3, 4] }
  const { container, rerender, getByRole } = render(<Harness item={{ ...taskItem, runPlan: plan }} />)
  const warning = () => awaitingCard(container).querySelector('[data-testid="run-plan-uncovered-lines"]')
  expect(warning().textContent).toContain('metric lines 3, 4 have no proof')
  expect(getByRole('button', { name: 'Approve the run' }).disabled).toBe(false)

  rerender(<Harness item={{ ...taskItem, runPlan: { ...plan, uncoveredLines: [] } }} />)
  expect(warning()).toBeNull()
  expect(getByRole('button', { name: 'Approve the run' }).disabled).toBe(false)
})

test("a change item's gate card is unchanged: no human-only line, the usual button names", () => {
  const changeItem = {
    ...taskItem,
    id: 'CH-1',
    kind: 'change',
    cursor: requiredStepIndex('Approve the high-level design'),
    moves: servedMoves({
      approve: { key: 'change.approve-design', label: 'Approve the high-level design' },
      targets: [
        returnTo(
          'change.plan-options',
          'Plan options & trade-offs (pros / cons)',
          'Redoes 2 steps, from “Plan options & trade-offs (pros / cons)” to “Approve the high-level design”.',
        ),
      ],
      canAbandon: true,
      amend: null,
    }),
  }
  delete changeItem.runPlan
  const { container } = render(<Harness item={changeItem} />)
  const card = awaitingCard(container)
  expect(card.textContent).not.toContain('Always a human')
  expect(card.querySelector('.step-card__run-plan')).toBeNull()
  expect(within(card).getByRole('button', { name: 'Approve' })).toBeTruthy()
  expect(within(card).getByRole('button', { name: 'Return to…' })).toBeTruthy()
})

// HZ-446: a Plan's Approve & file is human-only too — the same Autopilot line
// and a button named for the gate, but it approves no run plan, so none shows.
// Its File items row names no agent and renders as Horizon's.
test("a Plan's Approve & file card shows the human-only line, no run plan, and buttons named for the gate", () => {
  const planItem = {
    ...taskItem,
    id: 'PL-1',
    title: 'Retire the FIX gateway',
    kind: 'plan',
    cursor: APPROVE_FILE_GATE_INDEX,
    moves: servedMoves({
      approve: { key: 'plan.approve-file', label: 'Approve & file' },
      targets: [returnTo('plan.draft-items', 'Draft items', 'Redoes 4 steps, from “Draft items” to “Approve & file”.')],
      canAbandon: true,
      amend: null,
    }),
  }
  delete planItem.runPlan
  delete planItem.approvedPlanHash
  const onMove = vi.fn()
  const { container, getByRole, getByText } = render(<Harness item={planItem} onMove={onMove} />)
  const card = awaitingCard(container)
  expect(card.querySelector('.step-card__label')).toBe(within(card).getByRole('button', { name: STEP_NAME('Approve & file') }))
  expect(card.textContent).toContain('Always a human · even on Autopilot')
  expect(card.querySelector('.step-card__run-plan')).toBeNull()
  expect(card.textContent).not.toContain('Run plan')

  expect(within(card).queryByRole('button', { name: 'Reject with feedback' })).toBeNull()
  fireEvent.click(within(card).getByRole('button', { name: 'Return to…' }))
  expect(onMove).toHaveBeenCalledWith('PL-1', 'return', null)
  fireEvent.click(getByRole('button', { name: 'Approve & file' }))
  expect(getByRole('alertdialog').textContent).toContain('PL-1 · Approve & file')

  const fileItems = getByText('File items').closest('.step-card')
  expect(fileItems.textContent).toContain('Horizon')
  expect(kindStepIndex('File items', 'plan')).toBe(APPROVE_FILE_GATE_INDEX + 1)
})
