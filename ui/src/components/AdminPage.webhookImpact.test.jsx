// HZ-303: a missing or mismatched webhook row says in plain words what that
// breaks for the repo — releases for a repo with a deploy target, only a sync
// delay for one without — and Fix webhook says what it does. Every string is
// imported from domain/webhookImpact.js, never copied here.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, within, fireEvent, waitFor } from '@testing-library/react'
import * as api from '../api'
import { WEBHOOK_IMPACT } from '../domain/webhookImpact'

const TARGETS = [
  {
    key: 'ui-service',
    repo: 'FinTekkers/ui-service',
    service: 'fintekkers-ui',
    lastTag: null,
    lastCommit: null,
    lastResult: 'never',
    lastAt: null,
  },
]

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
  fixRepoWebhook: vi.fn(async () => ({ ok: true })),
  dryRunDeployTarget: vi.fn(),
  // HZ-327: the Flaky tests panel's read.
  getCheckFlakes: vi.fn(async () => ({ repos: [] })),
  getDeployTargets: vi.fn(),
}))

import AdminPage from './AdminPage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  api.getRepoWebhooks.mockReset()
  api.getRepoWebhooks.mockResolvedValue({ webhooks: [] })
  api.getDeployTargets.mockReset()
  localStorage.clear()
  sessionStorage.clear()
})

const ALL = Object.values(WEBHOOK_IMPACT)
const { RELEASES_BLOCKED, SYNC_CONTINUES, SYNC_DELAY_ONLY, FIX_HINT } = WEBHOOK_IMPACT

// Fake hook details: none may ever surface in the new text.
const HOOK_ID = 987654321
const HOOK_URL = 'https://hooks.example.test/secret-path'

function hook(repo, status) {
  return { repo, status, lastResponseCode: null, reason: null, id: HOOK_ID, url: HOOK_URL }
}

function projectBlock(container, name) {
  return [...container.querySelectorAll('.project-block')].find(
    (b) => b.querySelector('.project-block__name')?.textContent === name,
  )
}

// The impact note sits right after its repo's row.
function impactAfterRow(container, repo) {
  const row = [...container.querySelectorAll('.repo-row')].find(
    (r) => r.querySelector('.repo-row__name')?.textContent === repo,
  )
  const next = row?.nextElementSibling
  return next?.classList.contains('repo-webhook__impact') ? next : null
}

function renderWith({ repos, webhooks, targets = TARGETS }) {
  if (targets instanceof Error) api.getDeployTargets.mockRejectedValue(targets)
  else api.getDeployTargets.mockResolvedValue({ targets })
  api.getRepoWebhooks.mockResolvedValue({ webhooks })
  const projects = [{ id: 7, name: 'Hooks', enabled: true, repos: repos.map((repo, i) => ({ repo, prefix: `P${i}` })) }]
  return render(<AdminPage sync={{}} projects={projects} onBack={() => {}} />)
}

for (const status of ['missing', 'mismatched']) {
  test(`a ${status} webhook on a repo with a deploy target says releases will not deploy, and sync continues`, async () => {
    const { container } = renderWith({ repos: ['FinTekkers/ui-service'], webhooks: [hook('FinTekkers/ui-service', status)] })
    const block = within(projectBlock(container, 'Hooks'))
    expect(await block.findByText(RELEASES_BLOCKED)).toBeTruthy()
    expect(block.getByText(SYNC_CONTINUES)).toBeTruthy()
    expect(block.queryByText(SYNC_DELAY_ONLY)).toBeNull()

    const note = impactAfterRow(container, 'FinTekkers/ui-service')
    expect(note.textContent).toContain(RELEASES_BLOCKED)
    expect(note.textContent).not.toContain(String(HOOK_ID))
    expect(note.textContent).not.toContain(HOOK_URL)
    const hint = block.getByText(FIX_HINT)
    expect(hint.textContent).not.toContain(String(HOOK_ID))
    expect(hint.textContent).not.toContain(HOOK_URL)
  })
}

test('a missing webhook on a repo with no deploy target says only GitHub changes are delayed', async () => {
  const { container } = renderWith({ repos: ['acme/web'], webhooks: [hook('acme/web', 'missing')] })
  const block = within(projectBlock(container, 'Hooks'))
  expect(await block.findByText(SYNC_DELAY_ONLY)).toBeTruthy()
  expect(block.queryByText(RELEASES_BLOCKED)).toBeNull()
  expect(block.queryByText(SYNC_CONTINUES)).toBeNull()
})

