// Render tests for the read-only deploy-targets panel (HZ-41): it must show
// each target's repo/service/last-tag/last-result, and — this is the
// guardrail that matters — it must never render a button, form, or input,
// since a deploy target names a script and a service to restart and an
// editable target would be arbitrary code execution.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'

vi.mock('../api', () => ({
  saveToken: vi.fn(),
  createProject: vi.fn(),
  addRepoToProject: vi.fn(),
  disconnectRepo: vi.fn(),
  regenerateGatePin: vi.fn(),
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
