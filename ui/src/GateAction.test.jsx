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
  approveGate: vi.fn(),
  requestChanges: vi.fn(),
  resolveConflicts: vi.fn(),
  forwardToAccept: vi.fn(),
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
