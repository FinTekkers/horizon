// Render tests for the read-only deploy-targets panel (HZ-41): it must show
// each target's repo/service/last-tag/last-result, and — this is the
// guardrail that matters — it must never render a form or a field that edits
// a target, since a deploy target names a script and a service to restart and
// an editable target would be arbitrary code execution. Its only controls are
// the PIN-gated, read-only Dry run (HZ-258).
//
// Also the personal API tokens panel (HZ-179): the raw token is shown once and
// never persisted, and the list shows only the safe fields. And each repo
// row's webhook status plus the PIN-gated Fix webhook (HZ-244), and each
// repo's PIN-gated check commands (HZ-245).

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, within, fireEvent, waitFor } from '@testing-library/react'
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
  setProjectStepProvider: vi.fn(async () => ({ ok: true })),
  saveRepoChecks: vi.fn(),
  getRepoCheckDefaults: vi.fn(async () => ({
    available: true,
    defaults: { install: 'npm install --no-audit --no-fund', test: 'npm test --silent · python -m pytest -q', lint: null, e2e: null },
  })),
  getRepoWebhooks: vi.fn(async () => ({ webhooks: [] })),
  fixRepoWebhook: vi.fn(async () => ({ ok: true })),
  dryRunDeployTarget: vi.fn(),
  // HZ-327: the Flaky tests panel's read.
  getCheckFlakes: vi.fn(async () => ({ repos: [] })),
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
  const { findByText, container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'deploys' }} />)
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

test('the deploy-targets panel has no form or target field — only Dry run and Run (read-only guardrail)', async () => {
  const { findByText, container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'deploys' }} />)
  await findByText('FinTekkers/horizon')

  const panel = findDeployTargetsPanel(container)
  const scoped = within(panel)
  expect(panel.querySelectorAll('form, textarea, select').length).toBe(0)
  expect(panel.querySelectorAll('input').length).toBe(0)
  const toggles = scoped.getAllByRole('button')
  expect(toggles.map((b) => b.textContent)).toEqual(['▸ Dry run', '▸ Dry run'])

  for (const toggle of toggles) fireEvent.click(toggle)
  expect(panel.querySelectorAll('input').length).toBe(0)
  expect(scoped.getAllByRole('button').map((b) => b.textContent)).toEqual(['▾ Dry run', 'Run', '▾ Dry run', 'Run'])
  for (const field of [/^script/i, /^service/i, /^health/i, /^repo dir/i]) expect(scoped.queryByLabelText(field)).toBeNull()
  expect(panel.querySelectorAll('form, textarea, select').length).toBe(0)
})

test('Dry run shows all five checks, each with pass/fail and its reason', async () => {
  const results = [
    { check: 'script', pass: true, reason: 'script found in infra/host and executable' },
    { check: 'repo dir', pass: true, reason: 'git work tree, origin is FinTekkers/horizon' },
    { check: 'service', pass: false, reason: 'service horizon-server is not active (exit 3)' },
    { check: 'sudo', pass: true, reason: 'sudo -n allows restarting horizon-server' },
    { check: 'health', pass: false, reason: 'health timed out after 5000ms' },
  ]
  api.dryRunDeployTarget.mockResolvedValueOnce({ key: 'horizon', ranAt: '2026-10-03T12:00:00.000Z', results })
  const { findByText, container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'deploys' }} />)
  await findByText('FinTekkers/horizon')
  const panel = within(findDeployTargetsPanel(container))

  fireEvent.click(panel.getAllByRole('button', { name: /Dry run/ })[0])
  fireEvent.click(panel.getByRole('button', { name: 'Run' }))

  const list = await panel.findByRole('list', { name: 'Dry run results for FinTekkers/horizon' })
  expect(api.dryRunDeployTarget).toHaveBeenCalledWith('horizon')
  const items = within(list).getAllByRole('listitem')
  expect(items).toHaveLength(5)
  items.forEach((item, i) => {
    expect(item.textContent).toContain(results[i].check)
    expect(within(item).getByText(results[i].pass ? 'pass' : 'fail')).toBeTruthy()
    expect(within(item).getByText(results[i].reason)).toBeTruthy()
  })
})

