// HZ-327: Admin's Flaky tests panel. The whole AdminPage renders with a mocked
// getCheckFlakes(), so the panel is proven wired to its read, not only drawn
// from props: one table per repo, rows newest first, the flake counts and the
// last-seen time, and an empty state.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, within, screen } from '@testing-library/react'
import * as api from '../api'

vi.mock('../api', () => ({
  saveToken: vi.fn(),
  createProject: vi.fn(),
  addRepoToProject: vi.fn(),
  disconnectRepo: vi.fn(),
  regenerateGatePin: vi.fn(),
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
  getCheckFlakes: vi.fn(),
}))

import AdminPage from './AdminPage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const SEEDED = {
  repos: [
    {
      repo: 'FinTekkers/horizon',
      tests: [
        {
          test: 'the board stream carries no step output at all',
          count: 3,
          count_7d: 3,
          last_seen: '2026-10-07T09:12:00.000Z',
          last_item_id: 'HZ-321',
          last_command: 'sh -c npm test',
          name_parsed: true,
          ping_status: 'sent',
          pinged_at: '2026-10-07T09:12:01.000Z',
        },
        {
          test: 'sh -c npm run test:e2e',
          count: 2,
          count_7d: 1,
          last_seen: '2026-10-05T17:40:00.000Z',
          last_item_id: 'HZ-304',
          last_command: 'sh -c npm run test:e2e',
          name_parsed: false,
          ping_status: null,
          pinged_at: null,
        },
      ],
    },
    {
      repo: 'acme/web',
      tests: [
        {
          test: 'renders the cart',
          count: 1,
          count_7d: 0,
          last_seen: '2026-09-20T08:00:00.000Z',
          last_item_id: null,
          last_command: 'sh -c npm test',
          name_parsed: true,
          ping_status: null,
          pinged_at: null,
        },
      ],
    },
  ],
}

function renderPage() {
  return render(<AdminPage sync={{}} projects={[]} onBack={() => {}} />)
}

const cells = (row) => within(row).getAllByRole('cell').map((cell) => cell.textContent)

test('the panel lists each repo’s flaky tests, newest first, with counts and last seen', async () => {
  api.getCheckFlakes.mockResolvedValue(SEEDED)
  renderPage()

  const table = await screen.findByRole('table', { name: 'Flaky tests in FinTekkers/horizon' })
  const rows = within(table).getAllByRole('row').slice(1) // the header row first
  expect(rows.map(cells)).toEqual([
    ['the board stream carries no step output at all', '3 / 3', '2026-10-07 09:12 UTC', 'HZ-321', 'sent 2026-10-07 09:12 UTC'],
    ['sh -c npm run test:e2e (test name not parsed)', '1 / 2', '2026-10-05 17:40 UTC', 'HZ-304', '—'],
  ])
  const other = screen.getByRole('table', { name: 'Flaky tests in acme/web' })
  expect(cells(within(other).getAllByRole('row')[1])).toEqual(['renders the cart', '0 / 1', '2026-09-20 08:00 UTC', '—', '—'])
  expect(api.getCheckFlakes).toHaveBeenCalledTimes(1)
})

test('with no records the panel says so', async () => {
  api.getCheckFlakes.mockResolvedValue({ repos: [] })
  renderPage()
  expect(await screen.findByText('No flaky tests recorded.')).toBeTruthy()
  expect(screen.queryByRole('table', { name: /^Flaky tests in / })).toBeNull()
})

test('a failed read shows its error in the panel', async () => {
  api.getCheckFlakes.mockRejectedValue(new Error('flake list unavailable'))
  renderPage()
  expect(await screen.findByText('flake list unavailable')).toBeTruthy()
})
