// HZ-62: approving the gate that closes an item must return the user to the
// board; approving any earlier gate must not. Both approve call sites
// (App.jsx's ConfirmGateDialog and the "Approve with comments" composer)
// are covered, plus the guardrail that a failed approval never navigates.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { STEPS } from '../../domain/js/lifecycle.js'

const CLOSING_GATE_INDEX = STEPS.length - 1
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
  getFarm: () => null,
  getDurationEstimates: () => null,
  approveGate: vi.fn(),
  requestChanges: vi.fn(),
  togglePause: vi.fn(),
  restartPhase: vi.fn(),
  setPersona: vi.fn(),
  abandonItem: vi.fn(),
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  items = []
  projects = []
  listeners.clear()
  localStorage.removeItem('horizon.projectFilter')
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
  expect(calls.filter((c) => /\/activate|\/enabled|\/pause|\/abandon|\/phases\/[^/]+\/restart/.test(c.url))).toEqual([])
  for (const action of ['setProjectEnabled', 'togglePause', 'abandonItem', 'restartPhase', 'approveGate', 'requestChanges']) {
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
