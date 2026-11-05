// HZ-764: Needs attention. Its rows come from three reads Admin already makes;
// HZ-657: a flake or deploy target counts only for a repo of the viewer's own
// projects. Each fix button calls the route the same control calls elsewhere —
// Fix webhook and Dry run — and the flaky row, which has no write route, only
// opens the Flaky tests list.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import * as api from '../../api'

vi.mock('../../api', () => ({
  getDeployTargets: vi.fn(),
  getCheckFlakes: vi.fn(),
  getRepoWebhooks: vi.fn(),
  fixRepoWebhook: vi.fn(async () => ({ ok: true })),
  dryRunDeployTarget: vi.fn(async () => ({ results: [] })),
  disconnectRepo: vi.fn(),
  saveRepoChecks: vi.fn(),
  saveRepoMarks: vi.fn(),
  setProjectEnabled: vi.fn(),
  setProjectAutopilot: vi.fn(),
  setProjectStepProvider: vi.fn(),
  createProject: vi.fn(),
  addRepoToProject: vi.fn(),
}))

import AdminPage from '../AdminPage'
import { attentionRows } from './NeedsAttention'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const PROJECTS = [
  { id: 1, name: 'Fintekkers', enabled: true, repos: [{ repo: 'FinTekkers/ui-service', prefix: 'US' }] },
  { id: 2, name: 'Acme', enabled: true, repos: [{ repo: 'acme/web', prefix: 'AW' }] },
]
const MISSING = { repo: 'FinTekkers/ui-service', status: 'missing', lastResponseCode: null, reason: null }
const FLAKES = { repos: [{ repo: 'acme/web', tests: [{ test: 'renders the cart' }, { test: 'logs in' }] }] }
const FAILED = { key: 'ui-service', repo: 'FinTekkers/ui-service', service: 'fintekkers-ui', lastResult: 'failed', lastTag: 'v9' }

// ---- the rows ----

test('a missing webhook, a flaky test and a failed deploy each make one row, saying what it affects', () => {
  const rows = attentionRows({
    projects: PROJECTS,
    webhooks: { 1: { webhooks: { 'FinTekkers/ui-service': MISSING }, error: null }, 2: { webhooks: {}, error: null } },
    flakes: FLAKES,
    targets: [FAILED, { ...FAILED, key: 'web', repo: 'acme/web', lastResult: 'ok' }],
  })
  expect(rows.map((r) => [r.kind, r.project.id, r.repo])).toEqual([
    ['webhook', 1, 'FinTekkers/ui-service'],
    ['flaky', 2, 'acme/web'],
    ['deploy', 1, 'FinTekkers/ui-service'],
  ])
  // A deploy target on the repo: the broken hook blocks releases.
  expect(rows[0].affects[0]).toMatch(/Releases will not deploy/)
  expect(rows[1].affects).toEqual(['2 tests fail and then pass on the same code.'])
  expect(rows[2].affects).toEqual(['The last deploy of ui-service (v9) failed, so it is not live.'])
})

test('HZ-657: a flake and a failed target for a repo outside the viewer’s projects make no row', () => {
  const rows = attentionRows({
    projects: PROJECTS,
    webhooks: {},
    flakes: { repos: [{ repo: 'someone/else', tests: [{ test: 'x' }] }] },
    targets: [{ ...FAILED, key: 'theirs', repo: 'someone/else' }],
  })
  expect(rows).toEqual([])
})

test('reads still loading or failed (null) make no row; an ok hook makes none, a legacy one does', () => {
  expect(attentionRows({ projects: PROJECTS, webhooks: {}, flakes: null, targets: null })).toEqual([])
  const legacy = { ...MISSING, status: 'ok', reason: 'legacy_events' }
  const rows = attentionRows({
    projects: PROJECTS,
    webhooks: { 1: { webhooks: { 'FinTekkers/ui-service': legacy } }, 2: { webhooks: { 'acme/web': { status: 'ok' } } } },
    flakes: { repos: [{ repo: 'acme/web', tests: [] }] },
    targets: [],
  })
  expect(rows.map((r) => r.kind)).toEqual(['webhook'])
})