test('a cancelled PIN prompt on Dry run says so and shows no results', async () => {
  api.dryRunDeployTarget.mockRejectedValueOnce(Object.assign(new Error('pin_needed')))
  const { findByText, container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'deploys' }} />)
  await findByText('FinTekkers/horizon')
  const panel = within(findDeployTargetsPanel(container))

  fireEvent.click(panel.getAllByRole('button', { name: /Dry run/ })[0])
  fireEvent.click(panel.getByRole('button', { name: 'Run' }))

  await panel.findByText('Gate PIN needed — nothing was run')
  expect(panel.queryByRole('list')).toBeNull()
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
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'account' }} />)
  const days = within(findTokensPanel(container)).getByLabelText('Expires in days')
  expect(days.value).toBe('90')
  expect(days.getAttribute('max')).toBe('365')
  expect(days.getAttribute('min')).toBe('1')
})

test('creating a token shows the raw value once; after Done only last4 remains, and nothing is stored', async () => {
  api.createApiToken.mockResolvedValueOnce({ ...LISTED, token: RAW_TOKEN })
  api.listApiTokens.mockResolvedValueOnce({ tokens: [] }).mockResolvedValue({ tokens: [LISTED] })
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'account' }} />)
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
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'account' }} />)
  const panel = within(findTokensPanel(container))
  fireEvent.change(panel.getByPlaceholderText(/Token name/), { target: { value: 'ci-bot' } })
  fireEvent.change(panel.getByLabelText('Expires in days'), { target: { value: '366' } })
  fireEvent.click(panel.getByText('Create token'))
  await panel.findByText(/from 1 to 365/)
  expect(api.createApiToken).not.toHaveBeenCalled()
})

// HZ-319: the expiry reads "Expires in [90 days]", with a "1 to 365 days" hint below.
test('the expiry shows a visible "days" unit, not only a title or aria-label', () => {
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'account' }} />)
  const unit = within(findTokensPanel(container)).getByText('days', { exact: true })
  expect(unit.tagName).not.toBe('INPUT')
  expect(unit.textContent).toBe('days')
})

test('exactly one control on the page is labelled with days: the number input', () => {
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'account' }} />)
  const matches = within(container).getAllByLabelText(/days/i)
  expect(matches).toHaveLength(1)
  expect(matches[0].id).toBe('api-token-days')
  expect(matches[0].getAttribute('type')).toBe('number')
})

test('a visible "Expires in" label precedes the input, and "days" sits in the same bordered field', () => {
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'account' }} />)
  const panel = within(findTokensPanel(container))
  const label = panel.getByText('Expires in')
  const input = container.querySelector('#api-token-days')
  expect(label.tagName).toBe('LABEL')
  expect(label.getAttribute('for')).toBe('api-token-days')
  expect(label.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const field = input.closest('.api-tokens__days-field')
  expect(field).not.toBeNull()
  expect(field.contains(panel.getByText('days', { exact: true }))).toBe(true)
})

test('the hint "1 to 365 days" is shown below the row and describes the input', () => {
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'account' }} />)
  const panel = within(findTokensPanel(container))
  const hint = panel.getByText('1 to 365 days')
  expect(hint.tagName).not.toBe('LABEL')
  const row = container.querySelector('.api-tokens__form')
  expect(row.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(row.contains(hint)).toBe(false)
  expect(container.querySelector('#api-token-days').getAttribute('aria-describedby')).toBe(hint.id)
  expect(panel.queryByText(/Expires on/)).toBeNull()
})

test('creating a token with the expiry untouched sends the default 90 as a number', async () => {
  api.createApiToken.mockResolvedValueOnce({ ...LISTED, token: RAW_TOKEN })
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'account' }} />)
  const panel = within(findTokensPanel(container))
  fireEvent.change(panel.getByPlaceholderText(/Token name/), { target: { value: 'ci-bot' } })
  fireEvent.click(panel.getByText('Create token'))
  await panel.findByText(RAW_TOKEN)
  expect(api.createApiToken).toHaveBeenCalledWith({ name: 'ci-bot', expiresInDays: 90 })
  expect(typeof api.createApiToken.mock.calls[0][0].expiresInDays).toBe('number')
})

