// HZ-540 metric 1 (board half): a card renders the sub-step the server says
// the item is at — fixtures/substep-item.json is the item
// server/test/substep-snapshot.test.mjs serves, after the project's steps.json
// was edited — and stays in its anchor's column. Guardrail 1: no new column.

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render, cleanup, within, fireEvent } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import Board from './Board'
import * as boardFilters from '../boardFilters'
import * as boardNarrowing from '../boardNarrowing'
import { PHASES, STEPS } from '../../../domain/js/lifecycle.js'
import ITEM from './fixtures/substep-item.json'

// The labels the edited project file has and the snapshot does not.
const FILE_ONLY_LABELS = ['Audit, renamed in the file', 'Only in the project file now']

beforeEach(() => {
  boardFilters._resetForTests()
  boardNarrowing._resetForTests()
})
afterEach(() => cleanup())

const noop = () => {}
const PLAIN = { ...ITEM, id: 'AC-2', title: 'A chore', cursor: 2, substeps: undefined, substep_cursor: undefined, substep: undefined }

function renderBoard(items) {
  return render(<Board items={items} projects={[]} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />)
}

test('the card shows the snapshot sub-step it is at, with its persona, in its anchor’s column', () => {
  const { container } = renderBoard([ITEM])
  expect(container.querySelectorAll('.col')).toHaveLength(PHASES.length)
  const col = [...container.querySelectorAll('.col')].find((c) => c.querySelector('.card'))
  expect(col.querySelector('.col__name').textContent).toBe(PHASES[STEPS[ITEM.substep.anchor].phase])
  const card = within(col.querySelector('.card'))
  expect(card.getByTestId('card-substep').textContent).toContain('Audit the change')
  expect(card.getByText('Performance')).toBeTruthy()
  expect(card.getByText('At a sub-step')).toBeTruthy()
  for (const label of FILE_ONLY_LABELS) expect(container.textContent).not.toContain(label)
})

test('an item at no sub-step shows no sub-step line, and the board offers no sub-step filter', () => {
  const { container, queryByText } = renderBoard([PLAIN])
  expect(container.querySelector('[data-testid="card-substep"]')).toBeNull()
  expect(queryByText('At a sub-step')).toBeNull()
  expect(container.querySelectorAll('.col')).toHaveLength(PHASES.length)
})

test('the At a sub-step filter narrows the board to items at one', () => {
  const { container, getByRole } = renderBoard([ITEM, PLAIN])
  expect(container.querySelectorAll('.card')).toHaveLength(2)
  fireEvent.click(getByRole('button', { name: 'At a sub-step' }))
  expect([...container.querySelectorAll('.card__id')].map((n) => n.textContent)).toEqual([ITEM.id])
})
