// Resolve conflicts: the button opens a dialog that explains what will happen,
// a confirm starts exactly ONE request however often it is pressed, and the
// result is reported. Repeated clicks used to start one resolver per click in
// the same workspace (HZ-125, HZ-157).

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { STEPS } from '../../domain/js/lifecycle.js'

const ACCEPT_INDEX = STEPS.findIndex((s) => s.label === 'Accept the code')

let items = []
const listeners = new Set()

vi.mock('./api', () => ({
  subscribe: (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  getItems: () => items,
  getCurrentUser: vi.fn(async () => ({ name: 'Test User', initials: 'TU', email: 'test@example.com' })),
  getSync: () => ({ connected: false }),
  getProjects: () => [],
  getActiveProjectId: () => null,
  getFarm: () => null,
  approveGate: vi.fn(),
  requestChanges: vi.fn(),
  resolveConflicts: vi.fn(),
  togglePause: vi.fn(),
  restartPhase: vi.fn(),
  setPersona: vi.fn(),
  logout: vi.fn(),
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
}))

import * as api from './api'
import App from './App'

function conflictedItem(id) {
  return {
    id,
    title: 'An item whose PR conflicts with main',
    desc: '',
    metric: '',
    guardrails: '',
    priority: 'Medium',
    cursor: ACCEPT_INDEX,
    paused: false,
    rejected: false,
    pr: 7,
    pr_url: 'https://example.test/pr/7',
    pr_mergeable: false,
    events: [],
    stepOutputs: {},
    activeRun: null,
  }
}

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

async function openItem(id) {
  items = [conflictedItem(id)]
  listeners.forEach((fn) => fn())
  window.history.pushState({}, '', `/${id.toLowerCase()}`)
  const view = render(<App />)
  await view.findByText(/has merge conflicts with main/)
  return view
}

const conflictButton = () => document.querySelector('.step-card__conflict button')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  items = []
  listeners.clear()
})

test('the button opens a dialog explaining the steps, and nothing starts until it is confirmed', async () => {
  const { findByText } = await openItem('RC-1')
  fireEvent.click(conflictButton())

  await findByText('Resolve merge conflicts?')
  const steps = [...document.querySelectorAll('.resolve-dialog__steps li')].map((li) => li.textContent)
  expect(steps).toHaveLength(5)
  expect(steps[0]).toMatch(/Merge the latest main/)
  expect(document.querySelector('.resolve-dialog__body').textContent).toMatch(/3 to 10 minutes/)
  expect(api.resolveConflicts).not.toHaveBeenCalled()

  fireEvent.click(document.querySelector('.composer__cancel'))
  await waitFor(() => expect(document.querySelector('.resolve-dialog')).toBeNull())
  expect(api.resolveConflicts).not.toHaveBeenCalled()
})

test('confirming starts exactly one request, however many times it is pressed', async () => {
  const pending = deferred()
  api.resolveConflicts.mockReturnValue(pending.promise)
  const { findByText } = await openItem('RC-2')

  fireEvent.click(conflictButton())
  await findByText('Resolve merge conflicts?')
  const confirm = document.querySelector('.composer__submit')
  fireEvent.click(confirm)
  fireEvent.click(confirm)
  fireEvent.keyDown(window, { key: 'Enter' })

  await findByText('Resolving conflicts…')
  expect(api.resolveConflicts).toHaveBeenCalledTimes(1)
  expect(api.resolveConflicts).toHaveBeenCalledWith('RC-2')

  // Closing and reopening while it runs shows progress, not a second confirm.
  fireEvent.click(document.querySelector('.composer__cancel'))
  await waitFor(() => expect(conflictButton().textContent).toMatch(/Resolving conflicts…/))
  fireEvent.click(conflictButton())
  await findByText('Resolving conflicts…')
  expect(document.querySelector('.composer__submit')).toBeNull()
  expect(api.resolveConflicts).toHaveBeenCalledTimes(1)

  pending.resolve({ ok: true, resolved: true })
  await findByText('Conflicts resolved')
})

test('an escalation is reported as a send-back to the implement agent', async () => {
  api.resolveConflicts.mockResolvedValue({ ok: true, resolved: false, escalated: true })
  const { findByText } = await openItem('RC-3')
  fireEvent.click(conflictButton())
  await findByText('Resolve merge conflicts?')
  fireEvent.click(document.querySelector('.composer__submit'))
  await findByText('Sent back to the implement agent')
})

test('a request that could not start says nothing changed', async () => {
  api.resolveConflicts.mockResolvedValue({ ok: false, error: 'farm_unavailable' })
  const { findByText } = await openItem('RC-4')
  fireEvent.click(conflictButton())
  await findByText('Resolve merge conflicts?')
  fireEvent.click(document.querySelector('.composer__submit'))
  await findByText('Couldn’t start conflict resolution')
  expect(document.querySelector('.resolve-dialog__result').textContent).toMatch(/farm unavailable/)
})
