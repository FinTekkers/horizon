// Render tests for the agent-definitions editor (HZ-9): the hierarchy tree,
// the effective-prompt preview, and inline save-error display (QA conditions
// replace any "manually verified" claim). HZ-246: project and repo rules load,
// save and restore as DB versions (saveRule/restoreRule) with the gate PIN,
// never through saveDefinition, which would rewrite the .md default in git.

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
  listRuleTargets: vi.fn(async () => ({
    projects: [{ scope: 'project', key: 'fintekkers', label: 'FinTekkers', file: true, versions: 0 }],
    repos: [{ scope: 'repo', key: 'FinTekkers__ui-service', label: 'FinTekkers/ui-service', file: true, versions: 0 }],
  })),
  listRuleVersions: vi.fn(async (scope, key) => ({
    scope,
    key,
    default: { exists: true, path: `farm/rules/${scope}s/${key}.md`, content: `# ${key} rules` },
    served_version: null,
    versions: [],
  })),
  saveRule: vi.fn(async () => ({ ok: true, version: { id: 2, version: 2 } })),
  restoreRule: vi.fn(async () => ({ ok: true, version: { id: 3, version: 3, restored_from: 1 } })),
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
  expect(api.listRuleVersions).toHaveBeenCalledWith('repo', 'FinTekkers__ui-service')
  expect(api.getDefinition).not.toHaveBeenCalled()
  await findByText(/Agents get the file default/)
})

test('editing a global definition shows the every-project warning', async () => {
  const { findByText } = render(<AgentDefinitionsPage onBack={() => {}} />)
  fireEvent.click(await findByText('eng_fullstack'))
  await findByText(/edits here apply to/)
})

test('a rejected save renders the error inline and keeps the editor content', async () => {
  api.saveRule.mockRejectedValueOnce(
    new Error('Looks like a credential — move it to an $ENV_VAR reference (credential assignment)'),
  )
  const { findByText, getByLabelText } = render(<AgentDefinitionsPage onBack={() => {}} />)
  fireEvent.click(await findByText('FinTekkers__ui-service'))
  await waitFor(() => expect(getByLabelText('Definition content').value).not.toBe(''))
  fireEvent.change(getByLabelText('Definition content'), { target: { value: 'password=hunter2' } })
  fireEvent.change(getByLabelText('Gate PIN to save or restore rules'), { target: { value: '1234' } })
  fireEvent.click(await findByText('Save new version'))
  await findByText(/Looks like a credential/)
  expect(getByLabelText('Definition content').value).toBe('password=hunter2')
})

test('saving project rules stores a DB version with the PIN, never a git commit of the file', async () => {
  const { findByText, getByLabelText } = render(<AgentDefinitionsPage onBack={() => {}} />)
  fireEvent.click(await findByText('fintekkers'))
  await waitFor(() => expect(getByLabelText('Definition content').value).not.toBe(''))
  fireEvent.change(getByLabelText('Definition content'), { target: { value: 'new rules' } })
  expect((await findByText('Save new version')).disabled).toBe(true) // no PIN yet
  fireEvent.change(getByLabelText('Gate PIN to save or restore rules'), { target: { value: '1234' } })
  fireEvent.click(await findByText('Save new version'))
  await findByText(/Saved as version 2/)
  expect(api.saveRule).toHaveBeenCalledWith('project', 'fintekkers', 'new rules', '1234')
  expect(api.saveDefinition).not.toHaveBeenCalled()
  expect(getByLabelText('Gate PIN to save or restore rules').value).toBe('') // never kept
})

test('saving repo rules goes through saveRule too, and a wrong PIN says so', async () => {
  api.saveRule.mockRejectedValueOnce(Object.assign(new Error('human_gate_key_required'), { status: 401 }))
  const { findByText, getByLabelText } = render(<AgentDefinitionsPage onBack={() => {}} />)
  fireEvent.click(await findByText('FinTekkers__ui-service'))
  await waitFor(() => expect(getByLabelText('Definition content').value).not.toBe(''))
  fireEvent.change(getByLabelText('Definition content'), { target: { value: 'repo rules' } })
  fireEvent.change(getByLabelText('Gate PIN to save or restore rules'), { target: { value: '0000' } })
  fireEvent.click(await findByText('Save new version'))
  await findByText('Gate PIN incorrect')
  expect(api.saveRule).toHaveBeenCalledWith('repo', 'FinTekkers__ui-service', 'repo rules', '0000')
  expect(api.saveDefinition).not.toHaveBeenCalled()
})

test('a global definition still saves through git and reports the commit hash', async () => {
  const { findByText, getByLabelText } = render(<AgentDefinitionsPage onBack={() => {}} />)
  fireEvent.click(await findByText('eng_fullstack'))
  await waitFor(() => expect(getByLabelText('Definition content').value).not.toBe(''))
  fireEvent.change(getByLabelText('Definition content'), { target: { value: 'new persona' } })
  fireEvent.click(await findByText('Save (commits to git)'))
  await findByText(/Saved — commit abc1234, pushed/)
  expect(api.saveDefinition).toHaveBeenCalledWith('persona', 'eng_fullstack', 'new persona')
  expect(api.saveRule).not.toHaveBeenCalled()
})

test('the versions list shows every saved version and Restore calls restoreRule with the PIN', async () => {
  const listed = {
    scope: 'project',
    key: 'fintekkers',
    default: { exists: true, path: 'farm/rules/projects/fintekkers.md', content: 'FILE' },
    served_version: 2,
    versions: [
      { id: 2, version: 2, content: 'TWO', actor: 'Owner', restored_from: null, created_at: 't2', verified: true },
      { id: 1, version: 1, content: 'ONE', actor: 'Owner', restored_from: null, created_at: 't1', verified: true },
    ],
  }
  api.listRuleVersions.mockResolvedValueOnce(listed)
  const { findByText, getByLabelText, getByTestId } = render(<AgentDefinitionsPage onBack={() => {}} />)
  fireEvent.click(await findByText('fintekkers'))
  await waitFor(() => expect(getByLabelText('Definition content').value).toBe('TWO'))
  await findByText('Agents get saved version 2.')
  expect(getByTestId('rule-version-1').textContent).toContain('Owner')
  expect(getByTestId('rule-version-2').textContent).toContain('serving')
  fireEvent.change(getByLabelText('Gate PIN to save or restore rules'), { target: { value: '1234' } })
  fireEvent.click(getByLabelText('Restore version 1'))
  await findByText('Restored version 1 as version 3')
  expect(api.restoreRule).toHaveBeenCalledWith('project', 'fintekkers', 1, '1234')
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
