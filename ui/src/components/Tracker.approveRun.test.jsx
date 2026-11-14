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

const PREFLIGHT_PASSED = { status: 'passed', unmet: [], runner: 'container', runUser: 'ubuntu', checkedAt: '2026-11-12 10:04:11' }
// HO-839: the server's view of that plan's rehearsal, run clean.
const REHEARSAL_CLEAN = { clean: true, reason: null, scope: 'full', seconds: 41, failures: [] }

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
  // HO-837: the server's view of a plan whose Preflight passed. HO-839: and
  // whose rehearsal ran clean.
  runPlan: { commands: 3, budgetMinutes: 20, hash: 'abc123', runner: 'container', imagePinned: true, runnerWarning: null, preflight: PREFLIGHT_PASSED, rehearsal: REHEARSAL_CLEAN },
  approvedPlanHash: null,
  moves: servedMoves({
    approve: { key: 'task.approve-run', label: 'Approve the run' },
    targets: [
      returnTo('task.run-plan', 'Run plan', 'Redoes 3 steps, from “Run plan” to “Approve the run”.'),
      { ...returnTo('task.preflight', 'Preflight', 'Redoes 1 step, from “Preflight” to “Approve the run”.'), isDefault: false },
    ],
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

// HO-843: after a one-command patch the card shows only that command's
// diff — "Command 2 of 3 changed", one old line and one new line — in place
// of the whole plan's summary, and no other command's text. Approve the run
// still opens the same confirm (and PIN) every approval goes through.
test('a one-command patch: the card renders only command k\'s diff, never the rest of the plan', () => {
  const others = ['scripts/a.sh --dry-run', 'scripts/c.sh --verify']
  const commandPatch = { index: 1, count: 3, before: 'scripts/b.sh --all', after: 'scripts/b.sh --since 2026-11-01', commandHash: 'f'.repeat(64) }
  // HO-845: with its three checks passed, so the card offers Approve.
  const patchedCommand = checksOf(['pass', 'pass', 'pass'])
  const { container, getByRole, getByLabelText } = render(<Harness item={{ ...taskItem, runPlan: { ...taskItem.runPlan, commandPatch, patchedCommand } }} />)
  const card = awaitingCard(container)
  const diff = within(card).getByTestId('command-patch')
  expect(within(diff).getByText('Command 2 of 3 changed')).toBeTruthy()
  expect(getByLabelText('Old command 2').textContent).toBe('− scripts/b.sh --all')
  expect(getByLabelText('New command 2').textContent).toBe('+ scripts/b.sh --since 2026-11-01')
  expect(diff.querySelectorAll('.command-patch__line--removed')).toHaveLength(1)
  expect(diff.querySelectorAll('.command-patch__line--added')).toHaveLength(1)
  // Only k's diff: no whole-plan summary, and no other command's text.
  expect(card.querySelector('.step-card__run-plan')).toBeNull()
  for (const other of others) expect(card.textContent).not.toContain(other)
  expect(card.textContent).not.toContain('commandHash')
  expect(card.textContent).not.toContain('f'.repeat(64))
  expect(card.textContent).toContain('Always a human · even on Autopilot')

  fireEvent.click(getByRole('button', { name: 'Approve the run' }))
  expect(getByRole('alertdialog').textContent).toContain('Approve this gate?')
})

// HO-845: the server's view of the patched command's three checks.
function checksOf(statuses, { failedStage = null, findings = [] } = {}) {
  const stages = ['audit', 'preflight', 'rehearsal'].map((stage, i) => ({ stage, status: statuses[i], reason: statuses[i] === 'fail' ? 'command_check_failed' : null }))
  return { index: 1, hash: 'f'.repeat(64), stages, failedStage, findings, approvable: statuses.every((st) => st === 'pass') }
}
const PATCH = { index: 1, count: 3, before: 'scripts/b.sh --all', after: 'scripts/b.sh --since 2026-11-01', commandHash: 'f'.repeat(64) }
const withChecks = (patchedCommand, extra = {}) => ({ ...taskItem, ...extra, runPlan: { ...taskItem.runPlan, commandPatch: PATCH, patchedCommand } })

// HO-845: the patched command's Approve card waits for its contract audit,
// preflight and rehearsal — hidden, not just disabled — and a failed check is
// named; once all three passed, Approve the run is offered.
test('while the patched command\'s checks run, each stage shows its status and there is no Approve button', () => {
  const { container } = render(<Harness item={withChecks(checksOf(['pass', 'pending', 'not_started']))} />)
  const card = awaitingCard(container)
  expect(within(card).getByTestId('command-check-audit').textContent).toBe('✓ contract audit — passed')
  expect(within(card).getByTestId('command-check-preflight').textContent).toBe('… preflight — running')
  expect(within(card).getByTestId('command-check-rehearsal').textContent).toBe('· rehearsal — waits for the check before it')
  expect(within(card).getByText('Approve waits until all three checks pass.')).toBeTruthy()
  expect(within(card).queryByRole('button', { name: 'Approve the run' })).toBeNull()
  expect(within(card).queryByRole('button', { name: 'Approve with comments' })).toBeNull()
  expect(card.querySelector('.btn-gate-approve')).toBeNull()
})

test('a failed preflight is named as the failed check, with its findings, and there is no Approve button', () => {
  const failed = checksOf(['pass', 'fail', 'not_started'], { failedStage: 'preflight', findings: ['env DB_URL is not set'] })
  const { container } = render(<Harness item={withChecks(failed)} />)
  const card = awaitingCard(container)
  expect(within(card).getByText('Failed check: preflight')).toBeTruthy()
  expect(within(card).getByTestId('command-check-finding').textContent).toBe('env DB_URL is not set')
  expect(within(card).queryByRole('button', { name: 'Approve the run' })).toBeNull()
})

test('back at Run plan, the Run plan step names the failed check', () => {
  const failed = checksOf(['fail', 'not_started', 'not_started'], { failedStage: 'audit', findings: ['tool jq'] })
  const { container } = render(<Harness item={withChecks(failed, { cursor: kindStepIndex('Run plan', 'task'), paused: true })} />)
  expect(within(container).getByText('Failed check: contract audit')).toBeTruthy()
  expect(container.querySelector('.btn-gate-approve')).toBeNull()
})

test('once all three checks passed, Approve the run is offered, enabled', () => {
  const { container } = render(<Harness item={withChecks(checksOf(['pass', 'pass', 'pass']))} />)
  const card = awaitingCard(container)
  expect(within(card).queryByTestId('command-checks-waiting')).toBeNull()
  expect(within(card).queryByTestId('command-check-failed')).toBeNull()
  expect(within(card).getByRole('button', { name: 'Approve the run' }).disabled).toBe(false)
})

test('with no patch waiting the card shows the whole plan\'s summary and no diff', () => {
  const { container } = render(<Harness item={{ ...taskItem, runPlan: { ...taskItem.runPlan, commandPatch: null } }} />)
  const card = awaitingCard(container)
  expect(card.querySelector('[data-testid="command-patch"]')).toBeNull()
  expect(card.querySelector('.step-card__run-plan').textContent).toBe('Run plan: 3 commands · budget 20 min · Container')
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

// ---- HO-837: the Preflight result on the card ----

const UNMET = {
  status: 'unmet',
  runner: 'host',
  runUser: 'ubuntu',
  checkedAt: '2026-11-12 10:04:11',
  unmet: [
    { kind: 'env', name: 'HORIZON_API_TOKEN', reason: "not set in the job's environment" },
    { kind: 'file', name: '/etc/horizon/stripe.env', reason: 'not readable by the job user' },
  ],
}
const withPreflight = (preflight) => ({ ...taskItem, runPlan: { ...taskItem.runPlan, runner: 'host', preflight } })

test('an unmet Preflight lists every item by name, disables Approve, and offers Re-run preflight and Send back to Run plan', () => {
  const onMove = vi.fn()
  const { container, getByRole } = render(<Harness item={withPreflight(UNMET)} onMove={onMove} />)
  const card = awaitingCard(container)
  const rows = [...card.querySelectorAll('[data-testid="preflight-unmet"]')].map((li) => li.textContent)
  expect(rows).toEqual(["env HORIZON_API_TOKEN — not set in the job's environment", 'file /etc/horizon/stripe.env — not readable by the job user'])
  expect(card.textContent).toContain('Preflight found 2 unmet prerequisites on host as ubuntu')
  expect(getByRole('button', { name: 'Approve the run' }).disabled).toBe(true)
  expect(within(card).getByRole('button', { name: 'Approve with comments' }).disabled).toBe(true)

  fireEvent.click(within(card).getByRole('button', { name: 'Re-run preflight' }))
  expect(onMove).toHaveBeenLastCalledWith('TK-1', 'return', 'task.preflight')
  fireEvent.click(within(card).getByRole('button', { name: 'Send back to Run plan' }))
  expect(onMove).toHaveBeenLastCalledWith('TK-1', 'return', 'task.run-plan')
})

test('a stale or missing Preflight says why and keeps Approve disabled; a passed one enables it and offers no re-run', () => {
  const { container, getByRole, rerender } = render(<Harness item={withPreflight({ ...UNMET, status: 'stale', unmet: [] })} />)
  const notReady = () => awaitingCard(container).querySelector('[data-testid="preflight-not-ready"]')
  expect(notReady().textContent).toContain('Preflight ran for an earlier plan or runner')
  expect(getByRole('button', { name: 'Approve the run' }).disabled).toBe(true)

  rerender(<Harness item={withPreflight({ status: 'missing', unmet: [], runner: null, runUser: null, checkedAt: null })} />)
  expect(notReady().textContent).toContain('Preflight has not run for this plan yet')
  expect(getByRole('button', { name: 'Approve the run' }).disabled).toBe(true)

  rerender(<Harness item={withPreflight({ ...PREFLIGHT_PASSED, runner: 'host' })} />)
  expect(notReady()).toBeNull()
  expect(awaitingCard(container).querySelector('[data-testid="preflight-passed"]').textContent).toBe('✓ Preflight passed on host as ubuntu')
  expect(getByRole('button', { name: 'Approve the run' }).disabled).toBe(false)
  expect(screen.queryByRole('button', { name: 'Re-run preflight' })).toBeNull()
})

// ---- HO-839: the rehearsal ----
const withRehearsal = (rehearsal) => ({ ...taskItem, runPlan: { ...taskItem.runPlan, rehearsal } })
const FAILED = {
  clean: false,
  reason: 'rehearsal_parser_failed',
  scope: 'full',
  seconds: 12,
  failures: [{ what: 'proof command 2 (metric line 1)', reason: 'rehearsal_parser_failed', exit: 5 }],
}

test('a failed rehearsal names its reason and finding, hides Approve the run and Approve with comments, and keeps Send back and Return to…', () => {
  const onMove = vi.fn()
  const { container } = render(<Harness item={withRehearsal(FAILED)} onMove={onMove} />)
  const card = awaitingCard(container)
  expect(card.querySelector('[data-testid="rehearsal-failed"]').textContent).toContain('Rehearsal failed: rehearsal_parser_failed')
  expect([...card.querySelectorAll('[data-testid="rehearsal-finding"]')].map((li) => li.textContent)).toEqual([
    'proof command 2 (metric line 1) — rehearsal_parser_failed (exit 5)',
  ])
  expect(within(card).queryByRole('button', { name: 'Approve the run' })).toBeNull()
  expect(within(card).queryByRole('button', { name: 'Approve with comments' })).toBeNull()
  fireEvent.click(within(card).getByRole('button', { name: 'Send back to Run plan' }))
  expect(onMove).toHaveBeenLastCalledWith('TK-1', 'return', 'task.run-plan')
  fireEvent.click(within(card).getByRole('button', { name: 'Re-run preflight' }))
  expect(onMove).toHaveBeenLastCalledWith('TK-1', 'return', 'task.preflight')
  expect(within(card).getByRole('button', { name: 'Return to…' })).toBeTruthy()
})

test('no rehearsal on record for the plan hides Approve the run and says why; a clean one shows it, enabled', () => {
  const { container, rerender } = render(<Harness item={withRehearsal(null)} />)
  expect(awaitingCard(container).querySelector('[data-testid="rehearsal-missing"]').textContent).toContain('No rehearsal on record for this plan')
  expect(screen.queryByRole('button', { name: 'Approve the run' })).toBeNull()

  rerender(<Harness item={taskItem} />)
  const card = awaitingCard(container)
  expect(card.querySelector('[data-testid="rehearsal-clean"]').textContent).toBe('✓ Rehearsal ran clean in 41s in the read-only sandbox')
  expect(card.querySelector('[data-testid="rehearsal-samples-only"]')).toBeNull()
  expect(within(card).getByRole('button', { name: 'Approve the run' }).disabled).toBe(false)
})

test("a Tenant Task's card says its proofs were rehearsed on samples only", () => {
  const { container, rerender } = render(<Harness item={withRehearsal({ ...REHEARSAL_CLEAN, scope: 'samples' })} />)
  const line = () => awaitingCard(container).querySelector('[data-testid="rehearsal-samples-only"]')
  expect(line().textContent).toBe('Tenant Task: proofs rehearsed on samples only. The dry run was not rehearsed.')
  expect(screen.getByRole('button', { name: 'Approve the run' }).disabled).toBe(false)
  // Failed, it still says so — and Approve is hidden.
  rerender(<Harness item={withRehearsal({ ...FAILED, scope: 'samples' })} />)
  expect(line().textContent).toBe('Tenant Task: proofs rehearsed on samples only. The dry run was not rehearsed.')
  expect(screen.queryByRole('button', { name: 'Approve the run' })).toBeNull()
})

test('an unmet Preflight shows no rehearsal line: Preflight blocks first', () => {
  const { container } = render(<Harness item={{ ...taskItem, runPlan: { ...taskItem.runPlan, preflight: { ...PREFLIGHT_PASSED, status: 'unmet', unmet: [{ kind: 'tool', name: 'jq', reason: 'missing' }] }, rehearsal: null } }} />)
  expect(awaitingCard(container).querySelector('[data-testid^="rehearsal-"]')).toBeNull()
  expect(screen.getByRole('button', { name: 'Approve the run' }).disabled).toBe(true)
})
