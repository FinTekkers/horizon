// HZ-764 metric 3: a project's Agents tab lists only the steps whose "Runs on"
// overrides the default; the Settings tab still lists every step, through the
// same component and the same save. Also the repository page's long help sits
// behind More.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import * as api from '../../api'
import { STEPS } from '../../../../domain/js/lifecycle.js'

vi.mock('../../api', () => ({
  setProjectEnabled: vi.fn(),
  setProjectAutopilot: vi.fn(),
  setProjectDefinitionsEnabled: vi.fn(),
  setProjectStepProvider: vi.fn(async () => ({ ok: true })),
  addRepoToProject: vi.fn(),
  disconnectRepo: vi.fn(),
  fixRepoWebhook: vi.fn(),
  saveRepoChecks: vi.fn(),
  saveRepoMarks: vi.fn(),
  saveRepoTestEnvFile: vi.fn(),
  getRepoCheckDefaults: vi.fn(async () => ({ defaults: {} })),
}))

import { ProjectPage } from './ProjectPage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const eligible = STEPS.map((step, index) => ({ ...step, index })).filter(
  (step) => step.kind === 'agent' && step.providerOverrideEligible && !step.itemKind,
)
const OVERRIDDEN = eligible[1]
const project = (providerDefaults) => ({
  id: 4,
  name: 'Alpha',
  enabled: true,
  isolation: 'internal',
  repos: [{ repo: 'acme/web', prefix: 'AW', checks: {} }],
  providerDefaults,
})
const runsOn = () => screen.queryAllByRole('combobox', { name: / Runs on$/ })

test('with one step overriding the default, the Agents tab lists that step and no other', async () => {
  const defaults = {}
  defaults[OVERRIDDEN.index] = 'muse'
  render(<ProjectPage project={project(defaults)} tab="agents" />)
  expect(screen.getByRole('tab', { name: 'Agents' }).getAttribute('aria-selected')).toBe('true')
  expect(runsOn().map((s) => s.getAttribute('aria-label'))).toEqual([`Alpha ${OVERRIDDEN.label} Runs on`])
  expect(runsOn()[0].value).toBe('muse')
  for (const step of eligible.filter((s) => s.index !== OVERRIDDEN.index)) {
    expect(screen.queryByLabelText(`Alpha ${step.label} Runs on`)).toBeNull()
  }
  expect(screen.getByText(/Default provider:/)).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: 'Alpha project definitions' })).toBeTruthy()

  // The same save as on Settings.
  fireEvent.change(runsOn()[0], { target: { value: 'claude' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(api.setProjectStepProvider).toHaveBeenCalledWith(4, OVERRIDDEN.index, 'claude'))
})

test('with no override the Agents tab says every step uses the default; Settings lists every step', () => {
  const { rerender } = render(<ProjectPage project={project({})} tab="agents" />)
  expect(runsOn()).toHaveLength(0)
  expect(screen.getByText('Every step uses the default.')).toBeTruthy()

  rerender(<ProjectPage project={project({})} tab="settings" />)
  expect(runsOn().length).toBeGreaterThan(eligible.length)
  for (const step of eligible) expect(screen.getByLabelText(`Alpha ${step.label} Runs on`)).toBeTruthy()
  expect(screen.getByRole('switch', { name: 'Alpha enabled' })).toBeTruthy()
  expect(screen.getByText('Isolation').tagName).toBe('DT')
  expect(screen.getByText('internal').tagName).toBe('DD')
})

test('the repository page folds its long help behind More', () => {
  render(<ProjectPage project={project({})} tab="repositories" repo="acme/web" />)
  fireEvent.click(screen.getByRole('button', { name: /Check commands/ }))
  const more = screen.getByRole('button', { name: 'More about check commands' })
  const help = screen.getByText(/The greyed hints are suggestions/)
  expect(more.getAttribute('aria-expanded')).toBe('false')
  expect(help.closest('[hidden]')).not.toBeNull()
  fireEvent.click(more)
  expect(more.getAttribute('aria-expanded')).toBe('true')
  expect(help.closest('[hidden]')).toBeNull()
})
