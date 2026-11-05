// HZ-564: Admin's sections have their own URLs under /admin. App's parsePath
// owns them, so a deep link opens its section, a click pushes its URL, back
// and forward show the matching section, an unknown /admin/... path falls back
// to /admin, and no /admin/... path ever reaches the item tracker. The other
// routes behave as before. HZ-660: those are the owner's; a member is shown
// only Account, and never reads an owner-only route. HZ-764: bare /admin
// lands on Needs attention or the first project (App.adminLanding.test.jsx);
// each project tab and each repository has its own URL.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor, screen } from '@testing-library/react'

let items = []
const PROJECTS = [
  { id: 1, name: 'Fintekkers', enabled: true, repos: [{ repo: 'FinTekkers/ui-service', prefix: 'US' }] },
  { id: 2, name: 'Acme', enabled: true, repos: [{ repo: 'acme/web', prefix: 'AW' }] },
]
const OWNER = { name: 'Test User', initials: 'TU', email: 'test@example.com', isAdmin: true }
const MEMBER = { name: 'Max Member', initials: 'MM', email: 'member@example.com', isAdmin: false }
let currentUser = OWNER

vi.mock('./api', () => ({
  subscribe: () => () => {},
  getItems: () => items,
  getCurrentUser: vi.fn(async () => currentUser),
  getFarmHealth: vi.fn(() => new Promise(() => {})),
  // HZ-704: Your PIN and API tokens reads the session's PIN state.
  pinSessionLikelyVerified: () => false,
  getPinVerifiedUntil: () => null,
  lockPinSession: vi.fn(),
  getSync: () => ({ connected: false }),
  getProjects: () => PROJECTS,
  getActiveProjectId: () => null,
  // HZ-661: no board frame yet, so the first-project screen stays off.
  hasSnapshot: () => false,
  getFarm: () => null,
  getDurationEstimates: () => null,
  getDeployBlock: () => null,
  getPlanProgress: () => [],
  getRestartSent: () => null,
  setPaused: vi.fn(),
  releaseRuleBlock: vi.fn(),
  releaseUsageWait: vi.fn(),
  approveGate: vi.fn(),
  requestChanges: vi.fn(),
  restartPhase: vi.fn(),
  setPersona: vi.fn(),
  setStepProvider: vi.fn(),
  abandonItem: vi.fn(),
  addDependency: vi.fn(),
  createItem: vi.fn(),
  logout: vi.fn(),
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  // Admin's reads.
  getDeployTargets: vi.fn(async () => ({ targets: [] })),
  getCheckFlakes: vi.fn(async () => ({ repos: [] })),
  getDeployTargetConfig: vi.fn(async () => ({ targets: [] })),
  getRepoWebhooks: vi.fn(async () => ({ webhooks: [] })),
  listApiTokens: vi.fn(async () => ({ tokens: [] })),
  // Agent definitions' reads.
  listDefinitions: vi.fn(() => new Promise(() => {})),
  listRuleTargets: vi.fn(() => new Promise(() => {})),
}))

import App from './App'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  items = []
  currentUser = OWNER
})

// [section, its heading, its button in the list]
const SECTIONS = [
  ['attention', 'Needs attention', 'Needs attention'],
  ['deploys', 'Deploy targets', 'Deploy targets'],
  ['flaky', 'Flaky tests', 'Flaky tests'],
  ['github', 'GitHub access', 'GitHub access'],
  ['account', 'Personal API tokens', 'Your PIN and API tokens'],
]

const heading = (name) => screen.findByRole('heading', { name })
const navButton = (label) => screen.getByRole('button', { name: new RegExp(`^${label}`) })

test.each(SECTIONS)('/admin/%s opens that section with its heading', async (section, name, label) => {
  window.history.pushState({}, '', `/admin/${section}`)
  render(<App />)
  expect(await heading(name)).toBeTruthy()
  expect(navButton(label).getAttribute('aria-current')).toBe('page')
  expect(window.location.pathname).toBe(`/admin/${section}`)
})

// HZ-764: /admin then lands; with nothing to fix, on the first project.
test('an unknown /admin path becomes /admin and lands on the first project, on first load and on popstate', async () => {
  window.history.pushState({}, '', '/admin/nope')
  render(<App />)
  expect(await heading('Fintekkers')).toBeTruthy()
  await waitFor(() => expect(window.location.pathname).toBe('/admin/projects/1'))
  expect(document.querySelector('.tracker__id')).toBeNull()

  fireEvent.click(navButton('Flaky tests'))
  await heading('Flaky tests')
  window.history.pushState({}, '', '/admin/nope/deeper')
  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(await heading('Fintekkers')).toBeTruthy()
  await waitFor(() => expect(window.location.pathname).toBe('/admin/projects/1'))
})