test('Revoke asks for confirmation, then revokes and drops the row', async () => {
  api.listApiTokens.mockResolvedValueOnce({ tokens: [LISTED] }).mockResolvedValue({ tokens: [] })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'account' }} />)
  const panel = within(findTokensPanel(container))
  fireEvent.click(await panel.findByText('Revoke'))
  await waitFor(() => expect(api.revokeApiToken).toHaveBeenCalledWith('tok_1'))
  await panel.findByText('No active tokens.')
})

test('cancelling the Revoke confirmation revokes nothing', async () => {
  api.listApiTokens.mockResolvedValue({ tokens: [LISTED] })
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  const { container } = render(<AdminPage sync={{}} projects={[]} onBack={() => {}} route={{ section: 'account' }} />)
  const panel = within(findTokensPanel(container))
  fireEvent.click(await panel.findByText('Revoke'))
  expect(api.revokeApiToken).not.toHaveBeenCalled()
})

// ---- HZ-208: the per-project enabled switch, gate-PIN protected ----

const PROJECTS = [
  { id: 1, name: 'Alpha', enabled: true, repos: [] },
  { id: 2, name: 'Gamma', enabled: false, repos: [] },
]

// HZ-764: one project, or one repository, at a time — each test opens the page
// that holds the control it checks.
const settingsTab = (id) => ({ section: 'projects', project: String(id), tab: 'settings' })
const repoPage = (id, repo) => ({ section: 'projects', project: String(id), tab: 'repositories', repo })

function projectBlock(container, name) {
  return [...container.querySelectorAll('.project-block')].find(
    (b) => b.querySelector('.project-block__name')?.textContent === name,
  )
}

test('Admin lists every project with its enabled state', () => {
  const { container, rerender } = render(<AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} route={settingsTab(1)} />)
  const alpha = within(projectBlock(container, 'Alpha'))
  expect(alpha.getByRole('switch', { name: 'Alpha enabled' }).getAttribute('aria-checked')).toBe('true')
  expect(alpha.getByText('Enabled')).toBeTruthy()
  rerender(<AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} route={settingsTab(2)} />)
  const gamma = within(projectBlock(container, 'Gamma'))
  expect(gamma.getByRole('switch', { name: 'Gamma enabled' }).getAttribute('aria-checked')).toBe('false')
  expect(gamma.getByText('Disabled')).toBeTruthy()
})

test('flipping asks to confirm: a cancelled PIN prompt leaves the state, a confirmed one calls setProjectEnabled once', async () => {
  const { container, rerender } = render(<AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} route={settingsTab(2)} />)
  const gamma = within(projectBlock(container, 'Gamma'))
  fireEvent.click(gamma.getByRole('switch', { name: 'Gamma enabled' }))
  expect(gamma.queryByLabelText('Gate PIN to enable Gamma')).toBeNull()
  expect(api.setProjectEnabled).not.toHaveBeenCalled()

  // Cancelled PIN prompt: nothing saved; the switch still shows Disabled.
  const confirm = gamma.getByRole('button', { name: 'Enable' })
  expect(confirm.disabled).toBe(false)
  api.setProjectEnabled.mockRejectedValueOnce(Object.assign(new Error('pin_needed')))
  fireEvent.click(confirm)
  await gamma.findByText('Gate PIN needed — nothing was saved')
  expect(gamma.getByRole('switch', { name: 'Gamma enabled' }).getAttribute('aria-checked')).toBe('false')

  // Confirmed: exactly one call; the state comes from the next snapshot.
  api.setProjectEnabled.mockClear()
  fireEvent.click(gamma.getByRole('button', { name: 'Enable' }))
  await waitFor(() => expect(api.setProjectEnabled).toHaveBeenCalledTimes(1))
  expect(api.setProjectEnabled).toHaveBeenCalledWith(2, true)
  await waitFor(() => expect(gamma.queryByRole('button', { name: 'Enable' })).toBeNull())
  rerender(
    <AdminPage sync={{}} projects={[PROJECTS[0], { ...PROJECTS[1], enabled: true }]} onBack={() => {}} route={settingsTab(2)} />,
  )
  expect(gamma.getByRole('switch', { name: 'Gamma enabled' }).getAttribute('aria-checked')).toBe('true')
})

