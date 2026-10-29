// HZ-642: the Approve & file choice reaches the approval. Picking "Off for
// these items" and approving through the confirm dialog sends 'off' to
// api.approveGate; approving untouched sends 'default'.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor, screen } from '@testing-library/react'
import { APPROVE_FILE_GATE_INDEX } from '../../domain/js/lifecycle.js'

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
  getPlanProgress: () => [],
  approveGate: vi.fn(async () => ({ ok: true, closed: false })),
  requestChanges: vi.fn(),
  getRestartSent: () => null,
  resolveConflicts: vi.fn(),
  forwardToAccept: vi.fn(),
  setPaused: vi.fn(),
  restartPhase: vi.fn(),
  setPersona: vi.fn(),
  setStepProvider: vi.fn(),
  getPlanDraft: vi.fn(async () => null),
  savePlanDraft: vi.fn(),
  logout: vi.fn(),
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
}))

import * as api from './api'
import App from './App'

const plan = (id) => ({
  id,
  title: 'Retire the FIX gateway',
  kind: 'plan',
  desc: '',
  metric: '',
  guardrails: '',
  priority: 'High',
  cursor: APPROVE_FILE_GATE_INDEX,
  paused: false,
  rejected: false,
  events: [],
  stepOutputs: {},
  activeRun: null,
  projectAutopilot: 'on',
})

async function openPlan(item) {
  items = [item]
  window.history.pushState({}, '', `/${item.id.toLowerCase()}`)
  render(<App />)
  await screen.findByRole('combobox', { name: 'Autopilot for filed items' })
}

async function approveFromGate() {
  fireEvent.click(screen.getByRole('button', { name: 'Approve & file' }))
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() => expect(api.approveGate).toHaveBeenCalledTimes(1))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  items = []
  listeners.clear()
})

test('picking "Off for these items" then approving sends filedAutopilot: off', async () => {
  await openPlan(plan('PL-21'))
  const select = screen.getByRole('combobox', { name: 'Autopilot for filed items' })
  const off = [...select.options].find((o) => o.textContent === 'Off for these items')
  fireEvent.change(select, { target: { value: off.value } })
  await approveFromGate()
  expect(api.approveGate).toHaveBeenCalledWith('PL-21', undefined, { filedAutopilot: 'off' })
})

test('approving without touching the select sends filedAutopilot: default', async () => {
  await openPlan(plan('PL-22'))
  await approveFromGate()
  expect(api.approveGate).toHaveBeenCalledWith('PL-22', undefined, { filedAutopilot: 'default' })
})
