// HZ-541 metric line 3 (the UI's side): the first gate's golden-cases table.
// Each row shows its case's inputs, measure, expected value, tolerance and
// source; an indexed source links to its document and names the section, an
// unindexed one is a red error that blocks approval; each row links to the
// metric line that names the set, which the metric tile carries as an
// anchor. One click on "Approve all N cases" is the gate's one approve.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, fireEvent, within } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(() => () => {}),
}))

import GoldenCasesTable from './GoldenCasesTable'
import Tracker from './Tracker'
import { requiredStepIndex } from '../../../domain/js/lifecycle.js'

afterEach(() => cleanup())

const GATE = requiredStepIndex('Approve & prioritize this work')
const CASES = [
  {
    id: 'accrual-30-360',
    inputs: { notional: 1000000, rate: 0.05, days: 30 },
    measure: 'accrued_interest',
    expected: 4166.67,
    tolerance: { abs: 0.01 },
    source: 'bond-math#accrual',
    sourceIndexed: true,
    sourceUrl: 'https://github.com/FinTekkers/docs/blob/HEAD/specs/bond-math.pdf#page=4',
    sourceTitle: '2.1 Accrual',
    sourcePage: 4,
  },
  {
    id: 'price-par',
    inputs: { coupon: 0.05 },
    measure: 'clean_price',
    expected: 'par',
    tolerance: { rel: 0.0001 },
    source: 'bond-math#pricing',
    sourceIndexed: true,
    sourceUrl: 'https://github.com/FinTekkers/docs/blob/HEAD/specs/bond-math.pdf#page=9',
    sourceTitle: '3 Pricing',
    sourcePage: 9,
  },
]
const GOLDEN = { substepId: 'golden-cases', gateIndex: GATE, hash: 'h1', approved: false, approvedBy: null, approvedAt: null, metricLine: 2, errors: [], cases: CASES }

test('each row shows inputs, measure, expected, tolerance and a source linked to its indexed section, and links to the metric line', () => {
  const { getByRole } = render(<GoldenCasesTable goldenCases={GOLDEN} onApproveAll={() => {}} />)
  const table = getByRole('table', { name: 'Golden cases' })
  const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent)
  for (const name of ['Inputs', 'Measure', 'Expected', 'Tolerance', 'Source']) expect(headers).toContain(name)
  const rows = within(table).getAllByRole('row').slice(1)
  expect(rows).toHaveLength(2)
  const cell = (row, name) => within(row).getAllByRole('cell')[headers.indexOf(name)]

  expect(cell(rows[0], 'Inputs').textContent).toBe('notional = 1000000, rate = 0.05, days = 30')
  expect(cell(rows[0], 'Measure').textContent).toBe('accrued_interest')
  expect(cell(rows[0], 'Expected').textContent).toBe('4166.67')
  expect(cell(rows[0], 'Tolerance').textContent).toBe('± 0.01')
  expect(cell(rows[1], 'Expected').textContent).toBe('par')
  expect(cell(rows[1], 'Tolerance').textContent).toBe('± 0.01%')

  rows.forEach((row, i) => {
    const source = within(cell(row, 'Source')).getByRole('link', { name: CASES[i].source })
    expect(source.getAttribute('href')).toBe(CASES[i].sourceUrl)
    expect(cell(row, 'Source').textContent).toContain(`${CASES[i].sourceTitle} · p. ${CASES[i].sourcePage}`)
    expect(within(cell(row, 'Metric')).getByRole('link', { name: 'Metric line 2' }).getAttribute('href')).toBe('#metric-line-2')
  })
})

test('an unindexed source is a red error, not a link, and the set cannot be approved', () => {
  const bad = { ...CASES[1], source: 'bond-math#missing', sourceIndexed: false, sourceUrl: null, sourceTitle: null, sourcePage: null }
  const golden = { ...GOLDEN, cases: [CASES[0], bad], errors: ['case "price-par": source bond-math#missing is not in the knowledge index'] }
  const { getByTestId, getByRole, queryByRole } = render(<GoldenCasesTable goldenCases={golden} onApproveAll={() => {}} />)
  expect(getByTestId('golden-source-error').textContent).toBe('bond-math#missing — not in the knowledge index')
  expect(getByTestId('golden-source-error').className).toBe('golden-cases__source-error')
  expect(queryByRole('link', { name: 'bond-math#missing' })).toBeNull()
  expect(getByRole('alert').textContent).toContain('is not in the knowledge index')
  expect(getByRole('button', { name: 'Approve all 2 cases' }).disabled).toBe(true)
})

const noop = () => {}
function renderTracker(item, onApprove = noop) {
  return render(
    <Tracker
      item={{ stepOutputs: {}, ...item }}
      onBack={noop}
      onApprove={onApprove}
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

const ITEM = {
  id: 'HZ-9',
  title: 'Bond accrual',
  priority: 'Medium',
  kind: 'change',
  cursor: GATE,
  desc: 'Accrue interest on 30/360.',
  metric: '1. Accrual matches the spec.\n2. Every case in the approved `golden_cases` set has a passing test.',
  guardrails: 'None.',
  events: [],
  goldenCases: GOLDEN,
}

test('on the first gate, one “Approve all N cases” click is the one approve, and the row link lands on the metric line', () => {
  const onApprove = vi.fn()
  const { container, getByRole, queryByRole } = renderTracker(ITEM, onApprove)
  const card = container.querySelector('.step-card--awaiting')
  expect(within(card).getByRole('table', { name: 'Golden cases' })).toBeTruthy()
  // The table's button replaces the card's plain Approve.
  expect(queryByRole('button', { name: 'Approve' })).toBeNull()
  fireEvent.click(getByRole('button', { name: 'Approve all 2 cases' }))
  expect(onApprove).toHaveBeenCalledTimes(1)
  expect(onApprove).toHaveBeenCalledWith('HZ-9', 'Approve & prioritize this work')

  const target = container.querySelector('#metric-line-2')
  expect(target.textContent).toContain('golden_cases')
  expect(container.querySelector('#metric-line-1').textContent).toContain('Accrual matches the spec.')
})

test('an approved set shows who approved it and no approve button', () => {
  const { container, queryByRole } = renderTracker({ ...ITEM, cursor: GATE + 1, goldenCases: { ...GOLDEN, approved: true, approvedBy: 'Ada' } })
  expect(container.querySelector('[data-testid="golden-cases"]').textContent).toContain('approved by Ada')
  expect(queryByRole('button', { name: /Approve all/ })).toBeNull()
})

test('an item without golden cases renders its metric and gate exactly as before', () => {
  const { container, getByRole } = renderTracker({ ...ITEM, goldenCases: undefined })
  expect(container.querySelector('[data-testid="golden-cases"]')).toBeNull()
  expect(container.querySelector('#metric-line-1')).toBeNull()
  expect(getByRole('button', { name: 'Approve' })).toBeTruthy()
})
