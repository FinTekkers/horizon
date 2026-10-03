// HZ-259: the Deploy target overrides panel. One row per repo connected to an
// enabled project, joined to its deploy_target row or "none"; create, edit and
// delete each ask for the gate PIN before any request; errors in plain words;
// and a new target shows up in the Deploy targets panel with its Dry run.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, within, fireEvent, waitFor } from '@testing-library/react'
import * as api from '../api'

const HORIZON = {
  key: 'horizon',
  repo: 'FinTekkers/horizon',
  script: 'deploy-horizon.sh',
  service: 'horizon-server',
  repoDir: '/opt/horizon',
  stateKey: 'horizon',
  healthUrl: 'http://127.0.0.1:3001/api/health',
  healthCheckType: 'json-health',
  extraServices: ['horizon-farm'],
}

vi.mock('../api', () => ({
  getDeployTargetConfig: vi.fn(),
  createDeployTarget: vi.fn(),
  updateDeployTarget: vi.fn(),
  deleteDeployTarget: vi.fn(),
  getDeployTargets: vi.fn(),
  dryRunDeployTarget: vi.fn(),
  saveToken: vi.fn(),
  createProject: vi.fn(),
  addRepoToProject: vi.fn(),
  disconnectRepo: vi.fn(),
  regenerateGatePin: vi.fn(),
  listApiTokens: vi.fn(async () => ({ tokens: [] })),
  createApiToken: vi.fn(),
  revokeApiToken: vi.fn(),
  setProjectEnabled: vi.fn(),
  saveRepoChecks: vi.fn(),
  getRepoCheckDefaults: vi.fn(async () => ({ available: false, defaults: {} })),
  getRepoWebhooks: vi.fn(async () => ({ webhooks: [] })),
  fixRepoWebhook: vi.fn(),
}))

import DeployTargetOverrides from './DeployTargetOverrides'
import AdminPage from './AdminPage'

const PROJECTS = [
  {
    id: 1,
    name: 'Horizon',
    enabled: true,
    repos: [{ repo: 'FinTekkers/horizon', prefix: 'HZ' }, { repo: 'FinTekkers/docs', prefix: 'DOC' }],
  },
  { id: 2, name: 'Old', enabled: false, repos: [{ repo: 'FinTekkers/legacy', prefix: 'OLD' }] },
]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  api.getDeployTargetConfig.mockReset()
  localStorage.clear()
  sessionStorage.clear()
})

function rowOf(container, repo) {
  const label = Array.from(container.querySelectorAll('.deploy-target-row__repo')).find((el) => el.textContent === repo)
  return label.closest('.deploy-target-row').parentElement
}

async function renderPanel(targets = [HORIZON]) {
  api.getDeployTargetConfig.mockResolvedValue({ targets })
  const onChanged = vi.fn()
  const utils = render(<DeployTargetOverrides projects={PROJECTS} onChanged={onChanged} />)
  await utils.findByText('FinTekkers/docs')
  return { ...utils, onChanged }
}

function apiError(status, code, reason) {
  return Object.assign(new Error(code || `HTTP ${status}`), { status, code, reason })
}

test('lists each repo of an enabled project: key, script and service, or none; disabled projects are left out', async () => {
  const { container, queryByText } = await renderPanel()
  const horizon = within(rowOf(container, 'FinTekkers/horizon'))
  expect(horizon.getByText('horizon')).toBeTruthy()
  expect(horizon.getByText('deploy-horizon.sh')).toBeTruthy()
  expect(horizon.getByText('horizon-server')).toBeTruthy()
  expect(horizon.getByRole('button', { name: 'Edit' })).toBeTruthy()

  const docs = within(rowOf(container, 'FinTekkers/docs'))
  expect(docs.getByText('none')).toBeTruthy()
  expect(docs.getByRole('button', { name: 'Add target' })).toBeTruthy()

  expect(queryByText('FinTekkers/legacy')).toBeNull()
  expect(container.querySelectorAll('.deploy-target-row').length).toBe(2)
})

test('healthCheckType help says it does not change how real deploys run', async () => {
  const { container } = await renderPanel()
  const docs = within(rowOf(container, 'FinTekkers/docs'))
  fireEvent.click(docs.getByRole('button', { name: 'Add target' }))
  expect(docs.getByLabelText('Health check type')).toBeTruthy()
  expect(docs.getByText(/does not change how real deploys run/)).toBeTruthy()
})

