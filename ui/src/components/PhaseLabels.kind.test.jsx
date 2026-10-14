// HZ-445: a Task's phase label comes from the Task's own phase list, not the
// change list — a Task at Review & close reads "Review", never "Deploy", on
// its Board card, in the approvals drawer and in the restart dialog. Change
// items keep the labels they always had.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import Board from './Board'
import ApprovalsDrawer from './ApprovalsDrawer'
import ComposerModal from './ComposerModal'
import {
  PHASES,
  STEPS,
  ACCEPT_GATE_INDEX,
  DEPLOY_STEP_INDEX,
  stepsFor,
  phasesFor,
} from '../../../domain/js/lifecycle.js'
import * as boardFilters from '../boardFilters'

afterEach(() => {
  cleanup()
  boardFilters._resetForTests()
})

const noop = () => {}
const taskClose = stepsFor('task').find((s) => s.label === 'Review & close')

function item(id, extra = {}) {
  return {
    id,
    title: `Item ${id}`,
    priority: 'Medium',
    cursor: DEPLOY_STEP_INDEX,
    issue: null,
    pr: null,
    paused: false,
    rejected: false,
    abandoned_at: null,
    personas: { eng: 'fullstack' },
    activeRun: null,
    gateAction: null,
    conflictRun: null,
    state_since: null,
    last_activity_at: '2026-10-14 11:59:00',
    ...extra,
  }
}

const task = item('HZ-T', { kind: 'task', cursor: taskClose.index })
const change = item('HZ-C')

const phaseOf = (container, cardSel, idSel, id, phaseSel) => {
  const el = [...container.querySelectorAll(cardSel)].find((c) => c.querySelector(idSel)?.textContent === id)
  expect(el).toBeTruthy()
  return el.querySelector(phaseSel).textContent
}

test('the fixtures sit where the bug showed: a Task at Review & close, a change at Deploy', () => {
  expect(taskClose.kind).toBe('gate')
  // The same phase number that reads "Deploy" in the change list.
  expect(PHASES[taskClose.phase]).toBe('Deploy')
  expect(phasesFor('task')[taskClose.phase]).toBe('Review')
})

test('Board card: the Task says Review, the change item says Deploy', () => {
  boardFilters.setActiveFilters([])
  const { container } = render(
    <Board
      items={[task, change]}
      onOpen={noop}
      onApprove={noop}
      onReject={noop}
      onTogglePause={noop}
      onNewItem={noop}
    />,
  )
  expect(phaseOf(container, '.card', '.card__id', 'HZ-T', '.card__phase')).toBe('Review')
  expect(phaseOf(container, '.card', '.card__id', 'HZ-C', '.card__phase')).toBe('Deploy')
})

test('Approvals drawer: the Task says Review; a change gate keeps its change-list label', () => {
  const changeGate = item('HZ-G', { cursor: ACCEPT_GATE_INDEX })
  const { container } = render(
    <ApprovalsDrawer items={[task, changeGate]} onClose={noop} onOpenItem={noop} onApprove={noop} onReject={noop} />,
  )
  expect(phaseOf(container, '.approval', '.approval__id', 'HZ-T', '.approval__phase')).toBe('Review')
  expect(phaseOf(container, '.approval', '.approval__id', 'HZ-G', '.approval__phase')).toBe(
    PHASES[STEPS[ACCEPT_GATE_INDEX].phase],
  )
})

test('Restart dialog names the phase from the item kind list', () => {
  const restart = (it) => ({
    open: true,
    mode: 'restart',
    itemId: it.id,
    phase: taskClose.phase,
  })
  const { container, unmount } = render(
    <ComposerModal composer={restart(task)} item={task} onSubmit={noop} onCancel={noop} />,
  )
  expect(container.querySelector('.composer__sub').textContent).toBe('Review phase will re-run from the start')
  unmount()
  const changeView = render(<ComposerModal composer={restart(change)} item={change} onSubmit={noop} onCancel={noop} />)
  expect(changeView.container.querySelector('.composer__sub').textContent).toBe(
    'Deploy phase will re-run from the start',
  )
})
