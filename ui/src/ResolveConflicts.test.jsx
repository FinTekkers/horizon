// Resolve conflicts (HZ-188): the button opens a dialog that explains what
// will happen, a confirm starts exactly ONE request however often it is
// pressed, and the outcome is reported. Repeated clicks used to start one
// resolver per click in the same workspace (HZ-125, HZ-157). Running state
// comes from the server's item.conflictRun, so a reload (or another tab)
// still shows a run in progress and the button stays disabled until it ends.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
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

function conflictedItem(id, extra = {}) {
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
    conflictRun: null,
    ...extra,
  }
}

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

// What the server's notifyChange() push does: replace the items snapshot.
function pushItems(next) {
  act(() => {
    items = next
    listeners.forEach((fn) => fn())
  })
}

async function openItem(id, extra) {
  items = [conflictedItem(id, extra)]
  listeners.forEach((fn) => fn())
  window.history.pushState({}, '', `/${id.toLowerCase()}`)
  const view = render(<App />)
  await view.findByText(/has merge conflicts with main/)
  return view
}

const conflictButton = () => document.querySelector('.step-card__conflict .btn-gate-reject')
const progressButton = () => document.querySelector('.step-card__conflict .btn-gate-feedback')
const dialogText = () => document.querySelector('.resolve-dialog').textContent

async function confirmFrom(findByText) {
  fireEvent.click(conflictButton())
  await findByText('Resolve merge conflicts?')
  fireEvent.click(document.querySelector('.composer__submit'))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  items = []
  listeners.clear()
})