test('clicking a section pushes its URL; back, then forward, shows the matching section each time', async () => {
  window.history.pushState({}, '', '/admin')
  render(<App />)
  await heading('Fintekkers')
  const before = window.history.length

  fireEvent.click(navButton('Deploy targets'))
  expect(await heading('Deploy targets')).toBeTruthy()
  expect(window.location.pathname).toBe('/admin/deploys')
  fireEvent.click(navButton('Flaky tests'))
  expect(await heading('Flaky tests')).toBeTruthy()
  expect(window.location.pathname).toBe('/admin/flaky')
  expect(window.history.length).toBe(before + 2)

  window.history.back()
  expect(await heading('Deploy targets')).toBeTruthy()
  expect(window.location.pathname).toBe('/admin/deploys')
  window.history.forward()
  expect(await heading('Flaky tests')).toBeTruthy()
  expect(window.location.pathname).toBe('/admin/flaky')
})

test('leaving Admin and coming back: back to / shows the board, forward shows the section it left', async () => {
  render(<App />)
  await screen.findByText('Work in flight')
  fireEvent.click(document.querySelector('.topbar__avatar'))
  fireEvent.click(screen.getByRole('button', { name: 'Admin' }))
  await heading('Fintekkers')
  await waitFor(() => expect(window.location.pathname).toBe('/admin/projects/1'))
  fireEvent.click(navButton('Deploy targets'))
  await heading('Deploy targets')

  window.history.go(-2)
  expect(await screen.findByText('Work in flight')).toBeTruthy()
  expect(window.location.pathname).toBe('/')
  window.history.go(2)
  expect(await heading('Deploy targets')).toBeTruthy()
  expect(window.location.pathname).toBe('/admin/deploys')
})

// HZ-764: the pre-HZ-764 placeholder shape projects/<slug>/<repo>/<tab> is
// unknown: it becomes /admin, which lands, and never opens the tracker.
test('the old projects/<slug>/<repo>/<tab> shape is rewritten to /admin and never opens the tracker', async () => {
  window.history.pushState({}, '', '/admin/projects/fintekkers/ui-service/checks')
  render(<App />)
  expect(await heading('Fintekkers')).toBeTruthy()
  await waitFor(() => expect(window.location.pathname).toBe('/admin/projects/1'))
  expect(document.querySelector('.tracker__id')).toBeNull()
  expect(document.title).toBe('Horizon · Delivery Lifecycle')
})

// ---- HZ-764 metric 1: a project tab and a repository page load directly ----

const projectEntry = (name) => screen.getByRole('button', { name: new RegExp(`^${name}$`) })
const tab = (name) => screen.getByRole('tab', { name })

test.each([
  ['/admin/projects/2', 'Repositories'],
  ['/admin/projects/2/automation', 'Automation'],
  ['/admin/projects/2/agents', 'Agents'],
  ['/admin/projects/2/settings', 'Settings'],
])('%s loads that project with its nav entry current and the %s tab selected', async (path, tabName) => {
  window.history.pushState({}, '', path)
  render(<App />)
  expect(await heading('Acme')).toBeTruthy()
  expect(projectEntry('Acme').getAttribute('aria-current')).toBe('page')
  expect(projectEntry('Fintekkers').getAttribute('aria-current')).toBeNull()
  expect(tab(tabName).getAttribute('aria-selected')).toBe('true')
  expect(screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1)
  expect(window.location.pathname).toBe(path)
})

test('a repository URL loads its page under its project, with Repositories selected', async () => {
  window.history.pushState({}, '', '/admin/projects/2/repos/acme/web')
  render(<App />)
  expect(await heading('Acme')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'acme/web' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Disconnect acme/web' })).toBeTruthy()
  expect(projectEntry('Acme').getAttribute('aria-current')).toBe('page')
  expect(tab('Repositories').getAttribute('aria-selected')).toBe('true')
  expect(window.location.pathname).toBe('/admin/projects/2/repos/acme/web')
})

test('clicking a tab, then a repository, pushes each URL; back shows the tab again', async () => {
  window.history.pushState({}, '', '/admin/projects/2/settings')
  render(<App />)
  await heading('Acme')
  fireEvent.click(tab('Repositories'))
  await waitFor(() => expect(window.location.pathname).toBe('/admin/projects/2'))
  fireEvent.click(screen.getByRole('button', { name: 'acme/web' }))
  expect(await screen.findByRole('heading', { name: 'acme/web' })).toBeTruthy()
  expect(window.location.pathname).toBe('/admin/projects/2/repos/acme/web')
  window.history.back()
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'acme/web' })).toBeNull())
  expect(window.location.pathname).toBe('/admin/projects/2')
})

const ITEM = {
  id: 'HZ-1',
  title: 'A deep-linked work item',
  desc: '',
  metric: '',
  guardrails: '',
  priority: 'Medium',
  cursor: 0,
  paused: false,
  rejected: false,
  events: [],
  stepOutputs: {},
  activeRun: null,
}