test('create asks for the PIN before any request, sends it as the last argument only, then refetches', async () => {
  const { container, onChanged } = await renderPanel()
  const docs = within(rowOf(container, 'FinTekkers/docs'))
  fireEvent.click(docs.getByRole('button', { name: 'Add target' }))
  fireEvent.change(docs.getByLabelText('Script'), { target: { value: 'deploy-docs.sh' } })
  fireEvent.change(docs.getByLabelText('Service'), { target: { value: 'fintekkers-docs' } })
  fireEvent.change(docs.getByLabelText('Extra services (comma-separated)'), { target: { value: ' a, ,b , ' } })
  fireEvent.change(docs.getByLabelText('Repo dir'), { target: { value: '/opt/fintekkers/docs' } })
  fireEvent.change(docs.getByLabelText('Health URL'), { target: { value: 'https://docs.example/' } })
  fireEvent.change(docs.getByLabelText('Health check type'), { target: { value: 'http-200' } })
  fireEvent.click(docs.getByRole('button', { name: 'Save' }))

  expect(api.createDeployTarget).not.toHaveBeenCalled()
  const pinInput = docs.getByLabelText('Gate PIN to save deploy target for FinTekkers/docs')
  expect(pinInput.type).toBe('password')

  api.createDeployTarget.mockResolvedValueOnce({ ok: true })
  api.getDeployTargetConfig.mockResolvedValue({ targets: [HORIZON, { ...HORIZON, key: 'docs', repo: 'FinTekkers/docs', script: 'deploy-docs.sh', service: 'fintekkers-docs' }] })
  fireEvent.change(pinInput, { target: { value: '4321' } })
  fireEvent.click(docs.getByRole('button', { name: 'Confirm save' }))

  await waitFor(() => expect(onChanged).toHaveBeenCalled())
  expect(api.createDeployTarget).toHaveBeenCalledWith(
    {
      key: 'docs',
      repo: 'FinTekkers/docs',
      script: 'deploy-docs.sh',
      service: 'fintekkers-docs',
      extraServices: ['a', 'b'],
      repoDir: '/opt/fintekkers/docs',
      stateKey: 'docs',
      healthUrl: 'https://docs.example/',
      healthCheckType: 'http-200',
    },
    '4321',
  )
  expect(JSON.stringify(api.createDeployTarget.mock.calls[0][0])).not.toContain('4321')
  expect(api.getDeployTargetConfig).toHaveBeenCalledTimes(2)
  await within(rowOf(container, 'FinTekkers/docs')).findByText('fintekkers-docs')
  expect(container.querySelectorAll('input[type=password]').length).toBe(0)
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
})

test('edit sends the key from the row and the edited fields; the key field is read-only', async () => {
  const { container, onChanged } = await renderPanel()
  const row = within(rowOf(container, 'FinTekkers/horizon'))
  fireEvent.click(row.getByRole('button', { name: 'Edit' }))
  expect(row.getByLabelText('Key').readOnly).toBe(true)
  fireEvent.change(row.getByLabelText('Service'), { target: { value: 'horizon-server-2' } })
  fireEvent.click(row.getByRole('button', { name: 'Save' }))
  expect(api.updateDeployTarget).not.toHaveBeenCalled()

  api.updateDeployTarget.mockResolvedValueOnce({ ok: true })
  fireEvent.change(row.getByLabelText('Gate PIN to save deploy target for FinTekkers/horizon'), { target: { value: '9' } })
  fireEvent.click(row.getByRole('button', { name: 'Confirm save' }))
  await waitFor(() => expect(onChanged).toHaveBeenCalled())
  const [key, fields, pin] = api.updateDeployTarget.mock.calls[0]
  expect(key).toBe('horizon')
  expect(fields.service).toBe('horizon-server-2')
  expect(fields.extraServices).toEqual(['horizon-farm'])
  expect(fields).not.toHaveProperty('key')
  expect(pin).toBe('9')
})

test('cancelling the PIN prompt sends nothing, clears the PIN and keeps the form values', async () => {
  const { container } = await renderPanel()
  const row = within(rowOf(container, 'FinTekkers/horizon'))
  fireEvent.click(row.getByRole('button', { name: 'Edit' }))
  fireEvent.change(row.getByLabelText('Service'), { target: { value: 'edited-svc' } })
  fireEvent.click(row.getByRole('button', { name: 'Save' }))
  fireEvent.change(row.getByLabelText('Gate PIN to save deploy target for FinTekkers/horizon'), { target: { value: '1111' } })
  fireEvent.click(row.getAllByRole('button', { name: 'Cancel' }).at(-1))

  expect(api.updateDeployTarget).not.toHaveBeenCalled()
  expect(row.queryByLabelText('Gate PIN to save deploy target for FinTekkers/horizon')).toBeNull()
  expect(row.getByLabelText('Service').value).toBe('edited-svc')
  fireEvent.click(row.getByRole('button', { name: 'Save' }))
  expect(row.getByLabelText('Gate PIN to save deploy target for FinTekkers/horizon').value).toBe('')
})

