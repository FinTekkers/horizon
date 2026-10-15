// HZ-462 metric 2: one shared table style. The Plan Inventory and key-facts
// tables, Admin's flaky tests and Agent Definitions' models all carry
// .data-table inside a .data-table-wrap. Admin and Agent Definitions changed
// only the class and wrapper: the same column headers, and still no buttons in
// either table (neither had any before HZ-462).

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, screen, within } from '@testing-library/react'
import * as api from './api'

vi.mock('./api', () => ({
  // Tracker
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(() => () => {}),
  // AdminPage
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
  getDeployTargets: vi.fn(async () => ({ targets: [] })),
  getCheckFlakes: vi.fn(),
  // AgentDefinitionsPage
  listDefinitions: vi.fn(async () => ({ global: [], projects: [], repos: [] })),
  getDefinition: vi.fn(),
  saveDefinition: vi.fn(),
  effectivePrompt: vi.fn(),
  listRuleTargets: vi.fn(async () => ({ projects: [], repos: [] })),
  listRuleVersions: vi.fn(),
  saveRule: vi.fn(),
  restoreRule: vi.fn(),
}))

import Tracker from './components/Tracker'
import AdminPage from './components/AdminPage'
import AgentDefinitionsPage from './components/AgentDefinitionsPage'
import { PLAN_INVENTORY_STEP_INDEX } from '../../domain/js/lifecycle.js'
import { FENCE_INFO } from '../../domain/js/planInventory.js'
import fixtures from '../../domain/fixtures/plan-inventory-cases.json'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const noop = () => {}
const headers = (table) => within(table).getAllByRole('columnheader').map((th) => th.textContent)

function expectShared(table) {
  expect(table.classList.contains('data-table')).toBe(true)
  expect(table.parentElement.classList.contains('data-table-wrap')).toBe(true)
  // The inline style the tables carried before is gone: the class is the style.
  expect(table.getAttribute('style')).toBeNull()
}

test('the Plan Inventory and key-facts tables carry .data-table', () => {
  const block = fixtures.cases[0].block
  const artifact = '```' + FENCE_INFO + '\n' + JSON.stringify(block, null, 2) + '\n```'
  render(
    <Tracker
      item={{
        id: 'P-462', title: 'Plan', desc: '', metric: '', guardrails: '', priority: 'Medium', kind: 'plan',
        cursor: PLAN_INVENTORY_STEP_INDEX + 1, paused: false, rejected: false, events: [], activeRun: null, providerChoices: {},
        stepOutputs: { [PLAN_INVENTORY_STEP_INDEX]: { output: 'done', attempt: 1, attemptCount: 1, artifact } },
      }}
      onBack={noop} onApprove={noop} onApproveWithComments={noop} onReject={noop} onResolveConflicts={noop}
      onTogglePause={noop} onRestartPhase={noop} onSetPersona={noop} onSetStepProvider={noop} onAbandon={noop}
    />,
  )
  expectShared(screen.getByRole('table', { name: 'Current state per repo' }))
  expectShared(screen.getByRole('table', { name: 'Key facts' }))
})

test('Admin’s flaky-tests table carries .data-table with the same headers and no buttons', async () => {
  api.getCheckFlakes.mockResolvedValue({
    repos: [
      {
        repo: 'acme/web',
        tests: [{ test: 'renders the cart', count: 1, count_7d: 0, last_seen: '2026-09-20T08:00:00.000Z', last_item_id: null, last_command: 'npm test', name_parsed: true, ping_status: null, pinged_at: null }],
      },
    ],
  })
  render(<AdminPage sync={{}} projects={[]} onBack={noop} />)
  const table = await screen.findByRole('table', { name: 'Flaky tests in acme/web' })
  expectShared(table)
  expect(headers(table)).toEqual(['Test', 'Flakes (7 d / total)', 'Last seen', 'Last item', 'Pinged'])
  expect(within(table).queryAllByRole('button')).toHaveLength(0)
})

test('Agent Definitions’ models table carries .data-table with the same headers and no buttons', async () => {
  render(<AgentDefinitionsPage onBack={noop} />)
  const table = await screen.findByRole('table', { name: 'Effective model per step', hidden: true })
  expectShared(table)
  expect(headers(table)).toEqual(['Step', 'Agent', 'Model'])
  expect(within(table).queryAllByRole('button', { hidden: true })).toHaveLength(0)
})
