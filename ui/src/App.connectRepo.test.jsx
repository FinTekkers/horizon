// HZ-703: the "Connect your repository" card in App. The member's project is
// built by the server's own memberProject (boardView.js), so it has exactly
// the fields a member's board frame carries — no `isolation`. The card stands
// in for the empty board after "Set up your first project", links to GitHub's
// token page and to the member's check commands, and outlives the frame that
// adds the repository. The owner never sees it, nor /admin/checks.

import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { memberProject } from '../../server/src/boardView.js'

const OWNER = { name: 'Test User', initials: 'TU', email: 'test@example.com', isAdmin: true }
const MEMBER = { name: 'Max Member', initials: 'MM', email: 'member@example.com', isAdmin: false }
// A tenant project as the server stores it; the member's frame drops the rest.
const STORED = { id: 7, name: 'Acme', enabled: true, isolation: 'tenant', unlinked: false, autopilot: true, repos: [] }
const CONNECTED = { repo: 'Acme/site', prefix: 'ACME', defaultBranch: 'main', githubTokenRef: '$HZ_TENANT_7', runUser: 'acme', webhook: { status: 'ok' } }

let currentUser = MEMBER
let projects = [memberProject(STORED)]
let items = []
const listeners = new Set()

vi.mock('./api', () => ({
  subscribe: (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  getItems: () => items,
  getCurrentUser: vi.fn(async () => currentUser),
  getFarmHealth: vi.fn(() => new Promise(() => {})),
  getSync: () => ({ connected: false }),
  getProjects: () => projects,
  getActiveProjectId: () => 7,
  hasSnapshot: () => true,
  getFarm: () => null,
  getDurationEstimates: () => null,
  getDeployBlock: () => null,
  getPlanProgress: () => [],
  getRestartSent: () => null,
  setPaused: vi.fn(),
  createProject: vi.fn(),
  connectTenantRepo: vi.fn(async () => CONNECTED),
  getTenantChecks: vi.fn(async () => ({ repo: 'Acme/site', checks: { install: null, test: null, e2e: null } })),
  saveTenantChecks: vi.fn(),
  logout: vi.fn(),
  getDeployTargets: vi.fn(async () => ({ targets: [] })),
  getCheckFlakes: vi.fn(async () => ({ repos: [] })),
  getDeployTargetConfig: vi.fn(async () => ({ targets: [] })),
  getRepoWebhooks: vi.fn(async () => ({ webhooks: [] })),
  listApiTokens: vi.fn(async () => ({ tokens: [] })),
}))

import App from './App'
import * as api from './api'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  currentUser = MEMBER
  projects = [memberProject(STORED)]
  items = []
  listeners.clear()
})

// A board frame: new projects and items, then every subscriber told.
function frame(next) {
  projects = next
  items = []
  act(() => listeners.forEach((fn) => fn()))
}

const newItemButton = () => screen.getByRole('button', { name: '+ New work item' })

test("metric 4: a member's project with no repository shows the card in place of the empty board, with New item disabled", async () => {
  expect(projects[0]).not.toHaveProperty('isolation')
  render(<App />)
  expect(await screen.findByRole('heading', { name: 'Connect your repository' })).toBeTruthy()
  expect(screen.queryByText('No work items yet.')).toBeNull()
  expect(newItemButton().disabled).toBe(true)
  expect(newItemButton().getAttribute('title')).toBe('Connect a repository first')

  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'Acme/site' } })
  const link = screen.getByRole('link', { name: /Create a token on GitHub/ })
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  const url = new URL(link.getAttribute('href'))
  expect(`${url.origin}${url.pathname}`).toBe('https://github.com/settings/personal-access-tokens/new')
  expect(url.searchParams.get('target_name')).toBe('Acme')
  for (const [param, level] of [
    ['contents', 'write'],
    ['issues', 'write'],
    ['pull_requests', 'write'],
    ['repository_hooks', 'write'],
    ['actions', 'read'],
    ['metadata', 'read'],
  ]) {
    expect(url.searchParams.get(param), param).toBe(level)
  }
})

test('metric 4: the connected view links to the check commands page, at /admin/checks', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Connect your repository' })
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'Acme/site' } })
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'github_pat_11ABCDEFGHIJKLMNOPQRSTUV' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }))
  expect(await screen.findByRole('heading', { name: 'Repository connected' })).toBeTruthy()
  expect(api.connectTenantRepo).toHaveBeenCalledWith(7, 'Acme/site', 'github_pat_11ABCDEFGHIJKLMNOPQRSTUV')

  const settings = screen.getByRole('link', { name: 'Set your check commands' })
  expect(settings.getAttribute('href')).toBe('/admin/checks')
  fireEvent.click(settings)
  expect(await screen.findByRole('heading', { name: "Your project's check commands" })).toBeTruthy()
  expect(window.location.pathname).toBe('/admin/checks')
})

test('the connected view stays up after the frame that adds the repository, until File your first item', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Connect your repository' })
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'Acme/site' } })
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'github_pat_11ABCDEFGHIJKLMNOPQRSTUV' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect repository' }))
  await screen.findByRole('heading', { name: 'Repository connected' })

  frame([memberProject({ ...STORED, repos: [{ repo: 'Acme/site', prefix: 'ACME', default_branch: 'main' }] })])
  expect(screen.getByRole('heading', { name: 'Repository connected' })).toBeTruthy()
  expect(newItemButton().disabled).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: 'File your first item' }))
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Repository connected' })).toBeNull())
  expect(screen.queryByRole('heading', { name: 'Connect your repository' })).toBeNull()
  expect(screen.getByText('No work items yet.')).toBeTruthy()
})

test('the owner never sees the card, even on a project with no repository', async () => {
  currentUser = OWNER
  render(<App />)
  expect(await screen.findByText('No work items yet.')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Connect your repository' })).toBeNull()
  expect(newItemButton().disabled).toBe(false)
})

test("guardrail 2: the owner's /admin/checks goes to /admin, and the member-only section is not rendered", async () => {
  currentUser = OWNER
  window.history.pushState({}, '', '/admin/checks')
  render(<App />)
  expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy()
  await waitFor(() => expect(window.location.pathname).toBe('/admin'))
  expect(screen.queryByRole('heading', { name: "Your project's check commands" })).toBeNull()
  expect(api.getTenantChecks).not.toHaveBeenCalled()
})
