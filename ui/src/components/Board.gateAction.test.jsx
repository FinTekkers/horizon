// HZ-226: a Board card at the Accept gate shows the server's gateAction with
// the Tracker's own wording (gateActionView) — the status line replaces the
// gate buttons while the action runs, and the buttons come back once it
// finishes. Fixtures use the exact payload shape server/src/store.js sends
// (gateActionView / conflictRunView), absent values as null.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
}))

import Board from './Board'
import { ACCEPT_GATE_INDEX, DEPLOY_STEP_INDEX, STEPS } from '../../../domain/js/lifecycle.js'
import { gateActionView } from '../domain/gateAction'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const noop = () => {}
const PR = 42
const SINCE = '2026-10-02T10:00:00.000Z'

function action(kind, state, extra = {}) {
  return {
    kind,
    state,
    detail: null,
    since: SINCE,
    deadline: '2026-10-02T10:30:00.000Z',
    finishedAt: state === 'running' ? null : '2026-10-02T10:05:00.000Z',
    reason: null,
    failingCheck: null,
    startedBeforeRestart: false,
    ...extra,
  }
}

function acceptItem(extra = {}) {
  return {
    id: 'BGS-1',
    title: 'Board gate status',
    priority: 'High',
    cursor: ACCEPT_GATE_INDEX,
    issue: null,
    pr: PR,
    pr_url: 'https://example.test/pr/42',
    paused: false,
    rejected: false,
    personas: { eng: 'fullstack' },
    activeRun: null,
    gateAction: null,
    conflictRun: null,
    ...extra,
  }
}

function renderBoard(item, handlers = {}) {
  return render(
    <Board
      items={[item]}
      onOpen={handlers.onOpen || noop}
      onApprove={handlers.onApprove || noop}
      onReject={handlers.onReject || noop}
      onTogglePause={noop}
      onNewItem={noop}
    />,
  )
}

const card = (container) => container.querySelector('.card')

// Every metric-1 state. `expectsStatus` is declared, not derived, so a
// regression of gateActionView to null fails instead of switching branches.
const ROWS = [
  { name: 'premerge running with detail', action: action('premerge', 'running', { detail: 'npm test' }), expectsStatus: true, running: true },
  { name: 'premerge running without detail', action: action('premerge', 'running'), expectsStatus: true, running: true },
  { name: 'premerge merged', action: action('premerge', 'merged'), expectsStatus: true, running: false },
  { name: 'premerge blocked with failingCheck', action: action('premerge', 'blocked', { failingCheck: 'unit-tests' }), expectsStatus: true, running: false },
  { name: 'premerge blocked with only reason', action: action('premerge', 'blocked', { reason: 'branch protection refused' }), expectsStatus: true, running: false },
  { name: 'premerge failed', action: action('premerge', 'failed', { reason: 'GitHub refused the merge' }), expectsStatus: true, running: false, literalNote: 'GitHub refused the merge' },
  { name: 'premerge timed_out', action: action('premerge', 'timed_out', { reason: 'checks ran past the deadline' }), expectsStatus: true, running: false, literalNote: 'checks ran past the deadline' },
  { name: 'premerge interrupted', action: action('premerge', 'interrupted', { reason: 'Horizon restarted mid-run' }), expectsStatus: true, running: false, literalNote: 'Horizon restarted mid-run' },
  { name: 'resolve running', action: action('resolve', 'running'), expectsStatus: true, running: true },
  { name: 'resolve resolved', action: action('resolve', 'resolved'), expectsStatus: false, running: false },
  { name: 'resolve escalated', action: action('resolve', 'escalated', { reason: 'conflicts too large' }), expectsStatus: false, running: false },
]

test.each(ROWS)('Accept card, $name: status line text, tone, note and gate buttons', ({ action: a, expectsStatus, running, literalNote }) => {
  const view = gateActionView(a, PR)
  expect(view !== null).toBe(expectsStatus)

  const { container, queryByRole, queryByText } = renderBoard(acceptItem({ gateAction: a }))
  const status = queryByRole('status')
  if (expectsStatus) {
    expect(status).not.toBeNull()
    expect(status.querySelector('.gate-action-status__text').textContent).toBe(view.text)
    expect(status.classList.contains(`gate-action-status--${view.tone}`)).toBe(true)
    const note = status.querySelector('.gate-action-status__note')
    if (literalNote) {
      expect(note.textContent).toBe(literalNote)
    } else if (a.state === 'blocked') {
      expect(note.textContent).toBe(view.note)
    }
  } else {
    expect(status).toBeNull()
    expect(card(container).querySelector('.gate-action-status')).toBeNull()
  }

  if (running) {
    expect(queryByText('Approve')).toBeNull()
    expect(queryByText('Send back')).toBeNull()
  } else {
    expect(queryByText('Approve')).not.toBeNull()
    expect(queryByText('Send back')).not.toBeNull()
  }
})

