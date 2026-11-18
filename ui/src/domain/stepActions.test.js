// HZ-920: Move to…'s Close is the snapshot's `skip` target. The menu offers
// Move to… for it, the dialog lists it after the return targets, and a click
// on the final gate's row in the step list only selects it — Close is never a
// step-list action, and never a return.

import { expect, test } from 'vitest'
import { ACTION_LABELS, menuActions, moveDialogTargets, returnTargets, stepActionFor } from './stepActions'

const moves = (targets, actions, extra = {}) => ({
  targets: targets.map((stepKey) => ({ stepKey, isDefault: false, redo: '', reapprovals: [], stopsRunning: false })),
  actions,
  labels: { 'task.review-close': 'Close', 'task.assess': 'Assess', 'task.run-plan': 'Run plan' },
  approveKey: null,
  canAbandon: true,
  amendKey: null,
  ...extra,
})

const AT_RUN_PLAN = {
  id: 'MDI-137',
  moves: moves(['task.run-plan', 'task.review-close', 'task.assess'], {
    'task.run-plan': 'retry',
    'task.review-close': 'skip',
    'task.assess': 'return',
  }),
}

test('stepActionFor: a skip target is select-only; the return and retry keep their actions', () => {
  expect(stepActionFor(AT_RUN_PLAN, 'task.review-close')).toBeNull()
  expect(stepActionFor(AT_RUN_PLAN, 'task.assess')).toBe('return')
  expect(stepActionFor(AT_RUN_PLAN, 'task.run-plan')).toBe('retry')
})

test('moveDialogTargets: the returns in the snapshot’s order, then Close; returnTargets leaves Close out', () => {
  expect(moveDialogTargets(AT_RUN_PLAN).map((t) => [t.key, t.label, t.action])).toEqual([
    ['task.assess', 'Assess', 'return'],
    ['task.review-close', 'Close', 'skip'],
  ])
  expect(returnTargets(AT_RUN_PLAN).map((t) => t.key)).toEqual(['task.assess'])
})

test('menuActions: Move to… is offered for Close alone, and reads Move to…', () => {
  expect(ACTION_LABELS.return).toBe('Move to…')
  const closeOnly = { id: 'X', moves: moves(['task.verify-report', 'task.review-close'], { 'task.verify-report': 'retry', 'task.review-close': 'skip' }) }
  expect(menuActions(closeOnly).map((a) => a.label)).toEqual(['Move to…', 'Retry', 'Abandon'])
  const none = { id: 'Y', moves: moves(['task.verify-report'], { 'task.verify-report': 'retry' }) }
  expect(menuActions(none).map((a) => a.label)).toEqual(['Retry', 'Abandon'])
})
