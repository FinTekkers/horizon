// HZ-216: an in-flight gate action — the pre-merge checks + merge at Accept
// the code — shows on the gate with its progress, and the gate's buttons stay
// disabled until it finishes. The state is the server's item.gateAction, so a
// push alone (an approval from WhatsApp or another tab) shows it, and a reload
// does too. A blocked result names the failing check and re-enables them.

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
  getDurationEstimates: () => null,
  getDeployBlock: () => null,
  approveGate: vi.fn(),
  requestChanges: vi.fn(),
  resolveConflicts: vi.fn(),
  forwardToAccept: vi.fn(),
  togglePause: vi.fn(),
  restartPhase: vi.fn(),
  setPersona: vi.fn(),
  setStepProvider: vi.fn(),
  logout: vi.fn(),
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
}))

import * as api from './api'
import App from './App'

function acceptItem(id, extra = {}) {
  return {
    id,
    title: 'An item at Accept the code',
    desc: '',
    metric: '',
    guardrails: '',
    priority: 'Medium',
    cursor: ACCEPT_INDEX,
    paused: false,
    rejected: false,
    pr: 7,
    pr_url: 'https://example.test/pr/7',
    pr_mergeable: true,
    events: [],
    stepOutputs: {},
    activeRun: null,
    conflictRun: null,
    gateAction: null,
    ...extra,
  }
}

const ago = (ms) => new Date(Date.now() - ms).toISOString()
const running = (extra = {}) => ({
  kind: 'premerge',
  state: 'running',
  detail: 'running checks on main + PR #7',
  since: ago(192_000),
  deadline: new Date(Date.now() + 600_000).toISOString(),
  finishedAt: null,
  reason: null,
  failingCheck: null,
  startedBeforeRestart: false,
  ...extra,
})
const finished = (extra) => ({ ...running(), finishedAt: new Date().toISOString(), ...extra })

function pushItems(next) {
  act(() => {
    items = next
    listeners.forEach((fn) => fn())
  })
}

async function openItem(item) {
  items = [item]
  window.history.pushState({}, '', `/${item.id.toLowerCase()}`)
  const view = render(<App />)
  await view.findByText('Accept the code')
  // The store subscription is a passive effect: a push before it lands is lost.
  await waitFor(() => expect(listeners.size).toBeGreaterThan(0))
  return view
}

const button = (name) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === name) || null
const GATE_BUTTONS = ['Approve', 'Approve with comments', 'Send back with feedback']
const status = () => document.querySelector('.gate-action-status')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  items = []
  listeners.clear()
})