test('disabling asks to confirm too', async () => {
  const { container } = render(<AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} route={settingsTab(1)} />)
  const alpha = within(projectBlock(container, 'Alpha'))
  fireEvent.click(alpha.getByRole('switch', { name: 'Alpha enabled' }))
  fireEvent.click(alpha.getByRole('button', { name: 'Disable' }))
  await waitFor(() => expect(api.setProjectEnabled).toHaveBeenCalledWith(1, false))
})

// ---- HZ-245: per-repo check commands, gate-PIN protected ----

const CHECK_PROJECTS = [
  {
    id: 3,
    name: 'Fin',
    enabled: true,
    repos: [
      { repo: 'acme/web', prefix: 'AW', checks: { install: 'npm install --ignore-scripts', test: 'npm test', lint: null, e2e: null } },
      { repo: 'acme/api', prefix: 'AA', checks: { install: null, test: null, lint: null, e2e: null } },
    ],
  },
]

test('check commands show the saved values, and detected defaults as placeholders — fetched only on open', async () => {
  const page = (repo) => <AdminPage sync={{}} projects={CHECK_PROJECTS} onBack={() => {}} route={repoPage(3, repo)} />
  const { container, rerender } = render(page('acme/web'))
  const fin = within(projectBlock(container, 'Fin'))
  expect(api.getRepoCheckDefaults).not.toHaveBeenCalled()

  fireEvent.click(fin.getByRole('button', { name: /Check commands/ }))
  expect(fin.getByLabelText('Install command for acme/web').value).toBe('npm install --ignore-scripts')
  expect(fin.getByLabelText('Test command for acme/web').value).toBe('npm test')
  expect(fin.getByLabelText('Lint command for acme/web').value).toBe('')
  expect(fin.getByLabelText('E2E command for acme/web').value).toBe('')
  expect(api.getRepoCheckDefaults).toHaveBeenCalledWith(3, 'acme/web')

  rerender(page('acme/api'))
  fireEvent.click(fin.getByRole('button', { name: /Check commands/ }))
  expect(api.getRepoCheckDefaults).toHaveBeenCalledWith(3, 'acme/api')
  await waitFor(() =>
    expect(fin.getByLabelText('Install command for acme/api').placeholder).toBe('npm install --no-audit --no-fund'),
  )
  expect(fin.getByLabelText('Test command for acme/api').placeholder).toBe('npm test --silent · python -m pytest -q')
  expect(fin.getByLabelText('Lint command for acme/api').placeholder).toBe('')
  expect(fin.getByLabelText('Install command for acme/api').value).toBe('')
})

test('saving check commands sends the edited slots', async () => {
  const { container } = render(<AdminPage sync={{}} projects={CHECK_PROJECTS} onBack={() => {}} route={repoPage(3, 'acme/web')} />)
  const fin = within(projectBlock(container, 'Fin'))
  fireEvent.click(fin.getAllByRole('button', { name: /Check commands/ })[0])
  fireEvent.change(fin.getByLabelText('Lint command for acme/web'), { target: { value: 'npm run lint' } })

  expect(fin.queryByLabelText('Gate PIN to save check commands for acme/web')).toBeNull()
  const save = fin.getByRole('button', { name: 'Save commands' })
  expect(save.disabled).toBe(false)
  expect(api.saveRepoChecks).not.toHaveBeenCalled()

  // Cancelled PIN prompt: an error, and the typed values stay.
  api.saveRepoChecks.mockRejectedValueOnce(Object.assign(new Error('pin_needed')))
  fireEvent.click(save)
  await fin.findByText('Gate PIN needed — nothing was saved')
  expect(fin.getByLabelText('Lint command for acme/web').value).toBe('npm run lint')
  expect(fin.queryByText('Check commands saved.')).toBeNull()

  api.saveRepoChecks.mockResolvedValueOnce({
    ok: true,
    repo: 'acme/web',
    checks: { install: 'npm install --ignore-scripts', test: 'npm test', lint: 'npm run lint', e2e: null, screenshots: null },
  })
  fireEvent.click(fin.getByRole('button', { name: 'Save commands' }))
  await fin.findByText('Check commands saved.')
  expect(api.saveRepoChecks).toHaveBeenLastCalledWith(
    3,
    'acme/web',
    { install: 'npm install --ignore-scripts', test: 'npm test', lint: 'npm run lint', e2e: '', screenshots: '' },
    [],
  )
})

