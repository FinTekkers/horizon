// Render tests for the read-only deploy-targets panel (HZ-41): it must show
// each target's repo/service/last-tag/last-result, and — this is the
// guardrail that matters — it must never render a button, form, or input,
// since a deploy target names a script and a service to restart and an
// editable target would be arbitrary code execution.
//
// Also the personal API tokens panel (HZ-179): the raw token is shown once and
// never persisted, and the list shows only the safe fields.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, within, fireEvent, waitFor } from '@testing-library/react'
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
  getDeployTargets: vi.fn(async () => ({
    targets: [
      {
        key: 'horizon',
        repo: 'FinTekkers/horizon',
        service: 'horizon-server',
        lastTag: 'refs/tags/v42',
        lastCommit: 'abc1234',
        lastResult: 'ok',
        lastAt: '2026-09-14T03:22:10Z',
      },
      {
        key: 'ui-service',
        repo: 'FinTekkers/ui-service',
        service: 'fintekkers-ui',
        lastTag: null,
        lastCommit: null,
        lastResult: 'never',
        lastAt: null,
      },
    ],
  })),
}))

import AdminPage from './AdminPage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  // Back to the vi.fn() implementations above, so no test's queued token list
  // leaks into the next.
  api.listApiTokens.mockReset()
  api.createApiToken.mockReset()
  localStorage.clear()
  sessionStorage.clear()
})

function findDeployTargetsPanel(container) {
  const title = Array.from(container.querySelectorAll('.panel__title')).find((el) => el.textContent === 'Deploy targets')
  return title.closest('.admin__panel')
}

test('renders one row per deploy target with repo, service, tag, and result', async () => {
  const { findByText, container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} />)
  await findByText('FinTekkers/horizon')

  const panel = findDeployTargetsPanel(container)
  const scoped = within(panel)
  expect(scoped.getByText('FinTekkers/horizon')).toBeTruthy()
  expect(scoped.getByText('horizon-server')).toBeTruthy()
  expect(scoped.getByText('refs/tags/v42')).toBeTruthy()
  expect(scoped.getByText(/^ok/)).toBeTruthy()

  expect(scoped.getByText('FinTekkers/ui-service')).toBeTruthy()
  expect(scoped.getByText('fintekkers-ui')).toBeTruthy()
  expect(scoped.getByText('no deploy yet')).toBeTruthy()
  expect(scoped.getByText(/^never/)).toBeTruthy()
})

test('the deploy-targets panel renders no button, form, or input anywhere (read-only guardrail)', async () => {
  const { findByText, container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} />)
  await findByText('FinTekkers/horizon')

  const panel = findDeployTargetsPanel(container)
  expect(panel.querySelectorAll('button, form, input, textarea, select').length).toBe(0)
})

// ---- personal API tokens (HZ-179) ----

const RAW_TOKEN = 'hz_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa9Zk'
const LISTED = {
  id: 'tok_1',
  name: 'ci-bot',
  last4: 'a9Zk',
  createdAt: '2026-10-01T09:00:00.000Z',
  lastUsedAt: null,
  expiresAt: '2026-12-30T09:00:00.000Z',
}

function findTokensPanel(container) {
  const title = Array.from(container.querySelectorAll('.panel__title')).find((el) => el.textContent.includes('Personal API tokens'))
  return title.closest('.admin__panel')
}

test('the expiry input defaults to 90 days with a 365-day maximum', async () => {
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} />)
  const days = within(findTokensPanel(container)).getByLabelText('Expires in days')
  expect(days.value).toBe('90')
  expect(days.getAttribute('max')).toBe('365')
  expect(days.getAttribute('min')).toBe('1')
})

test('creating a token shows the raw value once; after Done only last4 remains, and nothing is stored', async () => {
  api.createApiToken.mockResolvedValueOnce({ ...LISTED, token: RAW_TOKEN })
  api.listApiTokens.mockResolvedValueOnce({ tokens: [] }).mockResolvedValue({ tokens: [LISTED] })
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} />)
  const panel = within(findTokensPanel(container))

  fireEvent.change(panel.getByPlaceholderText(/Token name/), { target: { value: 'ci-bot' } })
  fireEvent.change(panel.getByLabelText('Expires in days'), { target: { value: '30' } })
  fireEvent.click(panel.getByText('Create token'))

  await panel.findByText(RAW_TOKEN)
  expect(api.createApiToken).toHaveBeenCalledWith({ name: 'ci-bot', expiresInDays: 30 })
  await panel.findByText('…a9Zk')
  expect(JSON.stringify({ ...localStorage })).not.toContain(RAW_TOKEN)
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(RAW_TOKEN)

  fireEvent.click(panel.getByText('Done'))
  expect(container.innerHTML).not.toContain(RAW_TOKEN)
  expect(panel.getByText('ci-bot')).toBeTruthy()
  expect(panel.getByText('…a9Zk')).toBeTruthy()
  expect(panel.getByText(/last used never/)).toBeTruthy()
})

test('an out-of-range expiry is refused before any request is made', async () => {
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} />)
  const panel = within(findTokensPanel(container))
  fireEvent.change(panel.getByPlaceholderText(/Token name/), { target: { value: 'ci-bot' } })
  fireEvent.change(panel.getByLabelText('Expires in days'), { target: { value: '366' } })
  fireEvent.click(panel.getByText('Create token'))
  await panel.findByText(/from 1 to 365/)
  expect(api.createApiToken).not.toHaveBeenCalled()
})

test('Revoke asks for confirmation, then revokes and drops the row', async () => {
  api.listApiTokens.mockResolvedValueOnce({ tokens: [LISTED] }).mockResolvedValue({ tokens: [] })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} />)
  const panel = within(findTokensPanel(container))
  fireEvent.click(await panel.findByText('Revoke'))
  await waitFor(() => expect(api.revokeApiToken).toHaveBeenCalledWith('tok_1'))
  await panel.findByText('No active tokens.')
})

test('cancelling the Revoke confirmation revokes nothing', async () => {
  api.listApiTokens.mockResolvedValue({ tokens: [LISTED] })
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} />)
  const panel = within(findTokensPanel(container))
  fireEvent.click(await panel.findByText('Revoke'))
  expect(api.revokeApiToken).not.toHaveBeenCalled()
})
