// HZ-764 metric 2: bare /admin opens on Needs attention when a webhook is
// broken, a test is flaky or a deploy failed — one row each, each with its fix
// button — and on the first project's Repositories tab when nothing is. The
// landing replaces the /admin history entry, so Back leaves Admin. The rule
// lives in AdminPage, so the 3 s cap on slow or failed reads is driven there
// with fake timers.

import { expect, test, vi, afterEach } from 'vitest'
import { act, render, cleanup, screen, waitFor, within } from '@testing-library/react'

const OWNER = { name: 'Test User', initials: 'TU', email: 'test@example.com', isAdmin: true }
const PROJECTS = [
  { id: 1, name: 'Fintekkers', enabled: true, repos: [{ repo: 'FinTekkers/ui-service', prefix: 'US' }] },
  { id: 2, name: 'Acme', enabled: true, repos: [{ repo: 'acme/web', prefix: 'AW' }] },
]
const CLEAN = {
  webhooks: { 1: [{ repo: 'FinTekkers/ui-service', status: 'ok' }], 2: [{ repo: 'acme/web', status: 'ok' }] },
  flakes: [],
  targets: [{ key: 'ui-service', repo: 'FinTekkers/ui-service', service: 'fintekkers-ui', lastResult: 'ok', lastTag: 'v1' }],
}
let reads = CLEAN
// One array, so useSyncExternalStore sees a stable snapshot.
const NO_ITEMS = []

vi.mock('./api', () => ({
  subscribe: () => () => {},
  getItems: () => NO_ITEMS,
  getCurrentUser: vi.fn(async () => OWNER),
  getFarmHealth: vi.fn(() => new Promise(() => {})),
  pinSessionLikelyVerified: () => false,
  getPinVerifiedUntil: () => null,
  lockPinSession: vi.fn(),
  getSync: () => ({ connected: false }),
  getProjects: () => PROJECTS,
  getActiveProjectId: () => null,
  hasSnapshot: () => false,
  getFarm: () => null,
  getDurationEstimates: () => null,
  getDeployBlock: () => null,
  getPlanProgress: () => [],
  getRestartSent: () => null,
  logout: vi.fn(),
  // The board, for Back.
  setPaused: vi.fn(),
  approveGate: vi.fn(),
  requestChanges: vi.fn(),
  restartPhase: vi.fn(),
  setPersona: vi.fn(),
  setStepProvider: vi.fn(),
  abandonItem: vi.fn(),
  addDependency: vi.fn(),
  createItem: vi.fn(),
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  // Admin's reads and the fixes.
  getDeployTargets: vi.fn(async () => ({ targets: reads.targets })),
  getCheckFlakes: vi.fn(async () => ({ repos: reads.flakes })),
  getDeployTargetConfig: vi.fn(async () => ({ targets: [] })),
  getRepoWebhooks: vi.fn(async (id) => ({ webhooks: reads.webhooks[id] ?? [] })),
  fixRepoWebhook: vi.fn(),
  dryRunDeployTarget: vi.fn(),
  listApiTokens: vi.fn(async () => ({ tokens: [] })),
}))

import App from './App'
import AdminPage, { LANDING_WAIT_MS } from './components/AdminPage'
import * as api from './api'

const readWebhooks = async (id) => ({ webhooks: reads.webhooks[id] ?? [] })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  window.history.pushState({}, '', '/')
  reads = CLEAN
  api.getRepoWebhooks.mockImplementation(readWebhooks)
})

const BROKEN = {
  webhooks: { 1: [{ repo: 'FinTekkers/ui-service', status: 'missing', lastResponseCode: null, reason: null }], 2: CLEAN.webhooks[2] },
  flakes: [
    { repo: 'acme/web', tests: [{ test: 'renders the cart', count: 2, count_7d: 2 }] },
    // HZ-657: not a repo of the viewer's projects, so no row.
    { repo: 'someone/else', tests: [{ test: 'hidden', count: 5, count_7d: 5 }] },
  ],
  targets: [{ key: 'ui-service', repo: 'FinTekkers/ui-service', service: 'fintekkers-ui', lastResult: 'failed', lastTag: 'v9' }],
}

