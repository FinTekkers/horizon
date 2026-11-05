// HZ-62: approving the gate that closes an item must return the user to the
// board; approving any earlier gate must not. Both approve call sites
// (App.jsx's ConfirmGateDialog and the "Approve with comments" composer)
// are covered, plus the guardrail that a failed approval never navigates.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react'
import { STEPS, IMPLEMENT_STEP_INDEX, endIndex } from '../../domain/js/lifecycle.js'
import { PRIORITY } from '../../domain/js/priorities.js'
import * as boardNarrowing from './boardNarrowing'

const CLOSING_GATE_INDEX = endIndex('change') - 1
const CLOSING_GATE_LABEL = STEPS[CLOSING_GATE_INDEX].label

let items = []
let projects = []
const listeners = new Set()

vi.mock('./api', () => ({
  subscribe: (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  getItems: () => items,
  getCurrentUser: vi.fn(async () => ({ name: 'Test User', initials: 'TU', email: 'test@example.com' })),
  getSync: () => ({ connected: false }),
  getProjects: () => projects,
  getActiveProjectId: () => null,
  // HZ-661: no board frame yet, so the first-project screen stays off.
  hasSnapshot: () => false,
  getFarm: () => null,
  getDurationEstimates: () => null,
  getDeployBlock: () => null,
  getPlanProgress: () => [],
  approveGate: vi.fn(),
  moveItem: vi.fn(),
  getRestartSent: () => null,
  setPaused: vi.fn(),
  setPersona: vi.fn(),
  setStepProvider: vi.fn(),
  abandonItem: vi.fn(),
  addDependency: vi.fn(async () => ({ ok: true })),
  createItem: vi.fn(),
  setProjectEnabled: vi.fn(),
  logout: vi.fn(),
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
}))

import * as api from './api'
import App from './App'

function setItems(next) {
  items = next
  listeners.forEach((fn) => fn())
}

function itemAtClosingGate(id) {
  return {
    id,
    title: 'A work item one approval from closed',
    desc: '',
    metric: '',
    guardrails: '',
    priority: 'Medium',
    cursor: CLOSING_GATE_INDEX,
    paused: false,
    rejected: false,
    events: [],
    stepOutputs: {},
    activeRun: null,
  }
}

afterEach(async () => {
  ;(await vi.importActual('./api/serverApi')).setPinRequester(null)
  cleanup()
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  items = []
  projects = []
  listeners.clear()
  localStorage.removeItem('horizon.projectFilter')
  localStorage.removeItem('horizon.projectRepos')
  vi.unstubAllGlobals()
})

test('approving the closing gate via the confirm dialog returns to the board', async () => {
  const id = 'FG-1'
  setItems([itemAtClosingGate(id)])
  api.approveGate.mockResolvedValue({ ok: true, closed: true })
  window.history.pushState({}, '', `/${id.toLowerCase()}`)

  const { findByText } = render(<App />)
  await findByText(CLOSING_GATE_LABEL)

  fireEvent.click(document.querySelector('.btn-gate-approve'))
  await findByText('Approve this gate?')
  fireEvent.click(document.querySelector('.composer__submit'))

  await waitFor(() => expect(api.approveGate).toHaveBeenCalledWith(id, undefined))
  await waitFor(() => expect(window.location.pathname).toBe('/'))
})

// HZ-546: the item page links an item id the board holds; an unknown id stays text.
test('an item id in the description links to that item when the board holds it', async () => {
  setItems([{ ...itemAtClosingGate('FG-10'), desc: 'Needs FG-11 first; ZZ-9 is unrelated.' }, itemAtClosingGate('FG-11')])
  window.history.pushState({}, '', '/fg-10')
  const { findByRole, queryByRole } = render(<App />)
  const link = await findByRole('link', { name: 'FG-11' })
  expect(link.getAttribute('href')).toBe('/fg-11')
  expect(queryByRole('link', { name: 'ZZ-9' })).toBeNull()
})

test('approving an earlier gate leaves the user on the item page', async () => {
  const id = 'FG-2'
  setItems([{ ...itemAtClosingGate(id), cursor: 3 }]) // "Approve & prioritize this work"
  api.approveGate.mockResolvedValue({ ok: true, closed: false })
  window.history.pushState({}, '', `/${id.toLowerCase()}`)

  const { findByText } = render(<App />)
  await findByText('Approve & prioritize this work')

  fireEvent.click(document.querySelector('.btn-gate-approve'))
  await findByText('Approve this gate?')
  fireEvent.click(document.querySelector('.composer__submit'))

  await waitFor(() => expect(api.approveGate).toHaveBeenCalledWith(id, undefined))
  expect(window.location.pathname).toBe(`/${id.toLowerCase()}`)
})

test('a failed approval on the closing gate does not navigate away', async () => {
  const id = 'FG-3'
  setItems([itemAtClosingGate(id)])
  api.approveGate.mockResolvedValue({ ok: false })
  window.history.pushState({}, '', `/${id.toLowerCase()}`)

  const { findByText } = render(<App />)
  await findByText(CLOSING_GATE_LABEL)

  fireEvent.click(document.querySelector('.btn-gate-approve'))
  await findByText('Approve this gate?')
  fireEvent.click(document.querySelector('.composer__submit'))

  await waitFor(() => expect(api.approveGate).toHaveBeenCalledWith(id, undefined))
  expect(window.location.pathname).toBe(`/${id.toLowerCase()}`)
})

test('approving the closing gate with comments also returns to the board', async () => {
  const id = 'FG-4'
  setItems([itemAtClosingGate(id)])
  api.approveGate.mockResolvedValue({ ok: true, closed: true })
  window.history.pushState({}, '', `/${id.toLowerCase()}`)

  const { findByText } = render(<App />)
  await findByText(CLOSING_GATE_LABEL)

  fireEvent.click(document.querySelector('.btn-gate-feedback'))
  fireEvent.change(document.querySelector('.composer__input'), { target: { value: 'Ship it.' } })
  fireEvent.click(document.querySelector('.composer__submit'))

  await waitFor(() => expect(api.approveGate).toHaveBeenCalledWith(id, 'Ship it.'))
  await waitFor(() => expect(window.location.pathname).toBe('/'))
})

// ---- HZ-208: the project filter is view state only ----

const GATE_INDEX = STEPS.findIndex((s) => s.kind === 'gate')
const ALPHA = { id: 1, name: 'Alpha', enabled: true, repos: [] }
const BETA = { id: 2, name: 'Beta', enabled: true, repos: [] }

function projectItem(id, projectId, cursor = GATE_INDEX) {
  return { ...itemAtClosingGate(id), title: `Item ${id}`, cursor, project_id: projectId }
}

// Alpha: two gate-waiting items and one agent step; Beta: one gate-waiting.
const FILTER_ITEMS = [
  projectItem('AL-1', 1),
  projectItem('AL-2', 1),
  projectItem('AL-3', 1, 0),
  projectItem('BE-1', 2),
]

const boardIds = () => [...document.querySelectorAll('.card .card__id')].map((n) => n.textContent).sort()
const pendingBadge = () => document.querySelector('.pending-btn__badge').textContent

function chooseProject(getByRole, name) {
  fireEvent.click(document.querySelector('.projswitch'))
  fireEvent.click(getByRole('menuitemradio', { name }))
}

test('the filter narrows board, tracker and approvals to one project; All projects shows both', async () => {
  projects = [ALPHA, BETA]
  setItems(FILTER_ITEMS)
  const { findByText, getByRole, getByText } = render(<App />)
  await findByText('Item AL-1')
  expect(boardIds()).toEqual(['AL-1', 'AL-2', 'AL-3', 'BE-1'])

  chooseProject(getByRole, 'Beta')
  expect(boardIds()).toEqual(['BE-1'])
  fireEvent.click(document.querySelector('.pending-btn'))
  expect([...document.querySelectorAll('.drawer__list')].map((n) => n.textContent).join()).toContain('BE-1')
  expect(document.querySelector('.drawer__list').textContent).not.toContain('AL-')
  fireEvent.click(document.querySelector('.drawer__close'))
  fireEvent.click(getByText('Tracker'))
  expect(document.querySelector('.tracker__id').textContent).toBe('BE-1')
  fireEvent.click(getByText('Board'))

  chooseProject(getByRole, 'Alpha')
  expect(boardIds()).toEqual(['AL-1', 'AL-2', 'AL-3'])
  fireEvent.click(document.querySelector('.pending-btn'))
  expect(document.querySelector('.drawer__list').textContent).not.toContain('BE-1')
  fireEvent.click(document.querySelector('.drawer__close'))

  chooseProject(getByRole, 'All projects')
  expect(boardIds()).toEqual(['AL-1', 'AL-2', 'AL-3', 'BE-1'])
})

test('switching projects sends no write request, opens no dialog, and calls no item or project action', async () => {
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchSpy)
  projects = [ALPHA, BETA]
  setItems(FILTER_ITEMS)
  const { findByText, getByRole } = render(<App />)
  await findByText('Item AL-1')

  for (const name of ['Alpha', 'Beta', 'All projects', 'Alpha']) {
    chooseProject(getByRole, name)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('.composer')).toBeNull()
  }

  const calls = fetchSpy.mock.calls.map(([url, opts]) => ({ url: String(url), method: (opts?.method || 'GET').toUpperCase() }))
  expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  expect(calls.filter((c) => /\/activate|\/enabled|\/pause|\/abandon|\/move/.test(c.url))).toEqual([])
  for (const action of ['setProjectEnabled', 'setPaused', 'abandonItem', 'approveGate', 'moveItem']) {
    expect(api[action], action).not.toHaveBeenCalled()
  }
  expect(document.body.textContent).not.toMatch(/restart farm|switch bot farm/i)
})

