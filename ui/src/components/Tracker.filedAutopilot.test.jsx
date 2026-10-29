// HZ-642 metric 4 and guardrail 1: the Plan's Approve & file card shows one
// "Autopilot for filed items" select while it awaits approval, defaulting to
// the project's mode, and no other step (nor the gate once past it, nor any
// items-table row) has one.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(),
  getPlanDraft: vi.fn(async () => null),
  savePlanDraft: vi.fn(),
}))

import Tracker from './Tracker'
import { APPROVE_FILE_GATE_INDEX, FILE_ITEMS_STEP_INDEX, PLAN_DRAFT_STEP_INDEX } from '../../../domain/js/lifecycle.js'

afterEach(cleanup)

const noop = () => {}
const planAt = (cursor) => ({
  id: 'PL-3',
  title: 'Retire the FIX gateway',
  kind: 'plan',
  desc: '',
  metric: '',
  guardrails: '',
  priority: 'High',
  cursor,
  paused: false,
  rejected: false,
  events: [],
  stepOutputs: {},
  activeRun: null,
  projectAutopilot: 'on',
})

const renderAt = (cursor) =>
  render(
    <Tracker
      item={planAt(cursor)}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onResolveConflicts={noop}
      onTogglePause={noop}
      onRestartPhase={noop}
      onSetPersona={noop}
      onSetFiledAutopilot={noop}
      onAbandon={noop}
    />,
  )
const selects = () => screen.queryAllByRole('combobox', { name: 'Autopilot for filed items' })

test('exactly one select shows on the awaiting Approve & file card, set to "Project default (On)"', () => {
  const { container } = renderAt(APPROVE_FILE_GATE_INDEX)
  const all = selects()
  expect(all).toHaveLength(1)
  expect(all[0].selectedOptions[0].textContent).toBe('Project default (On)')
  expect(all[0].closest('.step-card').querySelector('.step-card__label').textContent).toBe('Approve & file')
  // No per-row control: the items table carries no autopilot select.
  for (const table of container.querySelectorAll('table')) expect(table.querySelector('select[id^="filed-autopilot"]')).toBeNull()
})

test.each([
  ['at Draft items', PLAN_DRAFT_STEP_INDEX],
  ['once Approve & file is approved', FILE_ITEMS_STEP_INDEX],
])('no select shows %s', (_, cursor) => {
  renderAt(cursor)
  expect(selects()).toHaveLength(0)
})