// ---- HZ-750: opting a test slot into a fix round's targeted run ----

const TARGETED = 'On a fix round, re-run only the failed tests first'

test('the targeted-run box is disabled while its slot has no command, and is sent once ticked', async () => {
  api.saveRepoChecks.mockResolvedValueOnce({
    ok: true,
    repo: 'acme/web',
    checks: { install: 'npm install --ignore-scripts', test: 'npm test', lint: null, e2e: 'npm run e2e', screenshots: null },
    targeted: ['e2e'],
  })
  const { container } = render(<AdminPage sync={{}} projects={CHECK_PROJECTS} onBack={() => {}} route={repoPage(3, 'acme/web')} />)
  const fin = within(projectBlock(container, 'Fin'))
  fireEvent.click(fin.getAllByRole('button', { name: /Check commands/ })[0])
  const e2eBox = fin.getByLabelText(`E2E: ${TARGETED} (acme/web)`)
  expect(e2eBox.disabled).toBe(true)
  expect(fin.getByLabelText(`Test: ${TARGETED} (acme/web)`).disabled).toBe(false)
  expect(fin.queryByLabelText(`Lint: ${TARGETED} (acme/web)`)).toBeNull()

  fireEvent.change(fin.getByLabelText('E2E command for acme/web'), { target: { value: 'npm run e2e' } })
  expect(e2eBox.disabled).toBe(false)
  fireEvent.click(e2eBox)
  expect(e2eBox.checked).toBe(true)
  fireEvent.click(fin.getByRole('button', { name: 'Save commands' }))
  await fin.findByText('Check commands saved.')
  expect(api.saveRepoChecks).toHaveBeenLastCalledWith(
    3,
    'acme/web',
    { install: 'npm install --ignore-scripts', test: 'npm test', lint: '', e2e: 'npm run e2e', screenshots: '' },
    ['e2e'],
  )
  expect(fin.getByLabelText(`E2E: ${TARGETED} (acme/web)`).checked).toBe(true)
})

test('a saved opt-in shows ticked from the snapshot', () => {
  const projects = [{ ...CHECK_PROJECTS[0], repos: [{ ...CHECK_PROJECTS[0].repos[0], targeted: ['test'] }] }]
  const { container } = render(<AdminPage sync={{}} projects={projects} onBack={() => {}} route={repoPage(3, 'acme/web')} />)
  const fin = within(projectBlock(container, 'Fin'))
  fireEvent.click(fin.getByRole('button', { name: /Check commands/ }))
  expect(fin.getByLabelText(`Test: ${TARGETED} (acme/web)`).checked).toBe(true)
  expect(fin.getByLabelText(`E2E: ${TARGETED} (acme/web)`).checked).toBe(false)
})

// ---- HZ-505: the screenshots slot ----

test('the Screenshots slot is a fifth command box, saved like the others', async () => {
  api.saveRepoChecks.mockResolvedValueOnce({ ok: true, repo: 'acme/web', checks: {} })
  const { container } = render(<AdminPage sync={{}} projects={CHECK_PROJECTS} onBack={() => {}} route={repoPage(3, 'acme/web')} />)
  const fin = within(projectBlock(container, 'Fin'))
  fireEvent.click(fin.getAllByRole('button', { name: /Check commands/ })[0])
  fireEvent.change(fin.getByLabelText('Screenshots command for acme/web'), { target: { value: 'node scripts/shots.mjs' } })
  fireEvent.click(fin.getByRole('button', { name: 'Save commands' }))
  await fin.findByText('Check commands saved.')
  expect(api.saveRepoChecks).toHaveBeenLastCalledWith(
    3,
    'acme/web',
    { install: 'npm install --ignore-scripts', test: 'npm test', lint: '', e2e: '', screenshots: 'node scripts/shots.mjs' },
    [],
  )
})