test('the pending-approvals count covers every enabled project under every filter', async () => {
  projects = [ALPHA, BETA]
  setItems(FILTER_ITEMS)
  const { findByText, getByRole } = render(<App />)
  await findByText('Item AL-1')
  expect(pendingBadge()).toBe('3')
  for (const name of ['Alpha', 'Beta', 'All projects']) {
    chooseProject(getByRole, name)
    expect(pendingBadge(), name).toBe('3')
  }
})

test('a stored filter for an unknown or disabled project falls back to All projects', async () => {
  projects = [ALPHA, { ...BETA, enabled: false }]
  setItems(FILTER_ITEMS.filter((it) => it.project_id === 1))
  for (const stored of ['999', '2']) {
    localStorage.setItem('horizon.projectFilter', stored)
    const { findByText, unmount } = render(<App />)
    await findByText('Item AL-1')
    expect(document.querySelector('.projswitch').textContent).toContain('All projects')
    expect(boardIds()).toEqual(['AL-1', 'AL-2', 'AL-3'])
    unmount()
  }
})

test('disabling the selected project live resets the filter to All projects', async () => {
  projects = [ALPHA, BETA]
  setItems(FILTER_ITEMS)
  const { findByText, getByRole } = render(<App />)
  await findByText('Item AL-1')
  chooseProject(getByRole, 'Beta')
  expect(boardIds()).toEqual(['BE-1'])

  // The SSE push after Beta is disabled: its items leave the snapshot too.
  projects = [ALPHA, { ...BETA, enabled: false }]
  act(() => setItems(FILTER_ITEMS.filter((it) => it.project_id === 1)))
  expect(document.querySelector('.projswitch').textContent).toContain('All projects')
  expect(boardIds()).toEqual(['AL-1', 'AL-2', 'AL-3'])
})

