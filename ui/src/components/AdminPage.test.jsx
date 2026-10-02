// Render tests for the read-only deploy-targets panel (HZ-41): it must show
// each target's repo/service/last-tag/last-result, and — this is the
// guardrail that matters — it must never render a button, form, or input,
// since a deploy target names a script and a service to restart and an
// editable target would be arbitrary code execution.
//
// Also the personal API tokens panel (HZ-179): the raw token is shown once and
// never persisted, and the list shows only the safe fields. And each repo
// row's webhook status plus the PIN-gated Fix webhook (HZ-244).

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
  setProjectEnabled: vi.fn(async () => ({ ok: true })),
  getRepoWebhooks: vi.fn(async () => ({ webhooks: [] })),
  fixRepoWebhook: vi.fn(async () => ({ ok: true })),
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
  api.getRepoWebhooks.mockReset()
  api.getRepoWebhooks.mockResolvedValue({ webhooks: [] })
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

// ---- HZ-208: the per-project enabled switch, gate-PIN protected ----

const PROJECTS = [
  { id: 1, name: 'Alpha', enabled: true, repos: [] },
  { id: 2, name: 'Gamma', enabled: false, repos: [] },
]

function projectBlock(container, name) {
  return [...container.querySelectorAll('.project-block')].find(
    (b) => b.querySelector('.project-block__name')?.textContent === name,
  )
}

test('Admin lists every project with its enabled state', () => {
  const { container } = render(<AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} />)
  const alpha = within(projectBlock(container, 'Alpha'))
  const gamma = within(projectBlock(container, 'Gamma'))
  expect(alpha.getByRole('switch', { name: 'Alpha enabled' }).getAttribute('aria-checked')).toBe('true')
  expect(alpha.getByText('Enabled')).toBeTruthy()
  expect(gamma.getByRole('switch', { name: 'Gamma enabled' }).getAttribute('aria-checked')).toBe('false')
  expect(gamma.getByText('Disabled')).toBeTruthy()
})

test('flipping asks for the PIN: none sends nothing, a wrong one leaves the state, a correct one calls setProjectEnabled once', async () => {
  const { container, rerender } = render(<AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} />)
  const gamma = within(projectBlock(container, 'Gamma'))
  fireEvent.click(gamma.getByRole('switch', { name: 'Gamma enabled' }))
  const pinInput = gamma.getByLabelText('Gate PIN to enable Gamma')
  expect(pinInput.getAttribute('type')).toBe('password')

  // Missing PIN: the confirm button is disabled and submitting does nothing.
  const confirm = gamma.getByRole('button', { name: 'Enable' })
  expect(confirm.disabled).toBe(true)
  fireEvent.submit(pinInput.closest('form'))
  expect(api.setProjectEnabled).not.toHaveBeenCalled()

  // Wrong PIN: the server refuses; the switch still shows Disabled.
  api.setProjectEnabled.mockRejectedValueOnce(Object.assign(new Error('human_gate_key_required'), { status: 401 }))
  fireEvent.change(pinInput, { target: { value: 'wrong-pin' } })
  fireEvent.click(confirm)
  await gamma.findByText('Gate PIN incorrect')
  expect(gamma.getByRole('switch', { name: 'Gamma enabled' }).getAttribute('aria-checked')).toBe('false')
  expect(gamma.getByLabelText('Gate PIN to enable Gamma').value).toBe('')

  // Correct PIN: exactly one call with the PIN; the state comes from the next snapshot.
  api.setProjectEnabled.mockClear()
  fireEvent.change(gamma.getByLabelText('Gate PIN to enable Gamma'), { target: { value: 'right-pin' } })
  fireEvent.click(gamma.getByRole('button', { name: 'Enable' }))
  await waitFor(() => expect(api.setProjectEnabled).toHaveBeenCalledTimes(1))
  expect(api.setProjectEnabled).toHaveBeenCalledWith(2, true, 'right-pin')
  await waitFor(() => expect(gamma.queryByLabelText('Gate PIN to enable Gamma')).toBeNull())
  rerender(<AdminPage sync={{}} projects={[PROJECTS[0], { ...PROJECTS[1], enabled: true }]} onBack={() => {}} />)
  expect(gamma.getByRole('switch', { name: 'Gamma enabled' }).getAttribute('aria-checked')).toBe('true')
  expect(Object.values({ ...localStorage })).not.toContain('right-pin')
})

test('disabling asks for the PIN too', async () => {
  const { container } = render(<AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} />)
  const alpha = within(projectBlock(container, 'Alpha'))
  fireEvent.click(alpha.getByRole('switch', { name: 'Alpha enabled' }))
  fireEvent.change(alpha.getByLabelText('Gate PIN to disable Alpha'), { target: { value: 'right-pin' } })
  fireEvent.click(alpha.getByRole('button', { name: 'Disable' }))
  await waitFor(() => expect(api.setProjectEnabled).toHaveBeenCalledWith(1, false, 'right-pin'))
})

