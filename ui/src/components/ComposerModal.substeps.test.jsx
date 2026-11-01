// HZ-540 metric 2 (UI half): a send-back from a gate offers the item's
// sub-steps in the "Send back to" picker, each under its step, and picking
// one sends the (anchor, sub-step) pair. A step pick still sends just its
// index. Through App, so the picker's options are the ones App builds.

import { afterEach, expect, test, vi } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { STEPS, ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } from '../../../domain/js/lifecycle.js'
import ITEM from './fixtures/substep-item.json'

let items = []
const listeners = new Set()

vi.mock('../api', () => ({
  subscribe: (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  getItems: () => items,
  getCurrentUser: vi.fn(async () => ({ name: 'Test User', initials: 'TU', email: 'test@example.com' })),
  getSync: () => ({ connected: false }),
  getProjects: () => [],
  getActiveProjectId: () => null,
  // HZ-661: no board frame yet, so the first-project screen stays off.
  hasSnapshot: () => false,
  getFarm: () => null,
  getDurationEstimates: () => null,
  getDeployBlock: () => null,
  getPlanProgress: () => [],
  approveGate: vi.fn(),
  requestChanges: vi.fn(async () => ({ ok: true })),
  getRestartSent: () => null,
  setPaused: vi.fn(),
  restartPhase: vi.fn(),
  setPersona: vi.fn(),
  setStepProvider: vi.fn(),
  abandonItem: vi.fn(),
  logout: vi.fn(),
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: () => () => {},
  hasGatePin: () => true,
}))

import * as api from '../api'
import App from '../App'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
})

// The served item, back at Accept the code and at no sub-step.
// No repo, so the gate shows no screenshot panel.
const AT_ACCEPT = { ...ITEM, cursor: ACCEPT_GATE_INDEX, substep_cursor: null, substep: null, stepOutputs: {}, repo: null }

async function openSendBack(item) {
  items = [item]
  window.history.pushState({}, '', `/${item.id.toLowerCase()}`)
  const view = render(<App />)
  fireEvent.click(await view.findByRole('button', { name: 'Send back with feedback' }))
  return view
}

const optionTexts = (select) => [...select.options].map((o) => o.textContent)

test('the picker lists each sub-step right under its step', async () => {
  const { getByLabelText } = await openSendBack(AT_ACCEPT)
  const texts = optionTexts(getByLabelText('Send back to'))
  for (const sub of ITEM.substeps) {
    const at = texts.findIndex((t) => t.endsWith(`↳ ${sub.label}`))
    expect(at).toBeGreaterThan(0)
    expect(texts.slice(0, at).findLast((t) => !t.includes('↳'))).toBe(STEPS[sub.anchor].label)
  }
})

test('picking a sub-step sends the (anchor, sub-step) pair', async () => {
  const { getByLabelText } = await openSendBack(AT_ACCEPT)
  fireEvent.change(getByLabelText('Send back to'), { target: { value: `${IMPLEMENT_STEP_INDEX}:impl-audit` } })
  fireEvent.change(document.querySelector('.composer__input'), { target: { value: 'tighten the audit' } })
  fireEvent.click(document.querySelector('.composer__submit'))
  await waitFor(() =>
    expect(api.requestChanges).toHaveBeenCalledWith(ITEM.id, STEPS[ACCEPT_GATE_INDEX].label, 'tighten the audit', IMPLEMENT_STEP_INDEX, 'impl-audit'),
  )
})

test('picking a step still sends only its index', async () => {
  const { getByLabelText } = await openSendBack(AT_ACCEPT)
  fireEvent.change(getByLabelText('Send back to'), { target: { value: String(IMPLEMENT_STEP_INDEX) } })
  fireEvent.change(document.querySelector('.composer__input'), { target: { value: 'redo it' } })
  fireEvent.click(document.querySelector('.composer__submit'))
  await waitFor(() => expect(api.requestChanges).toHaveBeenCalledWith(ITEM.id, STEPS[ACCEPT_GATE_INDEX].label, 'redo it', IMPLEMENT_STEP_INDEX))
})

test('an item without sub-steps gets no sub-step option', async () => {
  const { getByLabelText } = await openSendBack({ ...AT_ACCEPT, substeps: undefined })
  expect(optionTexts(getByLabelText('Send back to')).some((t) => t.includes('↳'))).toBe(false)
})