// ---- the page and its fix buttons ----

function renderAttention({ webhooks = [MISSING], flakes = FLAKES, targets = [FAILED] } = {}) {
  api.getRepoWebhooks.mockImplementation(async (id) => ({ webhooks: id === 1 ? webhooks : [] }))
  api.getCheckFlakes.mockResolvedValue(flakes)
  api.getDeployTargets.mockResolvedValue({ targets })
  const onNavigate = vi.fn()
  render(<AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} route={{ section: 'attention' }} onNavigate={onNavigate} />)
  return onNavigate
}

const rowWith = async (name) => (await screen.findByRole('button', { name })).closest('li')
const WRITES = ['fixRepoWebhook', 'dryRunDeployTarget', 'disconnectRepo', 'saveRepoChecks', 'saveRepoMarks', 'setProjectEnabled']

test('Fix webhook calls fixRepoWebhook with the project id and repo, then re-reads that project’s hooks', async () => {
  renderAttention()
  const row = within(await rowWith('Fix webhook'))
  expect(row.getByText('Fintekkers')).toBeTruthy()
  fireEvent.click(row.getByRole('button', { name: 'Fix webhook' }))
  api.getRepoWebhooks.mockClear()
  api.getRepoWebhooks.mockResolvedValue({ webhooks: [{ ...MISSING, status: 'ok' }] })
  fireEvent.click(row.getByRole('button', { name: 'Fix' }))
  await waitFor(() => expect(api.fixRepoWebhook).toHaveBeenCalledWith(1, 'FinTekkers/ui-service'))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Fix webhook' })).toBeNull())
  expect(api.getRepoWebhooks).toHaveBeenCalledTimes(1)
  expect(api.getRepoWebhooks).toHaveBeenCalledWith(1)
})

test('Dry run calls dryRunDeployTarget with the target key', async () => {
  const onNavigate = renderAttention()
  const row = within(await rowWith('Dry run'))
  fireEvent.click(row.getByRole('button', { name: 'Dry run' }))
  await waitFor(() => expect(api.dryRunDeployTarget).toHaveBeenCalledWith('ui-service'))
  fireEvent.click(row.getByRole('button', { name: 'Open deploy targets' }))
  expect(onNavigate).toHaveBeenCalledWith('/admin/deploys')
})

test('Open flaky tests goes to /admin/flaky and makes no write', async () => {
  const onNavigate = renderAttention()
  const row = within(await rowWith('Open flaky tests'))
  fireEvent.click(row.getByRole('button', { name: 'Open flaky tests' }))
  expect(onNavigate).toHaveBeenCalledWith('/admin/flaky')
  for (const write of WRITES) expect(api[write]).not.toHaveBeenCalled()
})

test('each row links to its repository page, and the nav badge counts the rows', async () => {
  const onNavigate = renderAttention()
  const row = within(await rowWith('Open flaky tests'))
  fireEvent.click(row.getByRole('button', { name: 'acme/web' }))
  expect(onNavigate).toHaveBeenCalledWith('/admin/projects/2/repos/acme/web')
  await screen.findByRole('button', { name: 'Fix webhook' })
  await screen.findByRole('button', { name: 'Dry run' })
  expect(screen.getByRole('button', { name: /^Needs attention/ }).textContent).toBe('Needs attention3')
})

test('with nothing broken the page says so', async () => {
  renderAttention({ webhooks: [{ ...MISSING, status: 'ok' }], flakes: { repos: [] }, targets: [] })
  expect(await screen.findByText('Nothing needs attention.')).toBeTruthy()
  expect(screen.queryByRole('list', { name: 'Needs attention' })).toBeNull()
})