test('in one project, each repo row carries its own impact text', async () => {
  const { container } = renderWith({
    repos: ['FinTekkers/ui-service', 'acme/web'],
    webhooks: [hook('FinTekkers/ui-service', 'missing'), hook('acme/web', 'missing')],
  })
  const block = within(projectBlock(container, 'Hooks'))
  await block.findByText(RELEASES_BLOCKED)
  await block.findByText(SYNC_DELAY_ONLY)

  const target = impactAfterRow(container, 'FinTekkers/ui-service')
  const plain = impactAfterRow(container, 'acme/web')
  expect(within(target).getByText(RELEASES_BLOCKED)).toBeTruthy()
  expect(within(target).getByText(SYNC_CONTINUES)).toBeTruthy()
  expect(within(target).queryByText(SYNC_DELAY_ONLY)).toBeNull()
  expect(within(plain).getByText(SYNC_DELAY_ONLY)).toBeTruthy()
  expect(within(plain).queryByText(RELEASES_BLOCKED)).toBeNull()
  expect(block.getAllByText(RELEASES_BLOCKED)).toHaveLength(1)
  expect(block.getAllByText(SYNC_DELAY_ONLY)).toHaveLength(1)
})

test('Fix webhook says what it does, before and after the PIN form opens', async () => {
  const { container } = renderWith({ repos: ['FinTekkers/ui-service'], webhooks: [hook('FinTekkers/ui-service', 'missing')] })
  const block = within(projectBlock(container, 'Hooks'))
  const button = await block.findByRole('button', { name: 'Fix webhook' })
  expect(block.getByText(FIX_HINT)).toBeTruthy()
  fireEvent.click(button)
  expect(block.getByLabelText('Gate PIN to fix the FinTekkers/ui-service webhook')).toBeTruthy()
  expect(block.getByText(FIX_HINT)).toBeTruthy()
})

test('an ok webhook row shows none of the impact text', async () => {
  const { container } = renderWith({ repos: ['FinTekkers/ui-service'], webhooks: [hook('FinTekkers/ui-service', 'ok')] })
  const block = within(projectBlock(container, 'Hooks'))
  await block.findByText('Webhook: ok')
  await waitFor(() => expect(api.getDeployTargets).toHaveBeenCalled())
  // Let the targets settle so the check does not pass only because they are loading.
  await within(container).findByText('FinTekkers/ui-service', { selector: '.deploy-target-row__repo' })
  for (const text of ALL) expect(block.queryByText(text)).toBeNull()
})

test('fixing the webhook with the PIN clears all the impact text once it reads ok', async () => {
  const { container } = renderWith({ repos: ['FinTekkers/ui-service'], webhooks: [hook('FinTekkers/ui-service', 'missing')] })
  const block = within(projectBlock(container, 'Hooks'))
  await block.findByText(RELEASES_BLOCKED)
  fireEvent.click(block.getByRole('button', { name: 'Fix webhook' }))
  api.getRepoWebhooks.mockResolvedValue({ webhooks: [hook('FinTekkers/ui-service', 'ok')] })
  fireEvent.change(block.getByLabelText('Gate PIN to fix the FinTekkers/ui-service webhook'), { target: { value: 'right-pin' } })
  fireEvent.click(block.getByRole('button', { name: 'Fix' }))
  await block.findByText('Webhook: ok')
  expect(api.fixRepoWebhook).toHaveBeenCalledWith(7, 'FinTekkers/ui-service', 'right-pin')
  for (const text of ALL) expect(block.queryByText(text)).toBeNull()
})

test('when deploy targets fail to load, a missing row shows only the sync line and the panel shows its error', async () => {
  const { container } = renderWith({
    repos: ['FinTekkers/ui-service'],
    webhooks: [hook('FinTekkers/ui-service', 'missing')],
    targets: new Error('deploy targets unavailable'),
  })
  expect(await within(container).findByText('deploy targets unavailable')).toBeTruthy()
  const block = within(projectBlock(container, 'Hooks'))
  expect(await block.findByText(SYNC_CONTINUES)).toBeTruthy()
  expect(block.queryByText(RELEASES_BLOCKED)).toBeNull()
  expect(block.queryByText(SYNC_DELAY_ONLY)).toBeNull()
})