// HZ-443: the board's Priority narrowing composes with the real project filter.
test('a project choice and a Priority chip together show only items matching both', async () => {
  projects = [ALPHA, BETA]
  setItems([
    { ...projectItem('AL-1', 1), priority: PRIORITY.HIGH },
    { ...projectItem('AL-2', 1), priority: PRIORITY.LOW },
    { ...projectItem('BE-1', 2), priority: PRIORITY.HIGH },
  ])
  try {
    const { findByText, getByRole } = render(<App />)
    await findByText('Item AL-1')
    chooseProject(getByRole, 'Alpha')
    fireEvent.click(within(getByRole('group', { name: 'Priority' })).getByRole('button', { name: PRIORITY.HIGH }))
    expect(boardIds()).toEqual(['AL-1'])
    chooseProject(getByRole, 'All projects')
    expect(boardIds()).toEqual(['AL-1', 'BE-1'])
  } finally {
    boardNarrowing._resetForTests()
  }
})

test('the New item dialog lists every enabled project and no disabled one', async () => {
  projects = [
    { ...ALPHA, repos: [{ repo: 'Org/alpha' }] },
    { ...BETA, repos: [{ repo: 'Org/beta' }] },
    { id: 3, name: 'Gamma', enabled: false, repos: [{ repo: 'Org/gamma' }] },
  ]
  setItems(FILTER_ITEMS)
  const { findByText, getByText } = render(<App />)
  await findByText('Item AL-1')
  fireEvent.click(getByText('+ New work item'))
  const projectField = [...document.querySelectorAll('.field')].find(
    (f) => f.querySelector('.field__label')?.textContent === 'Project',
  )
  expect([...projectField.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Alpha', 'Beta'])
})

// ---- HZ-317: narrow a project to some of its repos ----

const FIN = {
  id: 7,
  name: 'Fintekkers',
  enabled: true,
  repos: [
    { repo: 'FinTekkers/ledger-models', prefix: 'LM' },
    { repo: 'FinTekkers/ledger-service', prefix: 'LS' },
    { repo: 'FinTekkers/ui-service', prefix: 'UI' },
  ],
}
const OTHER = { id: 9, name: 'Other', enabled: true, repos: [{ repo: 'Org/a', prefix: 'OA' }, { repo: 'Org/b', prefix: 'OB' }] }
const repoItem = (id, projectId, repo) => ({ ...projectItem(id, projectId), repo })
// LM-1 first, so the tracker's fallback item is an LM one until LM is narrowed away.
const REPO_ITEMS = [
  repoItem('LM-1', 7, 'FinTekkers/ledger-models'),
  repoItem('LS-1', 7, 'FinTekkers/ledger-service'),
  repoItem('UI-1', 7, 'FinTekkers/ui-service'),
  repoItem('OA-1', 9, 'Org/a'),
  repoItem('OB-1', 9, 'Org/b'),
]
const chipPressed = (getByRole, name) => getByRole('button', { name }).getAttribute('aria-pressed')
const filterButton = () => document.querySelector('.projswitch')

test('toggling a repo chip narrows the board, tracker and approvals, and keeps the menu open', async () => {
  projects = [FIN, OTHER]
  setItems(REPO_ITEMS)
  const { findByText, getByRole, getByText } = render(<App />)
  await findByText('Item LM-1')
  chooseProject(getByRole, 'Fintekkers')
  fireEvent.click(getByText('Tracker'))
  expect(document.querySelector('.tracker__id').textContent).toBe('LM-1')
  fireEvent.click(getByText('Board'))

  fireEvent.click(filterButton())
  fireEvent.click(getByRole('button', { name: 'LM · ledger-models' }))
  expect(chipPressed(getByRole, 'LM · ledger-models')).toBe('false')
  expect(getByRole('group', { name: 'Repos in Fintekkers' })).toBeTruthy()
  expect(boardIds()).toEqual(['LS-1', 'UI-1'])
  expect(filterButton().getAttribute('aria-label')).toBe('Project filter: Fintekkers · LS, UI')

  fireEvent.click(getByRole('button', { name: 'Select all' }))
  expect(getByRole('group', { name: 'Repos in Fintekkers' })).toBeTruthy()
  expect(boardIds()).toEqual(['LM-1', 'LS-1', 'UI-1'])
  fireEvent.click(getByRole('button', { name: 'LM · ledger-models' }))
  fireEvent.click(document.querySelector('.usermenu__scrim'))

  fireEvent.click(document.querySelector('.pending-btn'))
  const drawer = document.querySelector('.drawer__list').textContent
  expect(drawer).toContain('LS-1')
  expect(drawer).not.toContain('LM-1')
  fireEvent.click(document.querySelector('.drawer__close'))
  fireEvent.click(getByText('Tracker'))
  expect(document.querySelector('.tracker__id').textContent).toBe('LS-1')
})

test('changing repo chips calls no api mutator and sends no write request', async () => {
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchSpy)
  projects = [FIN]
  setItems(REPO_ITEMS)
  const { findByText, getByRole } = render(<App />)
  await findByText('Item LM-1')
  chooseProject(getByRole, 'Fintekkers')
  fireEvent.click(filterButton())
  fireEvent.click(getByRole('button', { name: 'LM · ledger-models' }))
  fireEvent.click(getByRole('button', { name: 'UI · ui-service' }))
  fireEvent.click(getByRole('button', { name: 'LS · ledger-service' }))
  fireEvent.click(getByRole('button', { name: 'Select all' }))

  expect(fetchSpy.mock.calls.filter(([, opts]) => (opts?.method || 'GET').toUpperCase() !== 'GET')).toEqual([])
  for (const action of ['setProjectEnabled', 'setPaused', 'abandonItem', 'approveGate', 'moveItem', 'setPersona']) {
    expect(api[action], action).not.toHaveBeenCalled()
  }
})

test('the last selected chip stays pressed, so some items always stay visible', async () => {
  projects = [FIN]
  setItems(REPO_ITEMS)
  const { findByText, getByRole } = render(<App />)
  await findByText('Item LM-1')
  chooseProject(getByRole, 'Fintekkers')
  fireEvent.click(filterButton())
  fireEvent.click(getByRole('button', { name: 'LM · ledger-models' }))
  fireEvent.click(getByRole('button', { name: 'UI · ui-service' }))
  fireEvent.click(getByRole('button', { name: 'LS · ledger-service' }))
  expect(chipPressed(getByRole, 'LS · ledger-service')).toBe('true')
  expect(boardIds()).toEqual(['LS-1'])
})

test('the repo choice is kept per project and never carried across, even through All projects', async () => {
  projects = [FIN, OTHER]
  setItems(REPO_ITEMS)
  const { findByText, getByRole, queryByRole } = render(<App />)
  await findByText('Item LM-1')
  chooseProject(getByRole, 'Fintekkers')
  fireEvent.click(filterButton())
  fireEvent.click(getByRole('button', { name: 'LM · ledger-models' }))
  fireEvent.click(document.querySelector('.usermenu__scrim'))

  chooseProject(getByRole, 'Other')
  expect(filterButton().getAttribute('aria-label')).toBe('Project filter: Other')
  expect(boardIds()).toEqual(['OA-1', 'OB-1'])
  fireEvent.click(filterButton())
  expect(chipPressed(getByRole, 'OA · a')).toBe('true')
  expect(chipPressed(getByRole, 'OB · b')).toBe('true')
  fireEvent.click(document.querySelector('.usermenu__scrim'))

  chooseProject(getByRole, 'All projects')
  fireEvent.click(filterButton())
  expect(queryByRole('group', { name: /^Repos in/ })).toBeNull()
  fireEvent.click(document.querySelector('.usermenu__scrim'))
  expect(boardIds()).toEqual(['LM-1', 'LS-1', 'OA-1', 'OB-1', 'UI-1'])

  chooseProject(getByRole, 'Fintekkers')
  expect(filterButton().getAttribute('aria-label')).toBe('Project filter: Fintekkers · LS, UI')
  expect(boardIds()).toEqual(['LS-1', 'UI-1'])
})

test('a saved choice naming a disconnected repo falls back to all repos when the project is re-picked', async () => {
  localStorage.setItem('horizon.projectRepos', JSON.stringify({ 7: ['FinTekkers/ledger-service', 'FinTekkers/gone'] }))
  projects = [FIN]
  setItems(REPO_ITEMS)
  const { findByText, getByRole } = render(<App />)
  await findByText('Item LM-1')
  chooseProject(getByRole, 'Fintekkers')
  expect(filterButton().getAttribute('aria-label')).toBe('Project filter: Fintekkers')
  expect(filterButton().textContent).toContain('Fintekkers')
  fireEvent.click(filterButton())
  for (const name of ['LM · ledger-models', 'LS · ledger-service', 'UI · ui-service']) {
    expect(chipPressed(getByRole, name), name).toBe('true')
  }
  expect(boardIds()).toEqual(['LM-1', 'LS-1', 'UI-1'])
})

test('the repo choice survives a reload, and horizon.projectFilter keeps its plain id', async () => {
  projects = [FIN]
  setItems(REPO_ITEMS)
  const first = render(<App />)
  await first.findByText('Item LM-1')
  chooseProject(first.getByRole, 'Fintekkers')
  fireEvent.click(filterButton())
  fireEvent.click(first.getByRole('button', { name: 'LM · ledger-models' }))
  first.unmount()

  expect(localStorage.getItem('horizon.projectFilter')).toBe('7')
  const { findByText, getByRole } = render(<App />)
  await findByText('Item LS-1')
  expect(filterButton().getAttribute('aria-label')).toBe('Project filter: Fintekkers · LS, UI')
  expect(boardIds()).toEqual(['LS-1', 'UI-1'])
  fireEvent.click(filterButton())
  expect(chipPressed(getByRole, 'LM · ledger-models')).toBe('false')
})

test('a browser with only the old saved project value sees today\'s view, every repo selected', async () => {
  localStorage.setItem('horizon.projectFilter', '7')
  projects = [FIN]
  setItems(REPO_ITEMS)
  const { findByText, getByRole } = render(<App />)
  await findByText('Item LM-1')
  expect(filterButton().getAttribute('aria-label')).toBe('Project filter: Fintekkers')
  expect(document.querySelector('.projswitch__label').textContent).toBe('Fintekkers')
  expect(boardIds()).toEqual(['LM-1', 'LS-1', 'UI-1'])
  fireEvent.click(filterButton())
  for (const name of ['LM · ledger-models', 'LS · ledger-service', 'UI · ui-service']) {
    expect(chipPressed(getByRole, name), name).toBe('true')
  }
})

// HZ-711: the server's moves at Specialist agent implements — the item page
// offers only these.
const IMPLEMENT_MOVES = {
  approve: null,
  targets: [
    {
      key: 'change.define-outcome',
      label: 'Define the outcome',
      action: 'return',
      isDefault: false,
      redo: 'Redoes 12 steps, from “Define the outcome” to “Specialist agent implements”.',
      reapprovals: ['Approve & prioritize this work', 'Approve the high-level design', 'Review before execution'],
      stopsRunning: false,
    },
    {
      key: 'change.draft-plan',
      label: 'Draft implementation plan',
      action: 'return',
      isDefault: true,
      redo: 'Redoes 6 steps, from “Draft implementation plan” to “Specialist agent implements”.',
      reapprovals: ['Review before execution'],
      stopsRunning: false,
    },
    {
      key: 'change.implement',
      label: 'Specialist agent implements',
      action: 'retry',
      isDefault: false,
      redo: 'Runs “Specialist agent implements” again.',
      reapprovals: [],
      stopsRunning: false,
    },
  ],
  canAbandon: true,
  amend: null,
}

function atImplement(id, extra = {}) {
  return { ...itemAtClosingGate(id), cursor: IMPLEMENT_STEP_INDEX, currentStepKey: 'change.implement', moves: IMPLEMENT_MOVES, ...extra }
}

// HZ-711: Return to…, Retry and Abandon sit in the item's ⋯ menu.
async function chooseFromMenu(findByRole, id, name) {
  fireEvent.click(await findByRole('button', { name: `More actions for ${id}` }))
  fireEvent.click(await findByRole('menuitem', { name }))
}

// HZ-354: the abandon dialog lists what the item blocks, and the checked
// "Remove these links" box travels in the same abandon request.
test('abandoning with "Remove these links" checked sends removeDependentLinks: true', async () => {
  const id = 'AB-1'
  setItems([atImplement(id, { dependents: [{ id: 'AB-2', title: 'Waits on AB-1', abandoned: false }] })])
  window.history.pushState({}, '', `/${id.toLowerCase()}`)

  const { findByRole, getByText, getByRole } = render(<App />)
  await chooseFromMenu(findByRole, id, 'Abandon')
  expect(getByText('AB-2 — Waits on AB-1')).toBeTruthy()
  expect(getByRole('checkbox', { name: 'Remove these links' }).checked).toBe(true)
  fireEvent.change(document.querySelector('.composer__input'), { target: { value: 'superseded' } })
  fireEvent.click(document.querySelector('.composer__submit'))

  expect(api.abandonItem).toHaveBeenCalledWith(id, 'superseded', { removeDependentLinks: true })
})

// HZ-365: the rule-block banner's actions, wired through App to HZ-346's
// existing routes.
function ruleBlockedItem(id) {
  return atImplement(id, {
    ruleBlock: { rule: 'guardrail 6', needs: 'A ledger-models release.', runId: 9, blockedAt: '2026-10-08 14:02:11' },
    // HZ-711: where Amend the rule moves the item is the server's to say.
    moves: { ...IMPLEMENT_MOVES, amend: { action: 'retry', key: 'change.implement' } },
  })
}

test('Add dependency picks an existing item and links it with addDependency', async () => {
  setItems([ruleBlockedItem('RB-1'), { ...itemAtClosingGate('LM-42'), cursor: 2, title: 'Settlement field' }])
  window.history.pushState({}, '', '/rb-1')

  const { findByRole, getByRole } = render(<App />)
  fireEvent.click(await findByRole('button', { name: 'Add dependency' }))
  fireEvent.change(document.querySelector('#add-dependency-item'), { target: { value: 'LM-42' } })
  fireEvent.click(getByRole('dialog').querySelector('.composer__submit'))

  expect(api.addDependency).toHaveBeenCalledWith('RB-1', 'LM-42')
  await waitFor(() => expect(document.querySelector('#add-dependency-item')).toBeNull())
})

test('Add dependency → File a new upstream item creates it, then links the new item', async () => {
  api.createItem.mockResolvedValue({ id: 'LM-43', issue: 43, url: 'https://example.test/43' })
  setItems([ruleBlockedItem('RB-2')])
  window.history.pushState({}, '', '/rb-2')

  const { findByRole, getByRole } = render(<App />)
  fireEvent.click(await findByRole('button', { name: 'Add dependency' }))
  fireEvent.click(getByRole('button', { name: 'File a new upstream item' }))
  fireEvent.change(document.querySelector('.composer__panel input'), { target: { value: 'Add the settlement field' } })
  for (const textarea of document.querySelectorAll('.composer__panel textarea')) {
    fireEvent.change(textarea, { target: { value: 'Settlement needs its own proto field.' } })
  }
  fireEvent.click(getByRole('button', { name: /create/i }))

  await waitFor(() => expect(api.addDependency).toHaveBeenCalledWith('RB-2', 'LM-43'))
  expect(api.createItem).toHaveBeenCalledTimes(1)
})

test("Amend the rule sends the owner's ruling as the move the snapshot names, through moveItem", async () => {
  setItems([ruleBlockedItem('RB-3')])
  window.history.pushState({}, '', '/rb-3')

  const { findByRole, getByText } = render(<App />)
  fireEvent.click(await findByRole('button', { name: 'Amend the rule' }))
  expect(getByText(/not changed\. Needs your gate PIN/)).toBeTruthy()
  fireEvent.click(document.querySelector('.composer__submit'))
  expect(api.moveItem).not.toHaveBeenCalled() // a ruling is required

  fireEvent.change(document.querySelector('.composer__input'), { target: { value: 'a local shim is allowed' } })
  fireEvent.click(document.querySelector('.composer__submit'))
  expect(api.moveItem).toHaveBeenCalledWith('RB-3', {
    action: 'retry',
    to: 'change.implement',
    note: "Owner's ruling on the blocking rule: a local shim is allowed",
  })
})

// ---- HZ-389: a move is awaited; a failure keeps the Move dialog open ----
// HZ-711: the running step's Retry (was Request changes) opens the Move dialog.

function pausedAtImplement(id) {
  return atImplement(id, { paused: true })
}

const moveDialog = (getByRole) => getByRole('dialog', { name: /^Retry this step · / })
const noteBox = (getByRole) => within(moveDialog(getByRole)).getByRole('textbox', { name: 'Note for the step (optional)' })
const confirmRetry = (getByRole) => within(moveDialog(getByRole)).getByRole('button', { name: 'Retry' })

async function sendNote(findByRole, getByRole, text = 'try X') {
  fireEvent.click(await findByRole('button', { name: 'Retry' }))
  fireEvent.change(noteBox(getByRole), { target: { value: text } })
  fireEvent.click(confirmRetry(getByRole))
}

test('a note that goes through closes the Move dialog once the answer is in', async () => {
  let answer
  api.moveItem.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
  setItems([pausedAtImplement('SB-1')])
  window.history.pushState({}, '', '/sb-1')

  const { findByRole, getByRole, queryByRole } = render(<App />)
  await sendNote(findByRole, getByRole)
  expect(api.moveItem).toHaveBeenCalledWith('SB-1', { action: 'retry', to: 'change.implement', note: 'try X' })
  // Still open, and its confirm disabled, while the request is out.
  expect(confirmRetry(getByRole).disabled).toBe(true)
  await act(async () => answer({ ok: true }))
  await waitFor(() => expect(queryByRole('dialog')).toBeNull())
})

for (const [label, err, message] of [
  ['a 409', Object.assign(new Error('closed'), { status: 409 }), 'This item is closed.'],
  ['no answer', new Error('network'), 'The server did not answer — nothing was sent. Try again.'],
  ['a cancelled PIN retry', Object.assign(new Error('bad_human_gate_key'), { status: 401 }), 'Gate PIN incorrect or not entered — nothing was sent.'],
]) {
  test(`a note that fails with ${label} keeps the Move dialog open, its text kept, and shows why`, async () => {
    api.moveItem.mockRejectedValue(err)
    setItems([pausedAtImplement('SB-2')])
    window.history.pushState({}, '', '/sb-2')

    const { findByRole, getByRole } = render(<App />)
    await sendNote(findByRole, getByRole, 'keep me')
    const alert = await findByRole('alert')
    expect(alert.textContent).toBe(message)
    expect(moveDialog(getByRole).contains(alert)).toBe(true)
    expect(noteBox(getByRole).value).toBe('keep me')
    expect(confirmRetry(getByRole).disabled).toBe(false)
    expect(getItemsSnapshot('SB-2').paused).toBe(true)
  })
}

test('Amend the rule that fails keeps the composer open with the error', async () => {
  api.moveItem.mockRejectedValue(Object.assign(new Error('abandoned'), { status: 409 }))
  setItems([ruleBlockedItem('RB-9')])
  window.history.pushState({}, '', '/rb-9')

  const { findByRole } = render(<App />)
  fireEvent.click(await findByRole('button', { name: 'Amend the rule' }))
  fireEvent.change(document.querySelector('.composer__input'), { target: { value: 'a local shim is allowed' } })
  fireEvent.click(document.querySelector('.composer__submit'))
  expect((await findByRole('alert')).textContent).toBe('This item was abandoned.')
  expect(document.querySelector('.composer')).not.toBeNull()
})

function getItemsSnapshot(id) {
  return api.getItems().find((it) => it.id === id)
}

// ---- HZ-470: Kill and a return are awaited; a failure keeps the dialog open ----
// HZ-711: Restart phase is gone; returning to a phase's first step is
// Return to… in the ⋯ menu, through the Move dialog and moveItem. The Move
// dialog keeps its Cancel while the request is out, as a send-back always did;
// only Kill locks it.

const KILL_RESTART = [
  {
    name: 'Abandon',
    apiFn: 'abandonItem',
    open: async (findByRole, id) => chooseFromMenu(findByRole, id, 'Abandon'),
    calledWith: (id, text) => [id, text, { removeDependentLinks: false }],
    locksCancel: true,
    sent: (id, text) => ({ url: `/api/items/${id}/move`, body: { action: 'abandon', from: 'change.implement', note: text, removeDependentLinks: false } }),
  },
  {
    name: 'Return to…',
    apiFn: 'moveItem',
    open: async (findByRole, id) => {
      await chooseFromMenu(findByRole, id, 'Return to…')
      const dialog = await findByRole('dialog', { name: `Return to an earlier step · ${id}` })
      // The gate's default is preselected; the phase's first step is a choice.
      expect(within(dialog).getByRole('radio', { name: /Draft implementation plan/ }).checked).toBe(true)
      fireEvent.click(within(dialog).getByRole('radio', { name: /Define the outcome/ }))
      expect(within(dialog).getByText('Redoes 12 steps, from “Define the outcome” to “Specialist agent implements”.')).toBeTruthy()
      const reapprovals = within(dialog).getByRole('list', { name: 'Approvals given again' })
      expect([...reapprovals.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
        'Approve & prioritize this work',
        'Approve the high-level design',
        'Review before execution',
      ])
    },
    calledWith: (id, text) => [id, { action: 'return', to: 'change.define-outcome', note: text }],
    locksCancel: false,
    sent: (id, text) => ({ url: `/api/items/${id}/move`, body: { action: 'return', from: 'change.implement', to: 'change.define-outcome', note: text } }),
  },
]

// The real serverApi caches items only from its stream: a stand-in
// EventSource hands it the board, so moveItem and abandonItem find the item.
// Set directly, not stubbed, so the stream's own reconnect (its 45 s
// watchdog) still finds one after afterEach unstubs globals; the newest
// stand-in is the live stream.
let realStream = null
async function seedRealServerApi(real, board) {
  if (!realStream) {
    globalThis.EventSource = class {
      constructor() {
        realStream = this
      }
      addEventListener() {}
      close() {}
    }
    globalThis.EventSource.CLOSED = 2
    real.subscribe(() => {})
  }
  act(() => realStream.onmessage({ data: JSON.stringify({ items: board }) }))
}

function submitDialog(text) {
  fireEvent.change(document.querySelector('.composer__input'), { target: { value: text } })
  fireEvent.click(document.querySelector('.composer__submit'))
}

for (const dialog of KILL_RESTART) {
  test(`${dialog.name}: the dialog stays open with both buttons disabled until the request settles, then closes`, async () => {
    let answer
    api[dialog.apiFn].mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const id = 'KR-1'
    setItems([atImplement(id)])
    window.history.pushState({}, '', `/${id.toLowerCase()}`)

    const { findByRole } = render(<App />)
    await dialog.open(findByRole, id)
    submitDialog('superseded')
    expect(api[dialog.apiFn]).toHaveBeenCalledWith(...dialog.calledWith(id, 'superseded'))

    expect(document.querySelector('.composer')).not.toBeNull()
    expect(document.querySelector('.composer__submit').disabled).toBe(true)
    expect(document.querySelector('.composer__cancel').disabled).toBe(dialog.locksCancel)
    await act(async () => answer({ ok: true }))
    await waitFor(() => expect(document.querySelector('.composer')).toBeNull())
  })

  test(`${dialog.name}: a failed request shows why, keeps the text, and lets the owner send it again`, async () => {
    api[dialog.apiFn].mockRejectedValue(Object.assign(new Error('HTTP 500'), { status: 500 }))
    const id = 'KR-2'
    setItems([atImplement(id)])
    window.history.pushState({}, '', `/${id.toLowerCase()}`)

    const { findByRole } = render(<App />)
    await dialog.open(findByRole, id)
    submitDialog('keep me')
    const alert = await findByRole('alert')
    expect(alert.textContent).toBe('That did not go through — try again.')
    expect(alert.textContent).not.toContain('4729')
    expect(document.querySelector('.composer__input').value).toBe('keep me')
    expect(document.querySelector('.composer__submit').disabled).toBe(false)
    expect(document.querySelector('.composer__cancel').disabled).toBe(false)
    expect(api[dialog.apiFn]).toHaveBeenCalledTimes(1)

    fireEvent.click(document.querySelector('.composer__submit'))
    await waitFor(() => expect(api[dialog.apiFn]).toHaveBeenCalledTimes(2))
  })

  // Through the real serverApi: a cancelled or empty PIN dialog after the
  // server's 401 sends nothing more and says so (HZ-704).
  for (const [label, entered] of [
    ['cancelled', null],
    ['empty', ''],
  ]) {
    test(`${dialog.name}: a ${label} PIN dialog sends nothing more and shows "Gate PIN needed"`, async () => {
      const real = await vi.importActual('./api/serverApi')
      api[dialog.apiFn].mockImplementation(real[dialog.apiFn])
      const requester = vi.fn(async () => entered)
      real.setPinRequester(requester)
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({ error: 'human_gate_key_required' }) })
        .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', fetchSpy)
      const id = 'KR-3'
      setItems([atImplement(id)])
      await seedRealServerApi(real, items)
      window.history.pushState({}, '', `/${id.toLowerCase()}`)

      const { findByRole } = render(<App />)
      await dialog.open(findByRole, id)
      submitDialog('superseded')
      expect((await findByRole('alert')).textContent).toBe('Gate PIN needed')
      expect(requester).toHaveBeenCalledTimes(1)
      // Only the PIN-less first request went out, to the move route, naming
      // steps by key.
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const { url, body } = dialog.sent(id, 'superseded')
      expect(String(fetchSpy.mock.calls[0][0])).toBe(url)
      expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual(body)
      expect(fetchSpy.mock.calls[0][1].headers['x-horizon-csrf']).toBe('1')
      expect(fetchSpy.mock.calls[0][1].headers).not.toHaveProperty('x-human-key')
      expect(document.querySelector('.composer')).not.toBeNull()
      expect(localStorage.getItem('horizon_gate_pin')).toBeNull()
    })
  }
}