test('a repo with only a Screenshots command still warns that it has no checks', () => {
  const projects = [
    {
      id: 3,
      name: 'Fin',
      enabled: true,
      repos: [
        { repo: 'acme/shots', prefix: 'AS', checks: { install: null, test: null, lint: null, e2e: null, screenshots: 'node shots.mjs' } },
        { repo: 'acme/web', prefix: 'AW', checks: { install: null, test: 'npm test', lint: null, e2e: null, screenshots: null } },
      ],
    },
  ]
  const page = (repo) => <AdminPage sync={{}} projects={projects} onBack={() => {}} route={repoPage(3, repo)} />
  const { container, rerender } = render(page('acme/shots'))
  const warnings = within(projectBlock(container, 'Fin')).getAllByText(
    'no checks configured: items in this repo will fail at implement',
  )
  expect(warnings).toHaveLength(1)
  expect(within(warnings[0].closest('.repo-marks')).getByLabelText('No checks for acme/shots')).toBeTruthy()
  rerender(page('acme/web'))
  expect(
    within(projectBlock(container, 'Fin')).queryAllByText('no checks configured: items in this repo will fail at implement'),
  ).toHaveLength(0)
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
    const { container } = render(
      <AdminPage sync={{}} projects={REPO_PROJECT} onBack={() => {}} route={repoPage(7, 'FinTekkers/ui-service')} />,
    )
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
  const { container } = render(
    <AdminPage sync={{}} projects={REPO_PROJECT} onBack={() => {}} route={repoPage(7, 'FinTekkers/ui-service')} />,
  )
  expect(await repoRow(container).findByText('Webhook: mismatched (other host)')).toBeTruthy()
})

test('Fix webhook asks to confirm: a cancelled PIN prompt says nothing was saved, a confirmed one fixes and re-reads status', async () => {
  api.getRepoWebhooks.mockResolvedValue({
    webhooks: [{ repo: 'FinTekkers/ui-service', status: 'missing', lastResponseCode: null, reason: null }],
  })
  const { container } = render(
    <AdminPage sync={{}} projects={REPO_PROJECT} onBack={() => {}} route={repoPage(7, 'FinTekkers/ui-service')} />,
  )
  const block = within(projectBlock(container, 'Hooks'))
  fireEvent.click(await block.findByText('Fix webhook'))
  expect(block.queryByLabelText('Gate PIN to fix the FinTekkers/ui-service webhook')).toBeNull()
  expect(api.fixRepoWebhook).not.toHaveBeenCalled()

  const confirm = block.getByRole('button', { name: 'Fix' })
  expect(confirm.disabled).toBe(false)
  api.fixRepoWebhook.mockRejectedValueOnce(Object.assign(new Error('pin_needed')))
  fireEvent.click(confirm)
  await block.findByText('Gate PIN needed — nothing was saved')

  api.fixRepoWebhook.mockClear()
  api.getRepoWebhooks.mockClear()
  api.getRepoWebhooks.mockResolvedValue({
    webhooks: [{ repo: 'FinTekkers/ui-service', status: 'ok', lastResponseCode: null, reason: null }],
  })
  fireEvent.click(block.getByRole('button', { name: 'Fix' }))
  await waitFor(() => expect(api.fixRepoWebhook).toHaveBeenCalledTimes(1))
  expect(api.fixRepoWebhook).toHaveBeenCalledWith(7, 'FinTekkers/ui-service')
  await block.findByText('Webhook: ok')
  expect(api.getRepoWebhooks).toHaveBeenCalledTimes(1)
  expect(block.queryByText('Fix webhook')).toBeNull()
})

// ---- HZ-413: a Task's steps 0-2 take a project default of their own ----

test('Admin shows one select per item kind for the shared first step, and a Task select saves to the Task row', async () => {
  const { STEPS, firstStepIndex } = await import('../../../domain/js/lifecycle.js')
  const shared = STEPS[0].label
  const { container } = render(<AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} route={settingsTab(1)} />)
  const alpha = within(projectBlock(container, 'Alpha'))
  const change = alpha.getByLabelText(`Alpha ${shared} Runs on`)
  const task = alpha.getByLabelText(`Alpha Task ${shared} Runs on`)
  expect(change).not.toBe(task)
  expect(alpha.getByText('Task steps')).toBeTruthy()
  for (const label of ["How we'll verify", 'Guardrails']) {
    expect(alpha.getByLabelText(`Alpha Task ${label} Runs on`)).toBeTruthy()
  }

  fireEvent.change(task, { target: { value: 'muse' } })
  fireEvent.click(alpha.getByRole('button', { name: 'Save' }))
  const taskOutcome = firstStepIndex('task')
  expect(STEPS[taskOutcome].label).toBe(shared)
  expect(STEPS[taskOutcome].itemKind).toBe('task')
  await waitFor(() => expect(api.setProjectStepProvider).toHaveBeenCalledWith(1, taskOutcome, 'muse'))
})

