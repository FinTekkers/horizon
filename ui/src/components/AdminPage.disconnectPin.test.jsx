// HZ-659: Disconnect asks for the gate PIN first, like Fix webhook. The PIN
// goes to disconnectRepo(projectId, repo, pin) and nowhere else; a wrong PIN
// says so and the repo row stays.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
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

function wrongPin() {
  const err = new Error('human_gate_key_required')
  err.status = 401
  return err
}

test('Disconnect asks for the PIN and sends it to disconnectRepo(projectId, repo, pin)', async () => {
  api.disconnectRepo.mockResolvedValue({ ok: true })
  const { getByRole, getByLabelText } = renderPage()
  fireEvent.click(getByRole('button', { name: `Disconnect ${REPO}` }))
  expect(api.disconnectRepo).not.toHaveBeenCalled()

  fireEvent.change(getByLabelText(`Gate PIN to disconnect ${REPO}`), { target: { value: '424242' } })
  fireEvent.click(getByRole('button', { name: 'Disconnect' }))
  await waitFor(() => expect(api.disconnectRepo).toHaveBeenCalledWith(7, REPO, '424242'))
  expect(JSON.stringify({ ...localStorage })).not.toContain('424242')
  expect(JSON.stringify({ ...sessionStorage })).not.toContain('424242')
})

test('a 401 shows "Wrong PIN" and the repo row stays', async () => {
  api.disconnectRepo.mockRejectedValue(wrongPin())
  const { getByRole, getByLabelText, findByText, container } = renderPage()
  fireEvent.click(getByRole('button', { name: `Disconnect ${REPO}` }))
  fireEvent.change(getByLabelText(`Gate PIN to disconnect ${REPO}`), { target: { value: '000000' } })
  fireEvent.click(getByRole('button', { name: 'Disconnect' }))
  expect(await findByText('Wrong PIN')).toBeTruthy()
  expect(container.querySelector('.repo-row__name').textContent).toBe(REPO)
  expect(getByLabelText(`Gate PIN to disconnect ${REPO}`).value).toBe('')
})

test('Cancel closes the PIN form without calling disconnectRepo', () => {
  const { getByRole, queryByLabelText } = renderPage()
  fireEvent.click(getByRole('button', { name: `Disconnect ${REPO}` }))
  fireEvent.click(getByRole('button', { name: 'Cancel' }))
  expect(queryByLabelText(`Gate PIN to disconnect ${REPO}`)).toBeNull()
  expect(api.disconnectRepo).not.toHaveBeenCalled()
})
