// HZ-564: Admin's sections have their own URLs under /admin. App's parsePath
// owns them, so a deep link opens its section, a click pushes its URL, back
// and forward show the matching section, an unknown /admin/... path falls back
// to /admin, and no /admin/... path ever reaches the item tracker. The other
// routes behave as before.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor, screen } from '@testing-library/react'

let items = []

vi.mock('./api', () => ({
  subscribe: () => () => {},
  getItems: () => items,
  getCurrentUser: vi.fn(async () => ({ name: 'Test User', initials: 'TU', email: 'test@example.com' })),
  getSync: () => ({ connected: false }),
  getProjects: () => [{ id: 1, name: 'Fintekkers', enabled: true, repos: [{ repo: 'FinTekkers/ui-service', prefix: 'US' }] }],
  getActiveProjectId: () => null,
  getFarm: () => null,
  getDurationEstimates: () => null,
  getDeployBlock: () => null,
  getPlanProgress: () => [],
  getRestartSent: () => null,
  setPaused: vi.fn(),
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
})

// [section, its heading, its button in the list]
const SECTIONS = [
  ['projects', 'Projects', 'Projects and repositories'],
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

test('an unknown /admin path shows Projects and its URL becomes /admin, on first load and on popstate', async () => {
  window.history.pushState({}, '', '/admin/nope')
  render(<App />)
  expect(await heading('Projects')).toBeTruthy()
  await waitFor(() => expect(window.location.pathname).toBe('/admin'))
  expect(document.querySelector('.tracker__id')).toBeNull()

  fireEvent.click(navButton('Flaky tests'))
  await heading('Flaky tests')
  window.history.pushState({}, '', '/admin/nope/deeper')
  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(await heading('Projects')).toBeTruthy()
  await waitFor(() => expect(window.location.pathname).toBe('/admin'))
})

test('clicking a section pushes its URL; back, then forward, shows the matching section each time', async () => {
  window.history.pushState({}, '', '/admin')
  render(<App />)
  await heading('Projects')
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
  await heading('Projects')
  expect(window.location.pathname).toBe('/admin')
  fireEvent.click(navButton('Deploy targets'))
  await heading('Deploy targets')

  window.history.go(-2)
  expect(await screen.findByText('Work in flight')).toBeTruthy()
  expect(window.location.pathname).toBe('/')
  window.history.go(2)
  expect(await heading('Deploy targets')).toBeTruthy()
  expect(window.location.pathname).toBe('/admin/deploys')
})

test('a deeper path under Projects shows Projects, keeps its URL and never opens the tracker', async () => {
  window.history.pushState({}, '', '/admin/projects/fintekkers/ui-service/checks')
  render(<App />)
  expect(await heading('Projects')).toBeTruthy()
  await screen.findByText('Fintekkers')
  expect(window.location.pathname).toBe('/admin/projects/fintekkers/ui-service/checks')
  expect(document.querySelector('.tracker__id')).toBeNull()
  expect(document.title).toBe('Horizon · Delivery Lifecycle')
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