// ---- HZ-425: each connected repo shows its GitHub default branch ----

test('each repo row shows its default branch, or that it has not been read yet', () => {
  const projects = [
    {
      id: 1,
      name: 'Alpha',
      enabled: true,
      repos: [
        { repo: 'FinTekkers/price-service-rust', prefix: 'PSR', defaultBranch: 'master' },
        { repo: 'FinTekkers/fresh', prefix: 'FR', defaultBranch: null },
      ],
    },
  ]
  const route = { section: 'projects', project: '1' }
  const { container } = render(<AdminPage sync={{}} projects={projects} onBack={() => {}} route={route} />)
  const rows = [...container.querySelectorAll('.repo-row')]
  const rowOf = (repo) => within(rows.find((r) => r.textContent.includes(repo)))
  expect(rowOf('FinTekkers/price-service-rust').getByText('default branch: master')).toBeTruthy()
  expect(rowOf('FinTekkers/fresh').getByText('default branch: not read yet')).toBeTruthy()
})

// ---- HZ-564: "Find a setting" narrows the section list ----

// HZ-764: Needs attention, then one entry per project and New project.
const SECTION_LABELS = [
  'Needs attention',
  'Alpha',
  'Gamma',
  'New project',
  'Deploy targets',
  'Flaky tests',
  'Verify report',
  'GitHub access',
  'Your PIN and API tokens',
]

function sectionButtons(container) {
  const nav = within(container.querySelector('aside[aria-label="Admin sections"]'))
  return nav.queryAllByRole('button').map((b) => b.querySelector('.admin-nav__label').textContent)
}

test('Find a setting shows only the matching sections, and clearing it shows all of them again', () => {
  const { container, getByLabelText } = render(<AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} />)
  const search = getByLabelText('Find a setting')
  expect(sectionButtons(container)).toEqual(SECTION_LABELS)

  fireEvent.change(search, { target: { value: 'webhook' } })
  expect(sectionButtons(container)).toEqual(['Needs attention', 'Alpha', 'Gamma'])
  fireEvent.change(search, { target: { value: 'PIN' } })
  expect(sectionButtons(container)).toEqual(['Your PIN and API tokens'])

  fireEvent.change(search, { target: { value: '' } })
  expect(sectionButtons(container)).toEqual(SECTION_LABELS)
})

test('a search that matches nothing says "No setting matches" and lists no section', () => {
  const { container, getByLabelText, getByText } = render(<AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} />)
  fireEvent.change(getByLabelText('Find a setting'), { target: { value: 'zzz' } })
  expect(getByText('No setting matches')).toBeTruthy()
  expect(sectionButtons(container)).toEqual([])

  fireEvent.change(getByLabelText('Find a setting'), { target: { value: '' } })
  expect(sectionButtons(container)).toEqual(SECTION_LABELS)
})

test('a project or repository name finds its project, and clicking a section asks to navigate to its URL', () => {
  const onNavigate = vi.fn()
  const projects = [{ id: 1, name: 'Fintekkers', enabled: true, repos: [{ repo: 'FinTekkers/ui-service', prefix: 'US' }] }]
  const { container, getByLabelText, getByRole } = render(
    <AdminPage sync={{}} projects={projects} onBack={() => {}} onNavigate={onNavigate} />,
  )
  fireEvent.change(getByLabelText('Find a setting'), { target: { value: 'ui-service' } })
  expect(sectionButtons(container)).toEqual(['Fintekkers'])

  fireEvent.change(getByLabelText('Find a setting'), { target: { value: '' } })
  fireEvent.click(getByRole('button', { name: /^Deploy targets/ }))
  expect(onNavigate).toHaveBeenCalledWith('/admin/deploys')
})
