// HO-851 metric lines 1 and 2 (tracker half): a design sub-step its verdict
// skipped shows "Skipped: <reason>", and at a gate after it offers "Design it
// anyway" — whose Submit stays disabled until a reason is typed, and which
// sends the reason trimmed. Only a skipped design row offers it, only at a
// gate; an item with no design sub-step draws exactly as before.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, within, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: (id, i, a, sub) => `/api/items/${id}/artifacts/${i}${a ? `/${a}` : ''}${sub ? `?substep=${sub}` : ''}`,
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: (runId) => `/api/runs/${runId}/log/view`,
  subscribeStepOutputs: vi.fn(() => () => {}),
}))

import Tracker from './Tracker'
import { STEPS, requiredStepIndex } from '../../../domain/js/lifecycle.js'
import ITEM from './fixtures/substep-item.json'

afterEach(() => cleanup())

const noop = () => {}
const GATE = requiredStepIndex('Approve & prioritize this work')
const GUARDRAILS = requiredStepIndex('Set guardrails')
const SKIP = { round: 1, kind: 'skip', brief: 'backend only', whatChanged: null, overrideReason: null, runId: null, createdBy: 'Horizon', createdAt: '2026-11-17T10:00:00Z' }
const DESIGN = { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: 1, persona: null, personaBadge: null, run: null, rounds: [SKIP], skip: { reason: 'backend only' } }

function itemAt(cursor, substeps = [DESIGN]) {
  const step = STEPS[cursor]
  return {
    ...ITEM,
    stepOutputs: {},
    cursor,
    currentStep: { index: cursor, key: step.key, label: step.label, kind: step.kind, phase: 'Plan', gate: step.kind === 'gate' },
    currentStepKey: step.key,
    substeps,
    substep_cursor: null,
    substep: null,
    goldenCases: undefined,
  }
}

function renderTracker(item, onForceSubstep = noop) {
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
      onForwardToAccept={noop}
      onForceSubstep={onForceSubstep}
    />,
  )
}

const designRow = (view) => within(view.getAllByTestId('substep-row').find((r) => r.dataset.substep === DESIGN.id))

test('a skipped design row shows "Skipped: <reason>" and, at the gate, a "Design it anyway" button', () => {
  const view = renderTracker(itemAt(GATE))
  const row = designRow(view)
  expect(row.getByText('Skipped: backend only')).toBeTruthy()
  expect(row.getByRole('button', { name: 'Design it anyway' })).toBeTruthy()
})

test('Submit stays disabled for a blank reason and sends the trimmed one', async () => {
  const onForceSubstep = vi.fn(() => Promise.resolve({ ok: true }))
  const view = renderTracker(itemAt(GATE), onForceSubstep)
  fireEvent.click(designRow(view).getByRole('button', { name: 'Design it anyway' }))
  const dialog = within(view.getByRole('dialog', { name: 'Design it anyway' }))
  const submit = dialog.getByRole('button', { name: 'Design it' })
  const reason = dialog.getByLabelText('Reason to design it anyway')
  expect(submit.disabled).toBe(true)
  fireEvent.change(reason, { target: { value: '   ' } })
  expect(submit.disabled).toBe(true)
  fireEvent.click(submit)
  expect(onForceSubstep).not.toHaveBeenCalled()
  fireEvent.change(reason, { target: { value: '  Checkout changes  ' } })
  expect(submit.disabled).toBe(false)
  fireEvent.click(submit)
  expect(onForceSubstep).toHaveBeenCalledWith(ITEM.id, DESIGN.id, 'Checkout changes')
  await waitFor(() => expect(view.queryByRole('dialog', { name: 'Design it anyway' })).toBeNull())
})

test('the button is offered only on a skipped design row at a gate', () => {
  // Away from a gate: the skip still shows, with no button.
  const away = renderTracker(itemAt(GUARDRAILS))
  expect(designRow(away).getByText('Skipped: backend only')).toBeTruthy()
  expect(designRow(away).queryByRole('button', { name: 'Design it anyway' })).toBeNull()
  cleanup()
  // A design round that ran (not a skip) offers none either.
  const ran = { ...DESIGN, skip: null, rounds: [{ ...SKIP, kind: 'run', runId: 9 }], run: { id: 9, status: 'done', attempt: 1, startedAt: '2026-11-17T10:00:00Z', endedAt: '2026-11-17T10:03:00Z', hasArtifact: true } }
  const view = renderTracker(itemAt(GATE, [ran]))
  expect(designRow(view).queryByText(/^Skipped:/)).toBeNull()
  expect(designRow(view).queryByRole('button', { name: 'Design it anyway' })).toBeNull()
  expect(designRow(view).getByText('Completed · 3 min')).toBeTruthy()
})

test('an item with no design sub-step draws its sub-steps exactly as before', () => {
  const view = renderTracker({ ...ITEM, stepOutputs: {} })
  expect(view.queryAllByText(/^Skipped:/)).toHaveLength(0)
  expect(view.queryAllByRole('button', { name: 'Design it anyway' })).toHaveLength(0)
  expect(view.getAllByTestId('substep-row').map((r) => r.querySelector('.step-card__label').textContent)).toEqual(['Golden test cases', 'Audit the change'])
})