test.each([
  ['/', () => screen.findByText('Work in flight')],
  ['/definitions', () => screen.findByText('Agent definitions', { selector: '.admin__title' })],
  ['/hz-1', () => screen.findByText('HZ-1', { selector: '.tracker__id' })],
  ['/privacy', () => screen.findByRole('heading', { level: 1, name: /privacy/i })],
])('%s renders the same view as before', async (path, find) => {
  items = [ITEM]
  window.history.pushState({}, '', path)
  render(<App />)
  expect(await find()).toBeTruthy()
  expect(document.querySelector('.admin-nav')).toBeNull()
  expect(window.location.pathname).toBe(path)
})

// ---- HZ-660 metric 5: a member's Admin page renders none of the owner-only sections ----

// HZ-703: Account, and the member's own project check commands.
const MEMBER_SECTIONS = ["Your project's check commands", 'Your PIN and API tokens']
const OWNER_ENTRIES = [
  'Needs attention',
  'Fintekkers',
  'Acme',
  'New project',
  'Deploy targets',
  'Flaky tests',
  'GitHub access',
  'Your PIN and API tokens',
]
const navLabels = () => [...document.querySelectorAll('.admin-nav__label')].map((el) => el.textContent)

test('a member cold-loading /admin/deploys lands on /admin/account, sees only Account and reads no owner-only route', async () => {
  const api = await import('./api')
  currentUser = MEMBER
  window.history.pushState({}, '', '/admin/deploys')
  render(<App />)
  expect(await heading('Personal API tokens')).toBeTruthy()
  await waitFor(() => expect(window.location.pathname).toBe('/admin/account'))
  expect(navLabels()).toEqual(MEMBER_SECTIONS)
  expect(navButton('Your PIN and API tokens').getAttribute('aria-current')).toBe('page')
  expect(screen.queryByRole('heading', { name: 'Deploy targets' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Projects' })).toBeNull()
  expect(api.getDeployTargets).not.toHaveBeenCalled()
  expect(api.getCheckFlakes).not.toHaveBeenCalled()
  expect(api.getDeployTargetConfig).not.toHaveBeenCalled()

  fireEvent.click(document.querySelector('.topbar__avatar'))
  expect(screen.getByRole('button', { name: 'Admin' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Farm health/ })).toBeNull()
  expect(api.getFarmHealth).not.toHaveBeenCalled()
})

test('a member opening Admin from the menu, or an owner-only section by popstate, gets Account', async () => {
  currentUser = MEMBER
  render(<App />)
  await screen.findByText('Work in flight')
  fireEvent.click(document.querySelector('.topbar__avatar'))
  fireEvent.click(screen.getByRole('button', { name: 'Admin' }))
  expect(await heading('Personal API tokens')).toBeTruthy()
  await waitFor(() => expect(window.location.pathname).toBe('/admin/account'))

  window.history.pushState({}, '', '/admin/github')
  window.dispatchEvent(new PopStateEvent('popstate'))
  await waitFor(() => expect(window.location.pathname).toBe('/admin/account'))
  expect(screen.queryByRole('heading', { name: 'GitHub access' })).toBeNull()
  expect(navLabels()).toEqual(MEMBER_SECTIONS)
})

// HZ-764 guardrail (HZ-660): Needs attention, a project tab and a repository
// page are the owner's. A member deep-loading one gets Account, and no
// project or attention data renders.
test.each(['/admin/attention', '/admin/projects/1/agents', '/admin/projects/1/repos/FinTekkers/ui-service'])(
  'a member deep-loading %s is sent to /admin/account and sees no project data',
  async (path) => {
    const api = await import('./api')
    currentUser = MEMBER
    window.history.pushState({}, '', path)
    render(<App />)
    expect(await heading('Personal API tokens')).toBeTruthy()
    await waitFor(() => expect(window.location.pathname).toBe('/admin/account'))
    expect(navLabels()).toEqual(MEMBER_SECTIONS)
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Fintekkers' })).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByText('FinTekkers/ui-service')).toBeNull()
    expect(api.getRepoWebhooks).not.toHaveBeenCalled()
    expect(api.getCheckFlakes).not.toHaveBeenCalled()
    expect(api.getDeployTargets).not.toHaveBeenCalled()
  },
)

test('the owner cold-loading /admin/deploys stays there and sees every entry', async () => {
  const api = await import('./api')
  window.history.pushState({}, '', '/admin/deploys')
  render(<App />)
  expect(await heading('Deploy targets')).toBeTruthy()
  expect(window.location.pathname).toBe('/admin/deploys')
  expect(navLabels()).toEqual(OWNER_ENTRIES)
  expect(api.getDeployTargets).toHaveBeenCalled()
})