test('with a missing webhook, a flaky test and a failed deploy, /admin lands on Needs attention; Back leaves Admin', async () => {
  reads = BROKEN
  window.history.pushState({}, '', '/admin')
  render(<App />)
  expect(await screen.findByRole('heading', { name: 'Needs attention' })).toBeTruthy()
  await waitFor(() => expect(window.location.pathname).toBe('/admin/attention'))

  const list = screen.getByRole('list', { name: 'Needs attention' })
  const rows = within(list).getAllByRole('listitem')
  expect(rows).toHaveLength(3)
  const rowOf = (name) => rows.find((row) => within(row).queryByRole('button', { name }))
  expect(within(rowOf('Fix webhook')).getByText('FinTekkers/ui-service')).toBeTruthy()
  expect(within(rowOf('Open flaky tests')).getByText('acme/web')).toBeTruthy()
  expect(within(rowOf('Dry run')).getByText('FinTekkers/ui-service')).toBeTruthy()
  expect(screen.queryByText('someone/else')).toBeNull()
  expect(screen.getByRole('button', { name: /^Needs attention/ }).getAttribute('aria-current')).toBe('page')

  window.history.back()
  expect(await screen.findByText('Work in flight')).toBeTruthy()
  expect(window.location.pathname).toBe('/')
})

test('with nothing broken, /admin lands on the first project with its Repositories tab selected', async () => {
  window.history.pushState({}, '', '/admin')
  render(<App />)
  expect(await screen.findByRole('heading', { name: 'Fintekkers' })).toBeTruthy()
  await waitFor(() => expect(window.location.pathname).toBe('/admin/projects/1'))
  expect(screen.getByRole('tab', { name: 'Repositories' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('button', { name: /^Fintekkers$/ }).getAttribute('aria-current')).toBe('page')
  expect(screen.queryByRole('heading', { name: 'Needs attention' })).toBeNull()
})

// ---- the 3 s cap: a failed read and a read that never answers add no row ----

const home = { section: null, project: null, tab: null, repo: null, home: true, unknown: false }

function renderLanding() {
  api.getRepoWebhooks.mockImplementation((id) =>
    id === 1 ? Promise.reject(new Error('GitHub unreachable')) : new Promise(() => {}),
  )
  const onNavigate = vi.fn()
  const utils = render(<AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} route={home} onNavigate={onNavigate} />)
  return { ...utils, onNavigate }
}

test('a rejected and a hanging webhook read: after 3 s Admin lands on the first project, with no row for either', async () => {
  vi.useFakeTimers()
  const { onNavigate, unmount } = renderLanding()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LANDING_WAIT_MS - 1)
  })
  expect(onNavigate).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toBe('Checking for problems…')

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(onNavigate).toHaveBeenCalledTimes(1)
  expect(onNavigate).toHaveBeenCalledWith('/admin/projects/1', { replace: true })
  expect(screen.queryByRole('button', { name: /^Needs attention/ }).querySelector('.admin-nav__badge')).toBeNull()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

test('leaving before the 3 s are up leaves no timer behind and never navigates', async () => {
  vi.useFakeTimers()
  const { onNavigate, unmount } = renderLanding()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(vi.getTimerCount()).toBe(1)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(LANDING_WAIT_MS)
  expect(onNavigate).not.toHaveBeenCalled()
})

// A cold load renders Admin before the first board frame, with no projects
// yet: it must not land on New project then.
test('before the first board frame, /admin waits for the project list instead of landing on New project', async () => {
  const onNavigate = vi.fn()
  const page = (projects, snapshotReady) => (
    <AdminPage sync={{}} projects={projects} onBack={() => {}} route={home} onNavigate={onNavigate} snapshotReady={snapshotReady} />
  )
  const { rerender } = render(page([], false))
  await waitFor(() => expect(api.getCheckFlakes).toHaveBeenCalled())
  await act(async () => {})
  expect(onNavigate).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toBe('Checking for problems…')

  rerender(page(PROJECTS, true))
  await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('/admin/projects/1', { replace: true }))
  expect(onNavigate).toHaveBeenCalledTimes(1)
})
