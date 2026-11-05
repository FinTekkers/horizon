// HZ-540 metric 1 (tracker half): the stepper draws the item's sub-steps as
// indented rows under their anchors — from fixtures/substep-item.json, the
// item server/test/substep-snapshot.test.mjs serves after the project's
// steps.json was edited — each with its status, elapsed time, log, artifact
// and persona. An item without sub-steps draws no such row.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: (id, i, a, sub) => `/api/items/${id}/artifacts/${i}${a ? `/${a}` : ''}${sub ? `?substep=${sub}` : ''}`,
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: (runId) => `/api/runs/${runId}/log/view`,
  subscribeStepOutputs: vi.fn(() => () => {}),
}))

import Tracker from './Tracker'
import { STEPS } from '../../../domain/js/lifecycle.js'
import ITEM from './fixtures/substep-item.json'

const FILE_ONLY_LABELS = ['Audit, renamed in the file', 'Only in the project file now']

afterEach(() => cleanup())

const noop = () => {}

function renderTracker(item) {
  return render(
    <Tracker
      item={{ stepOutputs: {}, ...item }}
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
    />,
  )
}

test('each snapshot sub-step is a row right under its anchor step, and nothing from the project file shows', () => {
  const { getAllByTestId, container } = renderTracker(ITEM)
  const rows = getAllByTestId('substep-row')
  expect(rows.map((r) => r.querySelector('.step-card__label').textContent)).toEqual(['Golden test cases', 'Audit the change'])
  for (const row of rows) {
    const sub = ITEM.substeps.find((s) => s.id === row.dataset.substep)
    // The nearest global step before the row is its anchor.
    let prev = row.previousElementSibling
    while (prev?.dataset.testid === 'substep-row') prev = prev.previousElementSibling
    expect(prev.querySelector('.step-card__label').textContent).toBe(STEPS[sub.anchor].label)
  }
  for (const label of FILE_ONLY_LABELS) expect(container.textContent).not.toContain(label)
})

test('a finished sub-step shows its time, log, artifact and persona; the current one is marked', () => {
  const { getAllByTestId } = renderTracker(ITEM)
  const rows = getAllByTestId('substep-row')
  const [done, current] = rows.map((r) => within(r))
  expect(done.getByText('Completed · 7 min')).toBeTruthy()
  expect(done.getByText('Data integrity')).toBeTruthy()
  expect(done.getByText('View log ↗').getAttribute('href')).toBe(`/api/runs/${ITEM.substeps[0].run.id}/log/view`)
  expect(done.getByText('View full artifact ↗').getAttribute('href')).toBe(`/api/items/${ITEM.id}/artifacts/1?substep=golden-cases`)

  expect(current.getByText('Current sub-step')).toBeTruthy()
  expect(current.getByText('Performance')).toBeTruthy()
  expect(rows[1].querySelector('[aria-current="step"]')).toBeTruthy()
  expect(rows[0].querySelector('[aria-current]')).toBeNull()
  expect(current.queryByText('View full artifact ↗')).toBeNull()
})

test('an item without sub-steps draws no sub-step row', () => {
  const { queryAllByTestId } = renderTracker({ ...ITEM, substeps: undefined, substep_cursor: undefined, substep: undefined })
  expect(queryAllByTestId('substep-row')).toHaveLength(0)
})