test('exact wording on the card for the headline states', () => {
  const cases = [
    [action('premerge', 'running', { detail: 'npm test' }), 'Merging: npm test'],
    [action('premerge', 'merged'), `Merged PR #${PR}`],
    [action('premerge', 'blocked', { failingCheck: 'unit-tests' }), 'Blocked: pre-merge check unit-tests failed'],
  ]
  for (const [a, text] of cases) {
    const { getByRole, unmount } = renderBoard(acceptItem({ gateAction: a }))
    expect(getByRole('status').querySelector('.gate-action-status__text').textContent).toBe(text)
    unmount()
  }
})

test('a running conflictRun with no gateAction key shows "Resolving conflicts" and hides the gate buttons', () => {
  const item = acceptItem({ conflictRun: { state: 'running', since: SINCE, reason: null } })
  delete item.gateAction
  const { getByRole, queryByText } = renderBoard(item)
  expect(getByRole('status').querySelector('.gate-action-status__text').textContent).toBe(`Resolving conflicts on PR #${PR}`)
  expect(queryByText('Approve')).toBeNull()
  expect(queryByText('Send back')).toBeNull()
})

test('the status line is a polite live region and never moves focus as it appears and changes', () => {
  function Harness({ gateAction }) {
    return (
      <div>
        <button type="button">Elsewhere</button>
        <Board items={[acceptItem({ gateAction })]} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />
      </div>
    )
  }
  const { getByText, rerender, getByRole, queryByRole } = render(<Harness gateAction={null} />)
  const outside = getByText('Elsewhere')
  outside.focus()
  expect(document.activeElement).toBe(outside)
  expect(queryByRole('status')).toBeNull()

  const steps = [
    action('premerge', 'running', { detail: 'a' }),
    action('premerge', 'running', { detail: 'b' }),
    action('premerge', 'blocked', { failingCheck: 'unit-tests' }),
  ]
  for (const a of steps) {
    rerender(<Harness gateAction={a} />)
    const status = getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.querySelector('.gate-action-status__text').textContent).toBe(gateActionView(a, PR).text)
    expect(document.activeElement).toBe(outside)
  }
})

test('a running card starts no timer, makes no fetch and shows no elapsed clock', () => {
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  vi.useFakeTimers()
  const { container } = renderBoard(acceptItem({ gateAction: action('premerge', 'running', { detail: 'npm test' }) }))
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(5000)
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(container.querySelector('.gate-action-status__elapsed')).toBeNull()
  vi.unstubAllGlobals()
})

test('once the run ends, Approve and Send back call the same handlers as before', () => {
  const onApprove = vi.fn()
  const onReject = vi.fn()
  const onOpen = vi.fn()
  const { getByText } = renderBoard(acceptItem({ gateAction: action('premerge', 'blocked', { failingCheck: 'unit-tests' }) }), {
    onApprove,
    onReject,
    onOpen,
  })
  const label = STEPS[ACCEPT_GATE_INDEX].label
  fireEvent.click(getByText('Approve'))
  expect(onApprove).toHaveBeenCalledTimes(1)
  expect(onApprove).toHaveBeenCalledWith('BGS-1', label)
  fireEvent.click(getByText('Send back'))
  expect(onReject).toHaveBeenCalledTimes(1)
  expect(onReject).toHaveBeenCalledWith('BGS-1', label)
  expect(onOpen).not.toHaveBeenCalled()
})

test('an Accept card with no action renders the same with gateAction null or absent: no status line, both buttons', () => {
  const withNull = renderBoard(acceptItem({ gateAction: null, conflictRun: null }))
  const nullHtml = card(withNull.container).innerHTML
  expect(withNull.queryByRole('status')).toBeNull()
  expect(withNull.queryByText('Approve')).not.toBeNull()
  expect(withNull.queryByText('Send back')).not.toBeNull()
  cleanup()

  const absent = acceptItem()
  delete absent.gateAction
  delete absent.conflictRun
  const withAbsent = renderBoard(absent)
  expect(card(withAbsent.container).innerHTML).toBe(nullHtml)
})

test('a Deploy card with the real merged action renders exactly as with no action', () => {
  const merged = action('premerge', 'merged')
  const base = { cursor: DEPLOY_STEP_INDEX, title: 'Past the Accept gate' }
  const withMerged = renderBoard(acceptItem({ ...base, gateAction: merged }))
  const mergedHtml = card(withMerged.container).innerHTML
  expect(withMerged.container.querySelector('.gate-action-status')).toBeNull()
  cleanup()
  const without = renderBoard(acceptItem({ ...base, gateAction: null }))
  expect(card(without.container).innerHTML).toBe(mergedHtml)
})

test('a card at another gate ignores a gateAction entirely', () => {
  const otherGate = STEPS.findIndex((s, i) => s.kind === 'gate' && i !== ACCEPT_GATE_INDEX)
  const base = { cursor: otherGate }
  const withAction = renderBoard(acceptItem({ ...base, gateAction: action('premerge', 'running', { detail: 'x' }) }))
  const html = card(withAction.container).innerHTML
  expect(withAction.queryByText('Approve')).not.toBeNull()
  cleanup()
  const without = renderBoard(acceptItem({ ...base, gateAction: null }))
  expect(card(without.container).innerHTML).toBe(html)
})
