// HZ-563 metric 1: the account menu shows "Farm health" for an admin, not for
// a non-admin (Admin stays for both). The entry opens the page at
// /farm-health, and its dot matches the page's overall state — checked with an
// amber and a red reading, so a hard-coded dot cannot pass.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, screen, waitFor, within } from '@testing-library/react'

let user = null
let reading = null
// Stable references: useSyncExternalStore re-renders forever on a fresh array.
const NO_ITEMS = []
const NO_PROJECTS = []
const SYNC = { connected: false }

vi.mock('./api', () => ({
  subscribe: () => () => {},
  getItems: () => NO_ITEMS,
  getCurrentUser: vi.fn(async () => user),
  getSync: () => SYNC,
  getProjects: () => NO_PROJECTS,
  getActiveProjectId: () => null,
  getFarm: () => null,
  getDurationEstimates: () => null,
  getDeployBlock: () => null,
  getRestartSent: () => null,
  getFarmHealth: vi.fn(async () => reading),
  logout: vi.fn(),
  setPaused: vi.fn(),
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import * as api from './api'
import App from './App'

const ADMIN = { name: 'Ada Admin', initials: 'AA', email: 'admin@example.com', isAdmin: true }
const MEMBER = { name: 'Max Member', initials: 'MM', email: 'member@example.com', isAdmin: false }

function snapshot(state, reason) {
  const slot = (busy, limit) => ({ busy, limit, waiting: 0 })
  return {
    state,
    reason,
    collectedAt: new Date().toISOString(),
    farm: { status: state === 'red' ? 'not_running' : 'running', since: new Date().toISOString() },
    capacity: { agents: slot(4, 4), express: slot(0, 1), pm: slot(0, 1), checks: slot(0, 2) },
    waitingCount: 0,
    running: [{ itemId: 'HZ-1', step: 'Specialist agent implements', slot: 'agent', startedAt: new Date().toISOString() }],
    waiting: [],
    box: {
      load: [1, 1, 1],
      vcpus: 4,
      machine: null,
      memTotalBytes: 16e9,
      memAvailableBytes: 8e9,
      memAvailablePct: 50,
      diskTotalBytes: 100e9,
      diskAvailBytes: 40e9,
      diskUsedPct: 60,
      swapTotalBytes: 0,
      swapUsedPct: 0,
      uptimeS: 3600,
    },
    services: [{ name: 'nginx', unit: 'nginx', detail: null, state: 'active', up: true }],
    recent: [],
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  user = null
  reading = null
})

async function openAccountMenu(initials) {
  fireEvent.click(await screen.findByRole('button', { name: initials }))
}

test('a non-admin sees Admin but no Farm health entry, and never polls it', async () => {
  user = MEMBER
  reading = snapshot('green', 'All services up, slots free and box figures normal')
  render(<App />)
  await openAccountMenu('MM')
  expect(screen.getByRole('button', { name: 'Admin' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /farm health/i })).toBeNull()
  expect(api.getFarmHealth).not.toHaveBeenCalled()
})

for (const [state, word, reason] of [
  ['amber', 'Busy', 'All 4 agent slots are busy'],
  ['red', 'Unhealthy', 'Farm is not running'],
]) {
  test(`an admin opens Farm health from the menu, and its ${state} dot matches the page`, async () => {
    user = ADMIN
    reading = snapshot(state, reason)
    render(<App />)
    await waitFor(() => expect(api.getFarmHealth).toHaveBeenCalled())
    await openAccountMenu('AA')
    expect(screen.getByRole('button', { name: 'Admin' })).toBeTruthy()

    const entry = await screen.findByRole('button', { name: /farm health/i })
    const dot = within(entry).getByRole('img', { name: word })
    expect(dot.dataset.state).toBe(state)

    fireEvent.click(entry)
    expect(window.location.pathname).toMatch(/\/farm-health$/)
    expect(screen.getByRole('heading', { level: 1, name: 'Farm health' })).toBeTruthy()
    const overall = screen.getByRole('region', { name: 'Overall' })
    expect(overall.dataset.state).toBe(state)
    expect(within(overall).getByText(word)).toBeTruthy()
    expect(within(overall).getByText(reason)).toBeTruthy()

    // The same reading feeds both: reopen the menu, the dot still says the page's state.
    await openAccountMenu('AA')
    const again = screen.getByRole('button', { name: /farm health/i })
    expect(within(again).getByRole('img').dataset.state).toBe(overall.dataset.state)
    expect(again.getAttribute('aria-current')).toBe('page')
  })
}

test('the deep link /farm-health opens the page, and its item rows link to the item', async () => {
  user = ADMIN
  reading = snapshot('amber', 'All 4 agent slots are busy')
  window.history.pushState({}, '', '/farm-health')
  render(<App />)
  expect(await screen.findByRole('heading', { level: 1, name: 'Farm health' })).toBeTruthy()
  const link = await screen.findByRole('link', { name: 'HZ-1' })
  expect(link.getAttribute('href')).toMatch(/\/hz-1$/)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(api.getFarmHealth.mock.calls.length).toBeGreaterThanOrEqual(2))
})