test('a running pre-merge check shows its label and elapsed time and disables every gate button', async () => {
  // The conflict and forward controls are on screen too, so their disabling
  // is asserted against the same running action.
  await openItem(acceptItem('GA-1', { gateAction: running(), pr_mergeable: false, reviewRejected: true }))

  expect(status().textContent).toMatch(/^Merging: running checks on main \+ PR #7 · 3m 1\ds/)
  for (const name of GATE_BUTTONS) expect(button(name).disabled, name).toBe(true)
  expect(button('Resolve conflicts…').disabled).toBe(true)
  expect(button('Forward to Accept the code').disabled).toBe(true)
})

test('a push alone — an approval from WhatsApp or another tab — disables the buttons, with no click here', async () => {
  await openItem(acceptItem('GA-2'))
  for (const name of GATE_BUTTONS) expect(button(name).disabled, name).toBe(false)
  expect(status()).toBeNull()

  pushItems([acceptItem('GA-2', { gateAction: running() })])
  for (const name of GATE_BUTTONS) expect(button(name).disabled, name).toBe(true)
  expect(status().textContent).toMatch(/Merging: running checks on main \+ PR #7/)
  expect(api.approveGate).not.toHaveBeenCalled()
})

test('a blocked result names the failing check and re-enables the buttons', async () => {
  await openItem(acceptItem('GA-3', { gateAction: running() }))
  pushItems([
    acceptItem('GA-3', {
      gateAction: finished({ state: 'blocked', failingCheck: 'npm test --silent', reason: 'pre-merge checks failed: npm test --silent' }),
    }),
  ])
  expect(status().textContent).toMatch(/Blocked: pre-merge check npm test --silent failed/)
  for (const name of GATE_BUTTONS) expect(button(name).disabled, name).toBe(false)
})

test('a merged result shows the merge and leaves no gate buttons once the gate advances', async () => {
  await openItem(acceptItem('GA-4', { gateAction: running() }))
  pushItems([acceptItem('GA-4', { cursor: ACCEPT_INDEX + 1, gateAction: finished({ state: 'merged' }) })])
  expect(status().textContent).toBe('Merged PR #7')
  expect(button('Approve')).toBeNull()
})

test('a merge whose gate advance was refused does not leave the gate disabled', async () => {
  await openItem(acceptItem('GA-4b', { gateAction: running() }))
  pushItems([acceptItem('GA-4b', { gateAction: finished({ state: 'merged' }) })])
  for (const name of GATE_BUTTONS) expect(button(name).disabled, name).toBe(false)
})

test('a run whose lease ran out re-enables the gate and says so', async () => {
  await openItem(acceptItem('GA-5', { gateAction: running() }))
  pushItems([acceptItem('GA-5', { gateAction: finished({ state: 'interrupted', reason: 'Horizon restarted while this ran' }) })])
  expect(status().textContent).toMatch(/Checks did not finish/)
  for (const name of GATE_BUTTONS) expect(button(name).disabled, name).toBe(false)
})

test('the Approve click disables the buttons until the request settles, and a 502 with no push re-enables them', async () => {
  let answer
  api.approveGate.mockReturnValue(new Promise((resolve) => (answer = resolve)))
  const { findByText } = await openItem(acceptItem('GA-6'))

  fireEvent.click(button('Approve'))
  await findByText('Approve this gate?')
  fireEvent.click(document.querySelector('.composer__submit'))
  await waitFor(() => expect(button('Approve').disabled).toBe(true))
  expect(api.approveGate).toHaveBeenCalledTimes(1)

  await act(async () => answer({ error: 'pre-merge checks failed: npm test', premerge: true }))
  for (const name of GATE_BUTTONS) expect(button(name).disabled, name).toBe(false)
})

test('an item from an older payload with no gateAction key renders enabled buttons', async () => {
  const item = acceptItem('GA-7')
  delete item.gateAction
  await openItem(item)
  for (const name of GATE_BUTTONS) expect(button(name).disabled, name).toBe(false)
  expect(status()).toBeNull()
})

// HZ-231: Retry beside the reason of a run that timed out, was interrupted or
// failed is Accept relabelled — same confirm dialog, same request, same lock.

async function openBoard(item) {
  items = [item]
  window.history.pushState({}, '', '/')
  const view = render(<App />)
  await view.findByText('Accept the code')
  await waitFor(() => expect(listeners.size).toBeGreaterThan(0))
  return view
}

const retryButton = () => status()?.querySelector('button') || null
const dialogTitle = () => document.querySelector('.composer__title')?.textContent ?? null
const timedOut = () => finished({ state: 'timed_out', reason: 'pre-merge checks did not finish: timed out' })

test('Retry opens the same confirm dialog and sends the request Accept sends', async () => {
  api.approveGate.mockResolvedValue({ ok: true })
  const { findByText } = await openItem(acceptItem('GA-8'))

  fireEvent.click(button('Approve'))
  await findByText('Approve this gate?')
  const acceptDialog = dialogTitle()
  fireEvent.click(document.querySelector('.composer__submit'))
  await waitFor(() => expect(api.approveGate).toHaveBeenCalledTimes(1))
  const acceptArgs = api.approveGate.mock.calls[0]
  api.approveGate.mockClear()

  pushItems([acceptItem('GA-8', { gateAction: timedOut() })])
  await waitFor(() => expect(retryButton()?.disabled).toBe(false))
  expect(retryButton().textContent).toBe('Retry')
  fireEvent.click(retryButton())
  await findByText('Approve this gate?')
  expect(dialogTitle()).toBe(acceptDialog)
  fireEvent.click(document.querySelector('.composer__submit'))
  await waitFor(() => expect(api.approveGate).toHaveBeenCalledTimes(1))
  expect(api.approveGate.mock.calls[0]).toEqual(acceptArgs)
})

test('Tracker: a double click on Retry and confirm starts one run; the gate stays locked and the reason stays until a running push', async () => {
  let answer
  api.approveGate.mockReturnValue(new Promise((resolve) => (answer = resolve)))
  const { findByText } = await openItem(acceptItem('GA-9', { gateAction: timedOut() }))

  fireEvent.click(retryButton())
  fireEvent.click(retryButton())
  await findByText('Approve this gate?')
  const submit = document.querySelector('.composer__submit')
  fireEvent.click(submit)
  fireEvent.click(submit)
  await waitFor(() => expect(retryButton().disabled).toBe(true))
  for (const name of GATE_BUTTONS) expect(button(name).disabled, name).toBe(true)
  fireEvent.click(retryButton())
  fireEvent.click(button('Approve'))
  expect(document.querySelector('.composer__submit')).toBeNull()
  expect(api.approveGate).toHaveBeenCalledTimes(1)
  // The failure stays beside the disabled Retry while the request is pending.
  expect(status().textContent).toMatch(/Checks did not finish/)
  expect(status().textContent).toMatch(/pre-merge checks did not finish: timed out/)

  pushItems([acceptItem('GA-9', { gateAction: running() })])
  expect(status().textContent).toMatch(/^Merging:/)
  expect(status().textContent).not.toMatch(/timed out/)
  expect(retryButton()).toBeNull()
  await act(async () => answer({ ok: true }))
  expect(api.approveGate).toHaveBeenCalledTimes(1)
})

test('Board card: a double click on Retry and confirm starts one run, with Retry disabled until it settles', async () => {
  let answer
  api.approveGate.mockReturnValue(new Promise((resolve) => (answer = resolve)))
  const { findByText } = await openBoard(acceptItem('GA-10', { gateAction: timedOut() }))

  fireEvent.click(retryButton())
  fireEvent.click(retryButton())
  await findByText('Approve this gate?')
  const submit = document.querySelector('.composer__submit')
  fireEvent.click(submit)
  fireEvent.click(submit)
  await waitFor(() => expect(retryButton().disabled).toBe(true))
  fireEvent.click(retryButton())
  expect(document.querySelector('.composer__submit')).toBeNull()
  expect(api.approveGate).toHaveBeenCalledTimes(1)
  expect(status().textContent).toMatch(/pre-merge checks did not finish: timed out/)

  await act(async () => answer({ ok: true }))
  expect(retryButton().disabled).toBe(false)
  expect(api.approveGate).toHaveBeenCalledTimes(1)
})

test.each([
  ['{ ok: false }', { ok: false }],
  ['a 409', { error: 'a gate action is already running', status: 409 }],
])('a Retry that comes back with %s keeps the failure and re-enables Retry', async (_, result) => {
  api.approveGate.mockResolvedValue(result)
  const { findByText } = await openItem(acceptItem('GA-11', { gateAction: timedOut() }))

  fireEvent.click(retryButton())
  await findByText('Approve this gate?')
  fireEvent.click(document.querySelector('.composer__submit'))
  await waitFor(() => expect(api.approveGate).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(retryButton().disabled).toBe(false))
  expect(status().textContent).toMatch(/Checks did not finish/)
  expect(status().textContent).toMatch(/pre-merge checks did not finish: timed out/)
})

test('cancelling the dialog sends nothing, keeps the failure, and the next Retry asks again', async () => {
  const { findByText } = await openItem(acceptItem('GA-12', { gateAction: timedOut() }))

  fireEvent.click(retryButton())
  await findByText('Approve this gate?')
  fireEvent.click(document.querySelector('.composer__cancel'))
  expect(dialogTitle()).toBeNull()
  expect(api.approveGate).not.toHaveBeenCalled()
  expect(retryButton().disabled).toBe(false)
  expect(status().textContent).toMatch(/pre-merge checks did not finish: timed out/)

  fireEvent.click(retryButton())
  await findByText('Approve this gate?')
  expect(api.approveGate).not.toHaveBeenCalled()
})

test('nothing retries on its own: time passing and another timed_out push send no request', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    await openItem(acceptItem('GA-13', { gateAction: timedOut() }))
    await act(async () => vi.advanceTimersByTime(10 * 60_000))
    pushItems([acceptItem('GA-13', { gateAction: timedOut() })])
    await act(async () => vi.advanceTimersByTime(10 * 60_000))
    expect(retryButton().textContent).toBe('Retry')
    expect(api.approveGate).not.toHaveBeenCalled()
    expect(dialogTitle()).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
