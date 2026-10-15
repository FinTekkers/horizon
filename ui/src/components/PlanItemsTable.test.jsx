// HZ-449 metrics 1 and 4: a Plan's one items table. Before filing it shows
// the six columns with an Edit control per row; an edit, a dropped row and a
// changed dependency each send the whole draft and show the saved result; a
// refused edit shows the server's message and leaves the rows as they were; a
// stale save reloads the table. After filing the same component shows no
// Edit control and a "Filed as" key on every row, and the Review & close
// card links every filed key.

import { existsSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'

vi.mock('../api', () => ({
  getPlanDraft: vi.fn(),
  savePlanDraft: vi.fn(),
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(),
}))

import { getPlanDraft, savePlanDraft } from '../api'
import PlanItemsTable from './PlanItemsTable'
import Tracker from './Tracker'
import { APPROVE_FILE_GATE_INDEX, FILE_ITEMS_STEP_INDEX, REVIEW_CLOSE_GATE_INDEX } from '../../../domain/js/lifecycle.js'

const lines = (prefix) => [1, 2, 3].map((n) => `${prefix} ${n}`)
const draft = (id, title, dependsOn, cover = []) => ({
  id,
  repo: 'FinTekkers/horizon',
  title,
  outcome: `${title}, done.`,
  metric: lines('metric'),
  guardrails: lines('guardrail'),
  depends_on: dependsOn,
  must_also_cover: cover,
})
const DOC = {
  items: [draft('#1', 'Lay the schema', []), draft('#2', 'Read the schema', ['#1'], ['the empty state']), draft('#3', 'Show it', ['#1', '#2'])],
  shared_guardrails: [],
  open_questions: [],
}
const served = (overrides = {}) => ({ version: 3, source: 'agent', doc: DOC, editable: true, filed: {}, ...overrides })
const item = { id: 'PL-9', cursor: APPROVE_FILE_GATE_INDEX, paused: false }

beforeEach(() => {
  getPlanDraft.mockReset()
  savePlanDraft.mockReset()
})
afterEach(cleanup)

const rows = () => within(screen.getByRole('table', { name: 'Plan items' })).getAllByRole('row').slice(1)
const rowOf = (id) => rows().find((r) => within(r).queryByText(id))
const editRow = async (id) => {
  fireEvent.click(within(rowOf(id)).getByRole('button', { name: `Edit ${id}` }))
  return screen.findByRole('form', { name: `Edit ${id}` })
}

test('before filing: the six columns on a .data-table, an Edit control per row', async () => {
  getPlanDraft.mockResolvedValue(served())
  render(<PlanItemsTable item={item} />)
  const table = await screen.findByRole('table', { name: 'Plan items' })
  expect(table.className).toBe('data-table')
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
    '#',
    'Repo',
    'Title',
    'Depends on',
    'Must also cover',
    'Edit',
  ])
  expect(rows()).toHaveLength(3)
  expect(within(table).getAllByRole('button', { name: /^Edit #/ })).toHaveLength(3)
  expect(within(rowOf('#2')).getByText('the empty state')).toBeTruthy()
  expect(within(rowOf('#3')).getByText('#1, #2')).toBeTruthy()
  expect(within(rowOf('#1')).getByText('horizon')).toBeTruthy()
})

test('an edited title is saved as the whole draft and shows, also after a reload', async () => {
  getPlanDraft.mockResolvedValue(served())
  const saved = structuredClone(DOC)
  saved.items[1].title = 'Read the schema twice'
  savePlanDraft.mockResolvedValue({ version: 4, doc: saved })
  render(<PlanItemsTable item={item} />)
  await screen.findByRole('table', { name: 'Plan items' })
  const form = await editRow('#2')
  fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Read the schema twice' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(savePlanDraft).toHaveBeenCalledTimes(1))
  expect(savePlanDraft).toHaveBeenCalledWith('PL-9', 3, saved)
  expect(await screen.findByText('Read the schema twice')).toBeTruthy()
  expect(screen.queryByRole('form')).toBeNull()

  // A reload reads the saved version back from the server.
  cleanup()
  getPlanDraft.mockResolvedValue(served({ version: 4, source: 'owner', doc: saved }))
  render(<PlanItemsTable item={item} />)
  expect(await screen.findByText('Read the schema twice')).toBeTruthy()
})

test('Drop row sends the draft without the row and without it in any dependency', async () => {
  getPlanDraft.mockResolvedValue(served())
  const expected = {
    ...DOC,
    items: [DOC.items[0], { ...DOC.items[2], depends_on: ['#1'] }],
  }
  savePlanDraft.mockResolvedValue({ version: 4, doc: expected })
  render(<PlanItemsTable item={item} />)
  await screen.findByRole('table', { name: 'Plan items' })
  const form = await editRow('#2')
  fireEvent.click(within(form).getByRole('button', { name: 'Drop row' }))
  await waitFor(() => expect(rows()).toHaveLength(2))
  expect(savePlanDraft).toHaveBeenCalledWith('PL-9', 3, expected)
  expect(rowOf('#2')).toBeUndefined()
  expect(within(rowOf('#3')).getByText('#1')).toBeTruthy()
})

test('a changed dependency sends the new depends_on', async () => {
  getPlanDraft.mockResolvedValue(served())
  const expected = structuredClone(DOC)
  expected.items[2].depends_on = ['#2', 'HZ-100']
  savePlanDraft.mockResolvedValue({ version: 4, doc: expected })
  render(<PlanItemsTable item={item} />)
  await screen.findByRole('table', { name: 'Plan items' })
  const form = await editRow('#3')
  fireEvent.change(within(form).getByLabelText(/^Depends on/), { target: { value: '#2, HZ-100' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(savePlanDraft).toHaveBeenCalledWith('PL-9', 3, expected))
  expect(await within(rowOf('#3')).findByText('#2, HZ-100')).toBeTruthy()
})

test('a refused edit (a cycle) shows the message and leaves every row as it was', async () => {
  getPlanDraft.mockResolvedValue(served())
  const refused = Object.assign(new Error('invalid_plan_draft'), {
    status: 422,
    errors: [{ path: 'items[1].depends_on[0]', code: 'cycle', message: 'cycle: #1 → #2 → #1' }],
  })
  savePlanDraft.mockRejectedValue(refused)
  render(<PlanItemsTable item={item} />)
  await screen.findByRole('table', { name: 'Plan items' })
  const form = await editRow('#1')
  fireEvent.change(within(form).getByLabelText(/^Depends on/), { target: { value: '#2' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
  expect((await screen.findByRole('alert')).textContent).toBe('cycle: #1 → #2 → #1')
  const dependsOn = (id) => within(rowOf(id)).getAllByRole('cell')[3].textContent
  expect([dependsOn('#1'), dependsOn('#2')]).toEqual(['—', '#1'])
})

test('a stale save (409) reloads the table with the server’s newer draft', async () => {
  const newer = structuredClone(DOC)
  newer.items[0].title = 'Lay the schema (other tab)'
  getPlanDraft.mockResolvedValueOnce(served()).mockResolvedValueOnce(served({ version: 4, source: 'owner', doc: newer }))
  savePlanDraft.mockRejectedValue(Object.assign(new Error('stale_version'), { status: 409, currentVersion: 4 }))
  render(<PlanItemsTable item={item} />)
  await screen.findByRole('table', { name: 'Plan items' })
  const form = await editRow('#1')
  fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Mine' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
  expect((await screen.findByRole('status')).textContent).toBe('Draft changed in another tab — reloaded')
  expect(await screen.findByText('Lay the schema (other tab)')).toBeTruthy()
  expect(getPlanDraft).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('Mine')).toBeNull()
})

test('after filing: the same table has no Edit control and a "Filed as" key on every row', async () => {
  getPlanDraft.mockResolvedValue(
    served({
      editable: false,
      filed: {
        '#1': { key: 'HZ-480', status: 'filed' },
        '#2': { key: 'HZ-481', status: 'filed' },
        '#3': { key: 'UI-12', status: 'filed' },
      },
    }),
  )
  render(<PlanItemsTable item={{ ...item, cursor: REVIEW_CLOSE_GATE_INDEX }} />)
  const table = await screen.findByRole('table', { name: 'Plan items' })
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
    '#',
    'Repo',
    'Title',
    'Depends on',
    'Must also cover',
    'Filed as',
  ])
  expect(within(table).queryAllByRole('button')).toHaveLength(0)
  for (const [id, key] of [
    ['#1', 'HZ-480'],
    ['#2', 'HZ-481'],
    ['#3', 'UI-12'],
  ]) {
    expect(within(rowOf(id)).getByRole('link', { name: key }).getAttribute('href')).toBe(`/${key.toLowerCase()}`)
  }
  // Dependencies read as the real keys.
  expect(within(rowOf('#3')).getByText('HZ-480, HZ-481')).toBeTruthy()
})

test('there is one items table: no second component', () => {
  expect(existsSync(new URL('./PlanDraftsTable.jsx', import.meta.url))).toBe(false)
})

test('the Review & close card links every key File items filed', () => {
  getPlanDraft.mockResolvedValue(null)
  const output = [
    'Filed 2 items for Plan PL-9:',
    '',
    '- #1 → [HZ-480](https://horizon.test/hz-480) Lay the schema',
    '- #2 → [UI-12](https://horizon.test/ui-12) Read the schema',
  ].join('\n')
  const plan = {
    ...item,
    title: 'A roadmap',
    kind: 'plan',
    desc: '',
    metric: '',
    guardrails: '',
    priority: 'High',
    cursor: REVIEW_CLOSE_GATE_INDEX,
    rejected: false,
    events: [],
    activeRun: null,
    stepOutputs: { [FILE_ITEMS_STEP_INDEX]: { output, attempt: 1 } },
  }
  const noop = () => {}
  render(
    <Tracker
      item={plan}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onResolveConflicts={noop}
      onTogglePause={noop}
      onRestartPhase={noop}
      onSetPersona={noop}
      onAbandon={noop}
      onRemoveDependency={noop}
    />,
  )
  expect(screen.getByRole('link', { name: 'HZ-480' }).getAttribute('href')).toBe('https://horizon.test/hz-480')
  expect(screen.getByRole('link', { name: 'UI-12' }).getAttribute('href')).toBe('https://horizon.test/ui-12')
})