// ---- HZ-244: each repo row's webhook status and the Fix webhook action ----

const REPO_PROJECT = [{ id: 7, name: 'Hooks', enabled: true, repos: [{ repo: 'FinTekkers/ui-service', prefix: 'UI' }] }]

function repoRow(container) {
  return within(container.querySelector('.repo-row'))
}

for (const [status, row, label, code] of [
  ['ok', { status: 'ok', lastResponseCode: 200, reason: null }, 'Webhook: ok', 'last delivery 200'],
  ['missing', { status: 'missing', lastResponseCode: null, reason: null }, 'Webhook: missing', 'no deliveries'],
  ['mismatched', { status: 'mismatched', lastResponseCode: 404, reason: null }, 'Webhook: mismatched', 'last delivery 404'],
  // A failed GitHub call arrives as a row, not a rejected list (the server
  // never 5xxs the whole list for one repo).
  ['error', { status: 'error', lastResponseCode: null, reason: 'github_error', httpStatus: 403 }, 'Webhook: error (GitHub 403)', 'no deliveries'],
]) {
  test(`a repo row shows webhook status ${status} and the last delivery's response code`, async () => {
    api.getRepoWebhooks.mockResolvedValue({ webhooks: [{ repo: 'FinTekkers/ui-service', ...row }] })
    const { container } = render(<AdminPage sync={{}} projects={REPO_PROJECT} onBack={() => {}} />)
    const scoped = repoRow(container)
    expect(await scoped.findByText(label)).toBeTruthy()
    expect(scoped.getByText(code)).toBeTruthy()
    expect(api.getRepoWebhooks).toHaveBeenCalledWith(7)
    const fixShown = !!within(projectBlock(container, 'Hooks')).queryByText('Fix webhook')
    expect(fixShown).toBe(status === 'missing' || status === 'mismatched')
  })
}

test('a mismatched hook on another host is labelled so', async () => {
  api.getRepoWebhooks.mockResolvedValue({
    webhooks: [{ repo: 'FinTekkers/ui-service', status: 'mismatched', lastResponseCode: 200, reason: 'foreign_url' }],
  })
  const { container } = render(<AdminPage sync={{}} projects={REPO_PROJECT} onBack={() => {}} />)
  expect(await repoRow(container).findByText('Webhook: mismatched (other host)')).toBeTruthy()
})

test('Fix webhook asks for the PIN: none sends nothing, a wrong one shows Gate PIN incorrect, a right one fixes and re-reads status', async () => {
  api.getRepoWebhooks.mockResolvedValue({
    webhooks: [{ repo: 'FinTekkers/ui-service', status: 'missing', lastResponseCode: null, reason: null }],
  })
  const { container } = render(<AdminPage sync={{}} projects={REPO_PROJECT} onBack={() => {}} />)
  const block = within(projectBlock(container, 'Hooks'))
  fireEvent.click(await block.findByText('Fix webhook'))
  const pinInput = block.getByLabelText('Gate PIN to fix the FinTekkers/ui-service webhook')
  expect(pinInput.getAttribute('type')).toBe('password')

  const confirm = block.getByRole('button', { name: 'Fix' })
  expect(confirm.disabled).toBe(true)
  fireEvent.submit(pinInput.closest('form'))
  expect(api.fixRepoWebhook).not.toHaveBeenCalled()

  api.fixRepoWebhook.mockRejectedValueOnce(Object.assign(new Error('human_gate_key_required'), { status: 401 }))
  fireEvent.change(pinInput, { target: { value: 'wrong-pin' } })
  fireEvent.click(confirm)
  await block.findByText('Gate PIN incorrect')
  expect(block.getByLabelText('Gate PIN to fix the FinTekkers/ui-service webhook').value).toBe('')

  api.fixRepoWebhook.mockClear()
  api.getRepoWebhooks.mockClear()
  api.getRepoWebhooks.mockResolvedValue({
    webhooks: [{ repo: 'FinTekkers/ui-service', status: 'ok', lastResponseCode: null, reason: null }],
  })
  fireEvent.change(block.getByLabelText('Gate PIN to fix the FinTekkers/ui-service webhook'), { target: { value: 'right-pin' } })
  fireEvent.click(block.getByRole('button', { name: 'Fix' }))
  await waitFor(() => expect(api.fixRepoWebhook).toHaveBeenCalledTimes(1))
  expect(api.fixRepoWebhook).toHaveBeenCalledWith(7, 'FinTekkers/ui-service', 'right-pin')
  await block.findByText('Webhook: ok')
  expect(api.getRepoWebhooks).toHaveBeenCalledTimes(1)
  expect(block.queryByText('Fix webhook')).toBeNull()
  expect(Object.values({ ...localStorage })).not.toContain('right-pin')
})
