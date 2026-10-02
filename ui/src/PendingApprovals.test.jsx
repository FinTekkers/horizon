// HZ-279: once the owner acts on a gate, the item is not waiting on them. A
// running gate action (server push or first load) and this tab's own
// in-flight Accept or Resolve request take it out of the pending-approvals
// drawer and both counts — the top bar's and the bottom nav's — and it comes
// back when the run ends blocked, failed, timed out or interrupted, or when
// the request fails. The bottom nav is real here: matchMedia is stubbed to
// the phone breakpoint, so App mounts it.

import { expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { STEPS } from '../../domain/js/lifecycle.js'
import { gateActionView } from './domain/gateAction'

const ACCEPT_INDEX = STEPS.findIndex((s) => s.label === 'Accept the code')
const DESIGN_INDEX = STEPS.findIndex((s) => s.label === 'Approve the high-level design')

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

function item(id, extra = {}) {
  return {
    id,
    title: `Item ${id}`,
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

const now = () => new Date().toISOString()
const action = (kind, state, extra = {}) => ({
  kind,
  state,
  detail: kind === 'premerge' ? 'running checks on main + PR #7' : null,
  since: now(),
  deadline: new Date(Date.now() + 600_000).toISOString(),
  finishedAt: state === 'running' ? null : now(),
  reason: state === 'running' ? null : 'it did not finish',
  failingCheck: null,
  startedBeforeRestart: false,
  ...extra,
})

// The three shapes gateActionBusy() reads as running.
const RUNNING = {
  'a running premerge gateAction': { gateAction: action('premerge', 'running') },
  'a running resolve gateAction': { gateAction: action('resolve', 'running'), conflictRun: { state: 'running', since: now(), reason: null } },
  'a running conflictRun with no gateAction key': { gateAction: undefined, conflictRun: { state: 'running', since: now(), reason: null } },
}

// A (the one acted on) and B (another item still waiting) at Accept, C at an
// earlier gate. All three are pending to start with.
const baseline = (aExtra = {}) => [item('PA-A', aExtra), item('PA-B'), item('PA-C', { cursor: DESIGN_INDEX })]

function pushItems(next) {
  act(() => {
    items = next
    listeners.forEach((fn) => fn())
  })
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function renderAt(path, initial) {
  items = initial
  window.history.pushState({}, '', path)
  const view = render(<App />)
  await view.findByText('Pending approvals')
  // The store subscription is a passive effect: a push before it lands is lost.
  await waitFor(() => expect(listeners.size).toBeGreaterThan(0))
  return view
}

const topCount = () => Number(document.querySelector('.topbar .pending-btn__badge').textContent)
const navButton = (view) => view.getByRole('button', { name: /^Approvals, \d+ pending$/ })
const navCount = (view) => Number(navButton(view).getAttribute('aria-label').match(/(\d+) pending/)[1])
const drawerIds = () => [...document.querySelectorAll('.drawer .approval__id')].map((el) => el.textContent)
const openDrawer = () => fireEvent.click(document.querySelector('.topbar .pending-btn'))

function expectPending(view, ids) {
  expect(drawerIds()).toEqual(ids)
  expect(topCount()).toBe(ids.length)
  expect(navCount(view)).toBe(ids.length)
}

const cardOf = (id) => [...document.querySelectorAll('.card')].find((c) => c.querySelector('.card__id')?.textContent === id)
const buttonIn = (root, name) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === name) || null

beforeEach(() => {
  window.matchMedia = (query) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete window.matchMedia
  window.history.pushState({}, '', '/')
  items = []
  listeners.clear()
})

// ---- metric 1: a running item is not pending ----

for (const [name, running] of Object.entries(RUNNING)) {
  test(`${name} pushed by the server leaves the drawer, the top bar count and the bottom nav count`, async () => {
    const view = await renderAt('/', baseline())
    openDrawer()
    expectPending(view, ['PA-A', 'PA-B', 'PA-C'])

    pushItems(baseline(running))
    expectPending(view, ['PA-B', 'PA-C'])
  })

  test(`${name} in the first load (a reload mid-run) is never counted as pending`, async () => {
    const view = await renderAt('/', baseline(running))
    openDrawer()
    expectPending(view, ['PA-B', 'PA-C'])
  })
}

test('an in-flight Accept from the drawer hides the item before any push, and the open drawer updates in place', async () => {
  const answer = deferred()
  api.approveGate.mockReturnValue(answer.promise)
  const view = await renderAt('/', baseline())
  openDrawer()
  const card = [...document.querySelectorAll('.drawer .approval')].find((el) => el.textContent.includes('PA-A'))
  fireEvent.click(buttonIn(card, 'Approve'))
  fireEvent.click(document.querySelector('.composer__submit'))

  expect(api.approveGate).toHaveBeenCalledWith('PA-A', undefined)
  expectPending(view, ['PA-B', 'PA-C'])
  await act(async () => answer.resolve({ ok: true, premerge: true }))
})

test('an in-flight Accept from the Tracker updates the drawer already open in the same tab', async () => {
  const answer = deferred()
  api.approveGate.mockReturnValue(answer.promise)
  const view = await renderAt('/pa-a', baseline())
  openDrawer()
  expectPending(view, ['PA-A', 'PA-B', 'PA-C'])

  const trackerApprove = [...document.querySelectorAll('.tracker button, button')].find(
    (b) => b.textContent.trim() === 'Approve' && !b.closest('.drawer'),
  )
  fireEvent.click(trackerApprove)
  fireEvent.click(document.querySelector('.composer__submit'))
  expectPending(view, ['PA-B', 'PA-C'])
  await act(async () => answer.resolve({ ok: true, premerge: true }))
})

test('an in-flight Resolve conflicts request hides the item before any push', async () => {
  const answer = deferred()
  api.resolveConflicts.mockReturnValue(answer.promise)
  const view = await renderAt('/pa-a', baseline({ pr_mergeable: false }))
  openDrawer()
  fireEvent.click(document.querySelector('.step-card__conflict .btn-gate-reject'))
  await view.findByText('Resolve merge conflicts?')
  fireEvent.click(document.querySelector('.composer__submit'))

  expect(api.resolveConflicts).toHaveBeenCalledWith('PA-A')
  expectPending(view, ['PA-B', 'PA-C'])
  await act(async () => answer.resolve({ ok: true, resolved: true }))
})

// ---- guardrail: this tab's optimistic hide never gets stuck ----

test('an Accept the server rejects puts the item straight back in the drawer and both counts', async () => {
  const answer = deferred()
  api.approveGate.mockReturnValue(answer.promise)
  const view = await renderAt('/', baseline())
  openDrawer()
  const card = [...document.querySelectorAll('.drawer .approval')].find((el) => el.textContent.includes('PA-A'))
  fireEvent.click(buttonIn(card, 'Approve'))
  fireEvent.click(document.querySelector('.composer__submit'))
  expectPending(view, ['PA-B', 'PA-C'])

  await act(async () => answer.resolve({ ok: false, error: 'stale_step' }))
  expectPending(view, ['PA-A', 'PA-B', 'PA-C'])
})

test('a Resolve conflicts request that errors puts the item straight back in the drawer and both counts', async () => {
  const answer = deferred()
  api.resolveConflicts.mockReturnValue(answer.promise)
  const view = await renderAt('/pa-a', baseline({ pr_mergeable: false }))
  openDrawer()
  fireEvent.click(document.querySelector('.step-card__conflict .btn-gate-reject'))
  await view.findByText('Resolve merge conflicts?')
  fireEvent.click(document.querySelector('.composer__submit'))
  expectPending(view, ['PA-B', 'PA-C'])

  await act(async () => answer.reject(new Error('network down')))
  expectPending(view, ['PA-A', 'PA-B', 'PA-C'])
})

// ---- metric 2: a running item shows gateActionView() text, never an enabled Approve ----

for (const kind of ['premerge', 'resolve']) {
  test(`a running ${kind} action shows gateActionView()'s text on the card and the Tracker, with no enabled Approve`, async () => {
    const running = kind === 'premerge' ? RUNNING['a running premerge gateAction'] : RUNNING['a running resolve gateAction']
    const expected = gateActionView(running.gateAction, 7).text
    expect(expected).toBe(kind === 'premerge' ? 'Merging: running checks on main + PR #7' : 'Resolving conflicts on PR #7')

    await renderAt('/', baseline(running))
    const card = cardOf('PA-A')
    expect(card.querySelector('.gate-action-status').textContent).toContain(expected)
    expect(buttonIn(card, 'Approve')).toBeNull()
    cleanup()

    await renderAt('/pa-a', baseline(running))
    expect(document.querySelector('.tracker')).not.toBeNull()
    expect(document.querySelector('.gate-action-status').textContent).toContain(expected)
    const approves = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Approve')
    expect(approves.every((b) => b.disabled)).toBe(true)
  })
}

test('during this tab\'s in-flight Accept the card shows no Approve button', async () => {
  const answer = deferred()
  api.approveGate.mockReturnValue(answer.promise)
  await renderAt('/', baseline())
  const card = cardOf('PA-A')
  fireEvent.click(buttonIn(card, 'Approve'))
  fireEvent.click(document.querySelector('.composer__submit'))
  expect(buttonIn(cardOf('PA-A'), 'Approve')).toBeNull()
  expect(buttonIn(cardOf('PA-B'), 'Approve')).not.toBeNull()
  await act(async () => answer.resolve({ ok: true, premerge: true }))
  expect(buttonIn(cardOf('PA-A'), 'Approve')).not.toBeNull()
})

// ---- metric 3: the end of a run ----

for (const kind of ['premerge', 'resolve']) {
  for (const state of ['blocked', 'failed', 'timed_out', 'interrupted']) {
    if (kind === 'resolve' && state === 'blocked') continue // a resolve run never ends blocked
    test(`a ${kind} run that ends ${state} brings the item back to the drawer and both counts go up by 1`, async () => {
      const running = kind === 'premerge' ? RUNNING['a running premerge gateAction'] : RUNNING['a running resolve gateAction']
      const view = await renderAt('/', baseline(running))
      openDrawer()
      expectPending(view, ['PA-B', 'PA-C'])

      const ended = { gateAction: action(kind, state) }
      if (kind === 'resolve') ended.conflictRun = { state: 'failed', since: now(), reason: 'it did not finish' }
      pushItems(baseline(ended))
      expectPending(view, ['PA-A', 'PA-B', 'PA-C'])
    })
  }
}

test('a merge whose gate advanced does not bring the item back', async () => {
  const view = await renderAt('/', baseline(RUNNING['a running premerge gateAction']))
  openDrawer()
  expectPending(view, ['PA-B', 'PA-C'])

  pushItems(baseline({ cursor: ACCEPT_INDEX + 1, gateAction: action('premerge', 'merged', { reason: null }) }))
  expectPending(view, ['PA-B', 'PA-C'])
})