test('the button opens a dialog explaining the steps, and Cancel starts nothing', async () => {
  const { findByText } = await openItem('RC-1')
  expect(conflictButton().textContent).toBe('Resolve conflicts…')
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

test('a confirm, a double-click and Enter together start exactly one request', async () => {
  const pending = deferred()
  api.resolveConflicts.mockReturnValue(pending.promise)
  const { findByText } = await openItem('RC-2')

  fireEvent.click(conflictButton())
  await findByText('Resolve merge conflicts?')
  const confirm = document.querySelector('.composer__submit')
  fireEvent.click(confirm)
  fireEvent.click(confirm)
  fireEvent.keyDown(window, { key: 'Enter' })

  await findByText('Resolving conflicts…', { selector: '.composer__title' })
  expect(api.resolveConflicts).toHaveBeenCalledTimes(1)
  expect(api.resolveConflicts).toHaveBeenCalledWith('RC-2')
  expect(dialogText()).toMatch(/Don’t start it again/)

  // Closing keeps it running: the button is disabled, and View progress
  // reopens progress — never a second Confirm.
  fireEvent.click(document.querySelector('.composer__cancel'))
  await waitFor(() => expect(conflictButton().disabled).toBe(true))
  expect(conflictButton().textContent).toBe('Resolving conflicts…')
  fireEvent.click(progressButton())
  await findByText('Resolving conflicts…', { selector: '.composer__title' })
  expect(document.querySelector('.composer__submit')).toBeNull()
  expect(api.resolveConflicts).toHaveBeenCalledTimes(1)

  pending.resolve({ ok: true, resolved: true })
  await findByText('Conflicts resolved')
  expect(conflictButton().disabled).toBe(false)
})

test('Enter alone confirms once', async () => {
  api.resolveConflicts.mockResolvedValue({ ok: true, resolved: true })
  const { findByText } = await openItem('RC-3')
  fireEvent.click(conflictButton())
  await findByText('Resolve merge conflicts?')
  fireEvent.keyDown(window, { key: 'Enter' })
  await findByText('Conflicts resolved')
  expect(api.resolveConflicts).toHaveBeenCalledTimes(1)
})

test('an escalation is reported as a send-back to the implement agent, with the reason', async () => {
  api.resolveConflicts.mockResolvedValue({
    ok: true,
    resolved: false,
    escalated: true,
    reason: 'too many conflicted files or lines for a scoped fix — needs a full implement cycle',
  })
  const { findByText } = await openItem('RC-4')
  await confirmFrom(findByText)
  await findByText('Sent back to the implement agent')
  expect(dialogText()).toMatch(/too many conflicted files or lines/)
})

test('a request that could not start says nothing changed, with the error', async () => {
  api.resolveConflicts.mockResolvedValue({ error: 'not_conflicted' })
  const { findByText } = await openItem('RC-5')
  await confirmFrom(findByText)
  await findByText('Couldn’t start conflict resolution')
  expect(document.querySelector('.resolve-dialog__result').textContent).toMatch(/Nothing was changed \(not conflicted\)/)
})

test('a network failure (no reply) is reported as could not start', async () => {
  api.resolveConflicts.mockResolvedValue({ ok: false })
  const { findByText } = await openItem('RC-6')
  await confirmFrom(findByText)
  await findByText('Couldn’t start conflict resolution')
})

test('after a reload, an item whose run is still going shows a disabled button and progress, not a Confirm', async () => {
  const { findByText } = await openItem('RC-7', { conflictRun: { state: 'running', since: '2026-10-01T14:02:11Z', reason: null } })

  expect(conflictButton().disabled).toBe(true)
  expect(conflictButton().textContent).toBe('Resolving conflicts…')
  fireEvent.click(progressButton())
  await findByText('Resolving conflicts…', { selector: '.composer__title' })
  expect(document.querySelector('.composer__submit')).toBeNull()
  expect(api.resolveConflicts).not.toHaveBeenCalled()

  // The run ends with a send-back: the dialog shows the server's reason.
  pushItems([
    conflictedItem('RC-7', { conflictRun: { state: 'escalated', since: '2026-10-01T14:09:00Z', reason: 'the scoped review of the resolution rejected it' } }),
  ])
  await findByText('Sent back to the implement agent')
  expect(dialogText()).toMatch(/scoped review of the resolution rejected it/)
  expect(conflictButton().disabled).toBe(false)
})

test('the button re-enables when the server reports the run resolved', async () => {
  const { findByText } = await openItem('RC-8', { conflictRun: { state: 'running', since: '2026-10-01T14:02:11Z', reason: null } })
  expect(conflictButton().disabled).toBe(true)
  fireEvent.click(progressButton())
  await findByText('Resolving conflicts…', { selector: '.composer__title' })

  pushItems([conflictedItem('RC-8', { conflictRun: { state: 'resolved', since: '2026-10-01T14:05:00Z', reason: null } })])
  await findByText('Conflicts resolved')
  expect(conflictButton().disabled).toBe(false)
  expect(conflictButton().textContent).toBe('Resolve conflicts…')
})

test('a resolve_in_progress answer shows the run that is already going instead of an error', async () => {
  api.resolveConflicts.mockResolvedValue({ error: 'resolve_in_progress' })
  const { findByText } = await openItem('RC-9')
  fireEvent.click(conflictButton())
  await findByText('Resolve merge conflicts?')
  // Another tab started it a moment ago; the server push lands first.
  pushItems([conflictedItem('RC-9', { conflictRun: { state: 'running', since: '2026-10-01T14:02:11Z', reason: null } })])
  await findByText('Resolving conflicts…', { selector: '.composer__title' })
  expect(api.resolveConflicts).not.toHaveBeenCalled()
})

test('farmd refusing because another writer owns the item is reported with its reason', async () => {
  api.resolveConflicts.mockResolvedValue({ error: 'resolve_in_progress' })
  const { findByText } = await openItem('RC-10')
  await confirmFrom(findByText)
  pushItems([
    conflictedItem('RC-10', {
      conflictRun: { state: 'failed', since: '2026-10-01T14:02:11Z', reason: "another run is still using this item's workspace" },
    }),
  ])
  await findByText('Couldn’t start conflict resolution')
  expect(dialogText()).toMatch(/another run is still using this item's workspace/)
})

test('an item from an older payload with no conflictRun key renders an enabled button', async () => {
  const item = conflictedItem('RC-11')
  delete item.conflictRun
  items = [item]
  window.history.pushState({}, '', '/rc-11')
  const { findByText } = render(<App />)
  await findByText(/has merge conflicts with main/)
  expect(conflictButton().disabled).toBe(false)
  expect(progressButton()).toBeNull()
})
