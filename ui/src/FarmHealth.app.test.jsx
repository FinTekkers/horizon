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
  // HZ-661: no board frame yet, so the first-project screen stays off.
  hasSnapshot: () => false,
  getFarm: () => null,
  getDurationEstimates: () => null,
  getDeployBlock: () => null,
  getRestartSent: () => null,
  getPlanProgress: () => NO_ITEMS,
  getFarmHealth: vi.fn(async () => reading),
  logout: vi.fn(),
  setPaused: vi.fn(),
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import * as api from './api'
import { getFarmHealth as mockFarmHealth } from './api/mockApi'
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
  vi.useRealTimers()
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

// ---- HZ-574: the Capacity slots card, from the mock API's reading ----

// HZ-592: the wait names its purpose, from the row's `reason`.
const HOLDING = 'holding an agent slot · waiting for a capacity slot to run checks'

async function openWithMockReading() {
  // Only Date is faked: elapsed times read exactly, and polling stays real.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse('2026-10-24T10:00:00Z'))
  user = ADMIN
  reading = await mockFarmHealth()
  window.history.pushState({}, '', '/farm-health')
  render(<App />)
  return screen.findByRole('region', { name: 'Capacity slots' })
}

const cellsOf = (row) => within(row).getAllByRole('cell').map((c) => c.textContent)

test('the Capacity slots card lists each holder by slot, item, check and time held, then the waiter', async () => {
  const card = await openWithMockReading()
  const [holderTable, waiterTable] = within(card).getAllByRole('table')
  const holderRows = within(holderTable).getAllByRole('row').slice(1)
  expect(holderRows.map(cellsOf)).toEqual([
    ['Slot 0', 'HZ-101', 'test slot, line 2 · implement', '4m 10s'],
    ['Slot 1', 'HZ-102', 'e2e slot · pre-merge', '1m 35s'],
  ])
  expect(within(holderRows[0]).getByRole('link', { name: 'HZ-101' }).getAttribute('href')).toMatch(/\/hz-101$/)

  const heading = within(card).getByRole('heading', { level: 3, name: 'Waiting for a capacity slot' })
  expect(holderTable.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(heading.compareDocumentPosition(waiterTable) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(within(waiterTable).getAllByRole('row').map(cellsOf)).toEqual([
    ['HZ-103', 'Specialist agent implements', HOLDING, '2m 10s'],
  ])
})

test('a run waiting for a capacity slot reads as holding an agent slot, and the agent counts agree', async () => {
  await openWithMockReading()
  const running = screen.getByRole('region', { name: 'Running now' })
  const [runningTable, waitingTable] = within(running).getAllByRole('table')
  const waiter = within(waitingTable).getByText('HZ-103').closest('tr')
  expect(within(waiter).getByText(HOLDING)).toBeTruthy()

  const runningNow = within(runningTable).getAllByRole('row').length - 1
  const holding = within(waitingTable).queryAllByText(HOLDING).length
  const capacity = screen.getByRole('region', { name: 'Capacity' })
  const agentTile = within(capacity).getByText('Agent slots').closest('.farm-health__tile')
  const busy = Number(agentTile.querySelector('.farm-health__tile-count').textContent.match(/^(\d+) of/)[1])
  expect([runningNow, holding, busy]).toEqual([2, 1, 3])
  expect(runningNow + holding).toBe(busy)
})

test('the Capacity slots card says when no slot is in use, and when the farm cannot be reached', async () => {
  user = ADMIN
  reading = snapshot('green', 'All services up, slots free and box figures normal')
  window.history.pushState({}, '', '/farm-health')
  render(<App />)
  const card = await screen.findByRole('region', { name: 'Capacity slots' })
  expect(within(card).getByText('No capacity slot in use')).toBeTruthy()
  expect(within(card).getByText('Nothing waiting')).toBeTruthy()
  cleanup()

  reading = snapshot('red', 'Farm is not running')
  render(<App />)
  const red = await screen.findByRole('region', { name: 'Capacity slots' })
  expect(within(red).getByText('Farm not reachable — no capacity slot readings')).toBeTruthy()
})

// HZ-592: a waiter from farm code that sends no `reason` still names the slot
// it needs, never a bare "waiting for a slot".
test('a capacity-slot waiter with no reason reads as needing a capacity slot', async () => {
  user = ADMIN
  reading = snapshot('amber', '1 step is waiting for a slot')
  const now = new Date().toISOString()
  reading.waiting = [
    { itemId: 'HZ-7', step: 'Pre-merge checks', slot: 'check', startedAt: now, holdsAgentSlot: false, reason: null },
    { itemId: 'HZ-8', step: 'Specialist agent implements', slot: 'check', startedAt: now, holdsAgentSlot: true, reason: null },
  ]
  window.history.pushState({}, '', '/farm-health')
  render(<App />)
  const card = await screen.findByRole('region', { name: 'Capacity slots' })
  const waiterTable = within(card).getAllByRole('table').at(-1)
  expect(within(waiterTable).getAllByRole('row').map((row) => within(row).getAllByRole('cell')[2].textContent)).toEqual([
    'needs a capacity slot',
    'holding an agent slot · needs a capacity slot',
  ])
})

// ---- HZ-670: the Box card shows defunct processes and who holds them ----

test('the Box card lists defunct processes by the parent holding them, and says when none were measured', async () => {
  await openWithMockReading()
  const box = screen.getByRole('region', { name: 'Box' })
  expect(within(box).getByText('Defunct processes: 3 · PID 1234 holds 2 · PID 88 holds 1')).toBeTruthy()
  cleanup()
  vi.useRealTimers()

  reading = snapshot('green', 'All services up, slots free and box figures normal')
  reading.zombies = null
  render(<App />)
  const unmeasured = await screen.findByRole('region', { name: 'Box' })
  expect(within(unmeasured).getByText('Defunct processes: not measured')).toBeTruthy()
})
