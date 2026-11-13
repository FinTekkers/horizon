// HO-848: Admin › Verify report. The whole AdminPage renders with a mocked
// getVerifyReport(), so the section is proven wired to HO-841's read: a start
// date and N go to it as typed, and the totals, prereqShare and
// firstPassYield come back on screen — never the per-Task list.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, within, screen, fireEvent } from '@testing-library/react'
import * as api from '../api'

vi.mock('../api', () => ({
  saveToken: vi.fn(),
  createProject: vi.fn(),
  addRepoToProject: vi.fn(),
  disconnectRepo: vi.fn(),
  regenerateGatePin: vi.fn(),
  lockPinSession: vi.fn(),
  getPinVerifiedUntil: () => null,
  pinSessionLikelyVerified: () => false,
  listApiTokens: vi.fn(async () => ({ tokens: [] })),
  createApiToken: vi.fn(),
  revokeApiToken: vi.fn(async () => ({ ok: true })),
  setProjectEnabled: vi.fn(async () => ({ ok: true })),
  saveRepoChecks: vi.fn(),
  getRepoCheckDefaults: vi.fn(async () => ({ available: true, defaults: {} })),
  getRepoWebhooks: vi.fn(async () => ({ webhooks: [] })),
  fixRepoWebhook: vi.fn(async () => ({ ok: true })),
  dryRunDeployTarget: vi.fn(),
  getDeployTargets: vi.fn(async () => ({ targets: [] })),
  getCheckFlakes: vi.fn(async () => ({ repos: [] })),
  getVerifyReport: vi.fn(),
}))

import AdminPage from './AdminPage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// The example response in domain/productivityVerify.schema.json's shape.
const REPORT = {
  since: '2026-11-01',
  n: 20,
  project: 'all',
  returned: 20,
  tasks: [{ id: 'HO-830', closedAt: '2026-11-02 09:14:00', verdict: 'work_failed', executeCause: 'prereq' }],
  totals: {
    verdicts: { pass: 14, work_failed: 4, done_proof_incomplete: 1, none: 1 },
    executeCauses: { prereq: 1, unforeseeable: 3 },
  },
  prereqShare: 0.25,
  firstPassYield: 0.7,
}

function renderPage() {
  return render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'verify' }} />)
}

async function showReport(since, n) {
  fireEvent.change(screen.getByLabelText('Start date'), { target: { value: since } })
  fireEvent.change(screen.getByLabelText('Number of Tasks'), { target: { value: n } })
  fireEvent.click(screen.getByRole('button', { name: 'Show' }))
  return screen.findByRole('table', { name: 'Verify report totals' })
}

const rowsOf = (table) =>
  within(table)
    .getAllByRole('row')
    .map((row) => [within(row).getByRole('rowheader').textContent, within(row).getByRole('cell').textContent])

test('a start date and N call the verify report with those values and render its totals', async () => {
  api.getVerifyReport.mockResolvedValue(REPORT)
  renderPage()
  expect(screen.getByRole('heading', { name: 'Verify report' })).toBeTruthy()
  // Nothing is read until Show.
  expect(api.getVerifyReport).not.toHaveBeenCalled()

  const table = await showReport('2026-11-01', '20')
  expect(api.getVerifyReport).toHaveBeenCalledTimes(1)
  expect(api.getVerifyReport).toHaveBeenCalledWith({ since: '2026-11-01', n: 20 })
  expect(rowsOf(table)).toEqual([
    ['Pass', '14'],
    ['Work failed', '4'],
    ['Done, proof incomplete', '1'],
    ['No verdict', '1'],
    ['Execute cause: prereq', '1'],
    ['Execute cause: unforeseeable', '3'],
    ['Prereq share', '25.0%'],
    ['First-pass yield', '70.0%'],
  ])
  expect(screen.getByTestId('verify-report-cohort').textContent).toBe('20 of up to 20 Tasks closed after 2026-11-01 · all projects')
  // Totals only: the cohort's Task ids are not shown.
  expect(screen.queryByText(/HO-830/)).toBeNull()
})

test('a null prereqShare renders — and a zero firstPassYield 0.0%, without error', async () => {
  api.getVerifyReport.mockResolvedValue({
    ...REPORT,
    returned: 0,
    tasks: [],
    totals: { verdicts: { pass: 0, work_failed: 0, done_proof_incomplete: 0, none: 0 }, executeCauses: { prereq: 0, unforeseeable: 0 } },
    prereqShare: null,
    firstPassYield: 0,
  })
  renderPage()
  await showReport('2026-11-01', '20')
  expect(screen.getByTestId('verify-report-prereq-share').textContent).toBe('—')
  expect(screen.getByTestId('verify-report-first-pass-yield').textContent).toBe('0.0%')
  expect(screen.getByTestId('verify-report-cohort').textContent).toBe('No Tasks closed after 2026-11-01 · all projects')
  expect(screen.queryByRole('alert')).toBeNull()
})

test('a failed read shows its error and Show works again', async () => {
  api.getVerifyReport.mockRejectedValue(new Error('admin_required'))
  renderPage()
  fireEvent.click(screen.getByRole('button', { name: 'Show' }))
  expect((await screen.findByRole('alert')).textContent).toBe('admin_required')
  expect(screen.getByRole('button', { name: 'Show' }).disabled).toBe(false)
})

test('Show is disabled for an N outside 1-500, a fraction or an empty date', () => {
  renderPage()
  const show = screen.getByRole('button', { name: 'Show' })
  expect(show.disabled).toBe(false)
  for (const bad of ['0', '501', '2.5']) {
    fireEvent.change(screen.getByLabelText('Number of Tasks'), { target: { value: bad } })
    expect(show.disabled).toBe(true)
  }
  fireEvent.change(screen.getByLabelText('Number of Tasks'), { target: { value: '500' } })
  fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '' } })
  expect(show.disabled).toBe(true)
  expect(api.getVerifyReport).not.toHaveBeenCalled()
})
