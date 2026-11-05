// HZ-564: under the production base path (/horizon, as on shoreward.ai),
// Admin's deep links, its clicks and the unknown-path rewrite all keep the
// prefix — parsePath and navigate own it, as for every other route.

import { expect, test, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor, screen } from '@testing-library/react'

vi.mock('./api', () => {
  // One array each, so useSyncExternalStore sees a stable snapshot.
  const none = []
  return {
    subscribe: () => () => {},
    getItems: () => none,
    // HZ-660: the owner — a member sees only Account (App.adminRoutes.test.jsx).
    getCurrentUser: vi.fn(async () => ({ name: 'Test User', initials: 'TU', email: 'test@example.com', isAdmin: true })),
    getFarmHealth: vi.fn(() => new Promise(() => {})),
    getSync: () => ({ connected: false }),
    getProjects: () => none,
    // HZ-764: the first frame is in, so Admin may land with no project.
    hasSnapshot: () => true,
    getActiveProjectId: () => null,
    getFarm: () => null,
    getDurationEstimates: () => null,
    getDeployBlock: () => null,
    getPlanProgress: () => [],
    getDeployTargets: vi.fn(async () => ({ targets: [] })),
    getCheckFlakes: vi.fn(async () => ({ repos: [] })),
    getDeployTargetConfig: vi.fn(async () => ({ targets: [] })),
  }
})

let App

beforeAll(async () => {
  // PREFIX is read once at module load, so App is imported after the stub.
  vi.stubEnv('BASE_URL', '/horizon/')
  vi.resetModules()
  App = (await import('./App')).default
})

afterAll(() => {
  vi.unstubAllEnvs()
})

afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
})

test('/horizon/admin/deploys opens Deploy targets, and a click pushes /horizon/admin/<section>', async () => {
  window.history.pushState({}, '', '/horizon/admin/deploys')
  render(<App />)
  expect(await screen.findByRole('heading', { name: 'Deploy targets' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: /^Flaky tests/ }))
  expect(await screen.findByRole('heading', { name: 'Flaky tests' })).toBeTruthy()
  expect(window.location.pathname).toBe('/horizon/admin/flaky')
})

// HZ-764: /horizon/admin then lands on New project (there is no project).
test('/horizon/admin/nope is rewritten to /horizon/admin, which lands on New project', async () => {
  window.history.pushState({}, '', '/horizon/admin/nope')
  render(<App />)
  expect(await screen.findByRole('heading', { name: 'New project' })).toBeTruthy()
  await waitFor(() => expect(window.location.pathname).toBe('/horizon/admin/projects/new'))
  expect(document.querySelector('.tracker__id')).toBeNull()
})
