// HZ-659: Disconnect is confirmed first, like Fix webhook, and is gate-PIN
// protected (HZ-704: the PIN dialog in serverApi asks for it). A cancelled PIN
// prompt says so and the repo row stays.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
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
  fixRepoWebhook: vi.fn(),
  dryRunDeployTarget: vi.fn(),
  getCheckFlakes: vi.fn(async () => ({ repos: [] })),
  getDeployTargets: vi.fn(async () => ({ targets: [] })),
}))

import AdminPage from './AdminPage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})

const REPO = 'acme/web'

function renderPage() {
  const projects = [{ id: 7, name: 'Pins', enabled: true, repos: [{ repo: REPO, prefix: 'AW' }] }]
  return render(<AdminPage sync={{}} projects={projects} onBack={() => {}} route={{ section: 'projects' }} />)
}

function pinNeeded() {
  return Object.assign(new Error('pin_needed'))
}

test('Disconnect asks for confirmation and calls disconnectRepo(projectId, repo)', async () => {
  api.disconnectRepo.mockResolvedValue({ ok: true })
  const { getByRole, queryByLabelText } = renderPage()
  fireEvent.click(getByRole('button', { name: `Disconnect ${REPO}` }))
  expect(api.disconnectRepo).not.toHaveBeenCalled()
  expect(queryByLabelText(`Gate PIN to disconnect ${REPO}`)).toBeNull()

  fireEvent.click(getByRole('button', { name: 'Disconnect' }))
  await waitFor(() => expect(api.disconnectRepo).toHaveBeenCalledWith(7, REPO))
})

test('a cancelled PIN prompt says nothing was changed and the repo row stays', async () => {
  api.disconnectRepo.mockRejectedValue(pinNeeded())
  const { getByRole, findByText, container } = renderPage()
  fireEvent.click(getByRole('button', { name: `Disconnect ${REPO}` }))
  fireEvent.click(getByRole('button', { name: 'Disconnect' }))
  expect(await findByText('Gate PIN needed — nothing was changed')).toBeTruthy()
  expect(container.querySelector('.repo-row__name').textContent).toBe(REPO)
})

test('Cancel closes the confirm form without calling disconnectRepo', () => {
  const { getByRole, queryByRole } = renderPage()
  fireEvent.click(getByRole('button', { name: `Disconnect ${REPO}` }))
  fireEvent.click(getByRole('button', { name: 'Cancel' }))
  expect(queryByRole('button', { name: 'Disconnect' })).toBeNull()
  expect(api.disconnectRepo).not.toHaveBeenCalled()
})
