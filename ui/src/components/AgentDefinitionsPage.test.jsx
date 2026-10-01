// Render tests for the agent-definitions editor (HZ-9): the hierarchy tree,
// the effective-prompt preview, and inline save-error display (QA conditions
// replace any "manually verified" claim).

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('../api', () => ({
  listDefinitions: vi.fn(async () => ({
    global: [
      { kind: 'role', name: 'eng_implement', bytes: 1400 },
      { kind: 'persona', name: 'eng_fullstack', bytes: 800 },
    ],
    projects: [{ kind: 'project', name: 'fintekkers', bytes: 1500 }],
    repos: [{ kind: 'repo', name: 'FinTekkers__ui-service', bytes: 2100 }],
  })),
  getDefinition: vi.fn(async (kind, name) => ({
    kind,
    name,
    content: `# ${name} rules`,
    path: `farm/rules/repos/${name}.md`,
    bytes: 20,
  })),
  saveDefinition: vi.fn(async () => ({ ok: true, commit: 'abc1234', pushed: true })),
  effectivePrompt: vi.fn(async () => ({ prompt: 'ROLE\n\n## Project rules\nMERGED RULES' })),
}))

import * as api from '../api'
import AgentDefinitionsPage from './AgentDefinitionsPage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

test('renders the three hierarchy layers with their definitions', async () => {
  const { findByText, getByText } = render(<AgentDefinitionsPage onBack={() => {}} />)
  await findByText('FinTekkers__ui-service')
  expect(getByText('Global — every project')).toBeTruthy()
  expect(getByText('Projects')).toBeTruthy()
  expect(getByText('Repositories')).toBeTruthy()
  expect(getByText('eng_implement')).toBeTruthy()
  expect(getByText('eng_fullstack')).toBeTruthy()
  expect(getByText('fintekkers')).toBeTruthy()
})

test('selecting a definition loads its content into the editor', async () => {
  const { findByText, getByLabelText } = render(<AgentDefinitionsPage onBack={() => {}} />)
  fireEvent.click(await findByText('FinTekkers__ui-service'))
  await waitFor(() =>
    expect(getByLabelText('Definition content').value).toBe('# FinTekkers__ui-service rules'),
  )
  expect(api.getDefinition).toHaveBeenCalledWith('repo', 'FinTekkers__ui-service')
})

test('editing a global definition shows the every-project warning', async () => {
  const { findByText } = render(<AgentDefinitionsPage onBack={() => {}} />)
  fireEvent.click(await findByText('eng_fullstack'))
  await findByText(/edits here apply to/)
})

test('a rejected save renders the error inline and keeps the editor content', async () => {
  api.saveDefinition.mockRejectedValueOnce(
    new Error('Looks like a credential — move it to an $ENV_VAR reference (credential assignment)'),
  )
  const { findByText, getByLabelText } = render(<AgentDefinitionsPage onBack={() => {}} />)
  fireEvent.click(await findByText('FinTekkers__ui-service'))
  await waitFor(() => expect(getByLabelText('Definition content').value).not.toBe(''))
  fireEvent.change(getByLabelText('Definition content'), { target: { value: 'password=hunter2' } })
  fireEvent.click(await findByText('Save (commits to git)'))
  await findByText(/Looks like a credential/)
  expect(getByLabelText('Definition content').value).toBe('password=hunter2')
})

test('a successful save reports the commit hash', async () => {
  const { findByText, getByLabelText } = render(<AgentDefinitionsPage onBack={() => {}} />)
  fireEvent.click(await findByText('fintekkers'))
  await waitFor(() => expect(getByLabelText('Definition content').value).not.toBe(''))
  fireEvent.change(getByLabelText('Definition content'), { target: { value: 'new rules' } })
  fireEvent.click(await findByText('Save (commits to git)'))
  await findByText(/Saved — commit abc1234, pushed/)
  expect(api.saveDefinition).toHaveBeenCalledWith('project', 'fintekkers', 'new rules')
})

test('the preview button renders the merged effective prompt', async () => {
  const { findByText } = render(<AgentDefinitionsPage onBack={() => {}} />)
  fireEvent.click(await findByText('FinTekkers__ui-service'))
  fireEvent.click(await findByText('Preview effective prompt'))
  await findByText(/MERGED RULES/)
  expect(api.effectivePrompt).toHaveBeenCalledWith({
    role: 'eng_implement',
    agent: 'eng',
    persona: 'fullstack',
    project: 'FinTekkers',
    repo: 'FinTekkers/ui-service',
  })
})

// HZ-125: persona files are agent-prefixed and flat (eng_fullstack.md), so the
// selection names a FILE, not a persona id. Without translating it back to its
// { agent, persona } slot the preview would silently compose the default
// instead of the persona the human clicked.
test('previewing a selected persona file sends that persona and its agent', async () => {
  const { findByText } = render(<AgentDefinitionsPage onBack={() => {}} />)
  fireEvent.click(await findByText('eng_fullstack'))
  fireEvent.click(await findByText('Preview effective prompt'))
  await findByText(/MERGED RULES/)
  expect(api.effectivePrompt).toHaveBeenCalledWith({
    role: 'eng_implement',
    agent: 'eng',
    persona: 'fullstack',
    project: 'FinTekkers',
  })
})

// HZ-192: the page shows each step's effective model from domain/personas.json.
// AgentDefinitionsPage.models.test.jsx drives it with overrides; this pins the
// values that ship.
test('the models section shows every agent step, the concierge and conflict resolution with their models', async () => {
  const { STEPS } = await import('../../../domain/js/lifecycle.js')
  const { findByText, getByTestId } = render(<AgentDefinitionsPage onBack={() => {}} />)
  await findByText('FinTekkers__ui-service')
  const agentSteps = STEPS.filter((step) => step.kind === 'agent')
  expect(agentSteps.length).toBeGreaterThan(0)
  for (const step of agentSteps) {
    expect(getByTestId(`model-row-${step.label}`).textContent).toContain('claude-opus-5-5')
  }
  expect(getByTestId('model-row-Set guardrails').textContent).toContain('architect')
  expect(getByTestId('model-row-concierge').textContent).toContain('claude-sonnet-5')
  expect(getByTestId('model-row-concierge').textContent).not.toContain('claude-sonnet-5-5')
  expect(getByTestId('model-row-conflict').textContent).toContain('claude-opus-5-5')
})
