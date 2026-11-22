// HZ-946: the repo page's report coverage. GET /api/admin/test-history is the
// owner's only: a member gets 404 (or 403), and sees no section and no error.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import * as api from '../../api'

vi.mock('../../api', () => ({ getTestHistory: vi.fn() }))

import { ReportCoverage } from './ReportCoverage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const rejectWith = (status, message) => Object.assign(new Error(message), { status })

for (const [status, message] of [
  [404, 'not_found'],
  [403, 'forbidden'],
]) {
  test(`a ${status} from test-history renders no section and no error`, async () => {
    api.getTestHistory.mockRejectedValue(rejectWith(status, message))
    const { container } = render(<ReportCoverage repo="acme/app" />)

    await waitFor(() => expect(container.innerHTML).toBe(''))
    expect(api.getTestHistory).toHaveBeenCalledWith('acme/app')
    expect(screen.queryByText(/Report coverage unavailable/)).toBeNull()
  })
}

test('each command shows its runs, and "no per-test results" only where a run wrote no report', async () => {
  api.getTestHistory.mockResolvedValue({
    repo: 'acme/app',
    tests: [],
    commands: [
      { command: 'npm run lint', runs: 3, no_report_runs: 2, last_seen: '2026-11-20T10:00:00.000Z' },
      { command: 'npm test', runs: 1, no_report_runs: 0, last_seen: '2026-11-19T10:00:00.000Z' },
    ],
  })
  render(<ReportCoverage repo="acme/app" />)

  const rows = await screen.findAllByTestId('report-coverage-row')
  expect(rows.map((r) => r.textContent)).toEqual(['npm run lint3 runsno per-test results', 'npm test1 run'])
})

test('another error says so', async () => {
  api.getTestHistory.mockRejectedValue(rejectWith(500, 'internal'))
  render(<ReportCoverage repo="acme/app" />)

  expect(await screen.findByText('Report coverage unavailable: internal')).toBeTruthy()
})
