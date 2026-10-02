// HZ-192: the definitions page shows each step's EFFECTIVE model — not just its
// agent's default. Nothing ships with an override, so this drives the page from
// a mocked `models` block carrying one step override and one persona override;
// a page that rendered the agent default would fail here.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('../api', () => ({
  listDefinitions: vi.fn(async () => ({ global: [], projects: [], repos: [] })),
  getDefinition: vi.fn(),
  saveDefinition: vi.fn(),
  effectivePrompt: vi.fn(),
  listRuleTargets: vi.fn(async () => ({ projects: [], repos: [] })),
  listRuleVersions: vi.fn(),
  saveRule: vi.fn(),
  restoreRule: vi.fn(),
}))

vi.mock('../domain/personas', async (importOriginal) => {
  const actual = await importOriginal()
  const models = {
    agents: { ...actual.MODELS.agents, eng: 'claude-test-eng', concierge: 'claude-test-concierge' },
    steps: { 'Draft implementation plan': 'claude-test-step' },
    personas: { 'eng.python': 'claude-test-persona' },
  }
  return {
    ...actual,
    MODELS: models,
    resolveModel: (agent, step = null, persona = null) => actual.resolveModel(agent, step, persona, models),
  }
})

import AgentDefinitionsPage from './AgentDefinitionsPage'

afterEach(cleanup)

test('a step override shows on its own step, and its sibling on the same agent keeps the default', async () => {
  const { findByTestId, getByTestId } = render(<AgentDefinitionsPage onBack={() => {}} />)
  const overridden = await findByTestId('model-row-Draft implementation plan')
  expect(overridden.textContent).toContain('claude-test-step')
  expect(overridden.textContent).toContain('eng')
  const sibling = getByTestId('model-row-Specialist agent implements')
  expect(sibling.textContent).toContain('eng')
  expect(sibling.textContent).toContain('claude-test-eng')
})

test('the concierge and conflict rows show their own resolved models', async () => {
  const { findByTestId, getByTestId } = render(<AgentDefinitionsPage onBack={() => {}} />)
  expect((await findByTestId('model-row-concierge')).textContent).toContain('claude-test-concierge')
  expect(getByTestId('model-row-conflict').textContent).toContain('claude-test-eng')
})

test('persona overrides are listed, with the emergency-override caption', async () => {
  const { findByLabelText, getByText } = render(<AgentDefinitionsPage onBack={() => {}} />)
  const list = await findByLabelText('Persona model overrides')
  expect(list.textContent).toContain('eng.python')
  expect(list.textContent).toContain('claude-test-persona')
  expect(getByText('FARM_MODEL_OVERRIDE')).toBeTruthy()
})