test('delete shows its warning and asks for the PIN before any request', async () => {
  const { container, onChanged } = await renderPanel()
  const row = within(rowOf(container, 'FinTekkers/horizon'))
  fireEvent.click(row.getByRole('button', { name: 'Delete' }))
  expect(row.getByRole('alert').textContent).toMatch(/Releases of FinTekkers\/horizon will no longer deploy/)
  expect(row.getByRole('alert').textContent).toMatch(/does not come back on restart/)
  expect(api.deleteDeployTarget).not.toHaveBeenCalled()

  fireEvent.click(row.getByRole('button', { name: 'Cancel' }))
  expect(api.deleteDeployTarget).not.toHaveBeenCalled()
  expect(row.queryByRole('alert')).toBeNull()

  fireEvent.click(row.getByRole('button', { name: 'Delete' }))
  api.deleteDeployTarget.mockResolvedValueOnce({ ok: true })
  api.getDeployTargetConfig.mockResolvedValue({ targets: [] })
  fireEvent.change(row.getByLabelText('Gate PIN to delete deploy target for FinTekkers/horizon'), { target: { value: '77' } })
  fireEvent.click(row.getByRole('button', { name: 'Delete target' }))
  await waitFor(() => expect(onChanged).toHaveBeenCalled())
  expect(api.deleteDeployTarget).toHaveBeenCalledWith('horizon', '77')
  await within(rowOf(container, 'FinTekkers/horizon')).findByText('none')
})

test.each([
  ['a schema 400', apiError(400, 'FST_ERR_VALIDATION'), 'Not saved — a field is missing or badly formatted.'],
  [
    'a sudoers 400',
    apiError(400, 'deploy_target_invalid', 'service not-a-service not in horizon-deploy.sudoers'),
    'Not saved — service not-a-service not in horizon-deploy.sudoers.',
  ],
  ['a 401', apiError(401, 'human_gate_key_required'), 'Gate PIN incorrect.'],
  ['a 404', apiError(404, 'deploy_target_not_found'), 'That target no longer exists.'],
  ['a 409', apiError(409, 'deploy_target_conflict'), 'Another target already uses that key or repo.'],
])('%s is shown in plain words and the PIN is cleared', async (_label, error, message) => {
  const { container, onChanged } = await renderPanel()
  const row = within(rowOf(container, 'FinTekkers/horizon'))
  fireEvent.click(row.getByRole('button', { name: 'Edit' }))
  fireEvent.click(row.getByRole('button', { name: 'Save' }))
  api.updateDeployTarget.mockRejectedValueOnce(error)
  const pinInput = row.getByLabelText('Gate PIN to save deploy target for FinTekkers/horizon')
  fireEvent.change(pinInput, { target: { value: 'secret-pin' } })
  fireEvent.click(row.getByRole('button', { name: 'Confirm save' }))

  expect(await row.findByText(message)).toBeTruthy()
  expect(pinInput.value).toBe('')
  expect(container.textContent).not.toContain('secret-pin')
  expect(container.textContent).not.toContain('human_gate_key_required')
  expect(onChanged).not.toHaveBeenCalled()
})

test('a config load failure shows a plain-words error, not a blank list', async () => {
  api.getDeployTargetConfig.mockRejectedValue(new Error('HTTP 500'))
  const { findByText } = render(<DeployTargetOverrides projects={PROJECTS} />)
  expect(await findByText('Could not load deploy targets.')).toBeTruthy()
})

test('after a create the Deploy targets panel lists the new key with its Dry run, without a reload', async () => {
  const statuses = [{ key: 'horizon', repo: 'FinTekkers/horizon', service: 'horizon-server', lastTag: null, lastCommit: null, lastResult: 'never', lastAt: null }]
  api.getDeployTargets.mockResolvedValue({ targets: statuses })
  api.getDeployTargetConfig.mockResolvedValue({ targets: [HORIZON] })
  const { container, findByText } = render(<AdminPage sync={{}} projects={PROJECTS} onBack={() => {}} />)
  await findByText('FinTekkers/docs')
  const targetsPanel = () =>
    within(Array.from(container.querySelectorAll('.panel__title')).find((el) => el.textContent === 'Deploy targets').closest('.admin__panel'))
  await targetsPanel().findByText('FinTekkers/horizon')
  expect(targetsPanel().queryByText('FinTekkers/docs')).toBeNull()

  const docs = within(rowOf(container, 'FinTekkers/docs'))
  fireEvent.click(docs.getByRole('button', { name: 'Add target' }))
  fireEvent.click(docs.getByRole('button', { name: 'Save' }))
  api.createDeployTarget.mockResolvedValueOnce({ ok: true })
  api.getDeployTargets.mockResolvedValue({
    targets: [...statuses, { key: 'docs', repo: 'FinTekkers/docs', service: 'fintekkers-docs', lastTag: null, lastCommit: null, lastResult: 'never', lastAt: null }],
  })
  fireEvent.change(docs.getByLabelText('Gate PIN to save deploy target for FinTekkers/docs'), { target: { value: '1' } })
  fireEvent.click(docs.getByRole('button', { name: 'Confirm save' }))

  await targetsPanel().findByText('FinTekkers/docs')
  expect(targetsPanel().getAllByRole('button', { name: /Dry run/ }).length).toBe(2)
})
