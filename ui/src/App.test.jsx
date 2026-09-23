// HZ-62: approving the gate that closes an item must return the user to the
// board; approving any earlier gate must not. Both approve call sites
// (App.jsx's ConfirmGateDialog and the "Approve with comments" composer)
// are covered, plus the guardrail that a failed approval never navigates.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { STEPS } from './domain/lifecycle'

const CLOSING_GATE_INDEX = STEPS.length - 1
const CLOSING_GATE_LABEL = STEPS[CLOSING_GATE_INDEX].label

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
  listeners.clear()
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
