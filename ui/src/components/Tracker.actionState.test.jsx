// HZ-389: after a pause, resume or send-back, the item page shows the state in
// the server's answer at once — no delta, no reload. A send-back that restarts
// a step labels that step's card "Sent: attempt N starting" with the server's N,
// and the activity feed shows the restart row from the answer's events. A later
// delta applies on top without a second row. A failed action, or one still in
// flight, leaves the page as it was.
//
// The real serverApi and the real Tracker, wired the way App.jsx wires them,
// with fetch and EventSource stubbed: the stream sends one snapshot, then only
// the deltas a test dispatches itself.

import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { IMPLEMENT_STEP_INDEX, STEPS } from '../../../domain/js/lifecycle.js'

class MockEventSource {
  constructor(url) {
    this.url = url
    this.listeners = {}
    this.readyState = MockEventSource.OPEN
    MockEventSource.instances.push(this)
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn
  }
  dispatch(type, data) {
    this.listeners[type]({ data: JSON.stringify(data) })
  }
  close() {
    this.readyState = MockEventSource.CLOSED
  }
}
MockEventSource.CONNECTING = 0
MockEventSource.OPEN = 1
MockEventSource.CLOSED = 2
MockEventSource.instances = []

let serverApi
let Tracker
beforeAll(async () => {
  vi.stubGlobal('EventSource', MockEventSource)
  serverApi = await import('../api/serverApi')
  Tracker = (await import('./Tracker')).default
})

beforeEach(() => {
  localStorage.setItem('horizon_gate_pin', 'test-pin')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.stubGlobal('EventSource', MockEventSource)
  vi.restoreAllMocks()
  localStorage.clear()
})

const STEP_LABEL = STEPS[IMPLEMENT_STEP_INDEX].label
const NOTE_EVENT = { who: 'You', text: `requested changes on Eng: try X — sent back to the ${STEP_LABEL.toLowerCase()} step`, color: '#9C333E', initials: 'YOU', created_at: '2026-10-10 12:00:02' }
const FAIL_EVENT = { who: 'Horizon', text: 'agent step failed: repo checks failed — item paused; resume to retry', color: '#9C333E', initials: 'HZ', created_at: '2026-10-10 12:00:00' }

// A paused item whose implement step failed, as the board snapshot has it.
function pausedFailed(id, extra = {}) {
  return {
    id,
    title: `Item ${id}`,
    desc: '',
    metric: '',
    guardrails: '',
    priority: 'Medium',
    cursor: IMPLEMENT_STEP_INDEX,
    paused: true,
    rejected: false,
    events: [FAIL_EVENT],
    stepOutputs: {},
    activeRun: null,
    last_activity_at: '2026-10-10 12:00:00',
    ...extra,
  }
}

// The item as /reject answers: running again, the note on top of its events.
function restarted(item, { attempt, activeRun = true, ...extra } = {}) {
  return {
    ...item,
    paused: false,
    events: [NOTE_EVENT, ...item.events],
    activeRun: activeRun
      ? { id: 90 + attempt, step_index: IMPLEMENT_STEP_INDEX, attempt, started_at: new Date().toISOString(), state: 'running', reason: null }
      : null,
    last_activity_at: '2026-10-10 12:00:02',
    ...extra,
  }
}

const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })

const noop = () => {}

function Page({ id }) {
  const items = useSyncExternalStore(serverApi.subscribe, serverApi.getItems)
  const item = items.find((it) => it.id === id)
  if (!item) return null
  return (
    <Tracker
      item={item}
      restartSent={serverApi.getRestartSent(id)}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onResolveConflicts={noop}
      onTogglePause={serverApi.setPaused}
      onRestartPhase={noop}
      onSetPersona={noop}
      onAbandon={noop}
    />
  )
}

// Opens the page on a board holding `item`. Only this one snapshot is sent.
function open(item) {
  const view = render(<Page id={item.id} />)
  act(() => MockEventSource.instances.at(-1).dispatch('snapshot', { items: [item] }))
  return view
}

const stepMeta = (view) =>
  [...view.container.querySelectorAll('.step-card')]
    .find((card) => card.querySelector('.step-card__label')?.textContent === STEP_LABEL)
    .querySelector('.step-card__meta').textContent
const activityTexts = (view) => [...view.container.querySelectorAll('.activity-row__text')].map((n) => n.textContent)
const count = (list, text) => list.filter((t) => t.includes(text)).length

test('R5: the answer already carries the run at attempt N, and the card still reads "Sent: attempt 3 starting"', async () => {
  const item = pausedFailed('AS-5')
  const view = open(item)
  vi.stubGlobal('fetch', vi.fn(() => reply({ ok: true, item: restarted(item, { attempt: 3 }), restart: { stepIndex: IMPLEMENT_STEP_INDEX, attempt: 3 } })))

  await act(() => serverApi.requestChanges('AS-5', 'Eng', 'try X'))
  expect(stepMeta(view)).toContain('Sent: attempt 3 starting')
  expect(view.getByRole('button', { name: 'Pause work' })).toBeTruthy()
})

test('R6: N is the server\'s restart.attempt, not one derived from the runs the page knows of', async () => {
  const item = pausedFailed('AS-6', { stepOutputs: { [IMPLEMENT_STEP_INDEX]: { attempt: 2, attemptCount: 2, label: STEP_LABEL } } })
  const view = open(item)
  vi.stubGlobal('fetch', vi.fn(() => reply({ ok: true, item: restarted(item, { attempt: 7, activeRun: false }), restart: { stepIndex: IMPLEMENT_STEP_INDEX, attempt: 7 } })))

  await act(() => serverApi.requestChanges('AS-6', 'Eng', 'try X'))
  expect(stepMeta(view)).toContain('Sent: attempt 7 starting')
  expect(stepMeta(view)).not.toContain('attempt 3')
})

test('R8 / line 4: the restart row shows once from the answer; a later delta adds no duplicate, and the label then clears', async () => {
  const item = pausedFailed('AS-8')
  const view = open(item)
  expect(count(activityTexts(view), 'requested changes on Eng')).toBe(0)
  const answer = restarted(item, { attempt: 2 })
  vi.stubGlobal('fetch', vi.fn(() => reply({ ok: true, item: answer, restart: { stepIndex: IMPLEMENT_STEP_INDEX, attempt: 2 } })))

  await act(() => serverApi.requestChanges('AS-8', 'Eng', 'try X'))
  expect(count(activityTexts(view), 'requested changes on Eng: try X')).toBe(1)
  expect(stepMeta(view)).toContain('Sent: attempt 2 starting')

  // The stream catches up: same events, one newer, the run still going.
  const newer = { who: 'Eng', text: 'pushed a WIP checkpoint', color: '#5E4380', initials: 'EN', created_at: '2026-10-10 12:00:03' }
  act(() => MockEventSource.instances.at(-1).dispatch('delta', { upserts: [{ ...answer, events: [newer, ...answer.events] }] }))
  expect(count(activityTexts(view), 'requested changes on Eng: try X')).toBe(1)
  expect(count(activityTexts(view), 'pushed a WIP checkpoint')).toBe(1)
  expect(stepMeta(view)).toContain('Sent: attempt 2 starting')

  // The step finished and the item moved on: the label goes with it.
  act(() =>
    MockEventSource.instances.at(-1).dispatch('delta', { upserts: [{ ...answer, cursor: IMPLEMENT_STEP_INDEX + 1, activeRun: null }] }),
  )
  expect(view.container.textContent).not.toContain('Sent: attempt')
})

test('R9: an answer older than the cached item is not applied, and its restart is still recorded', async () => {
  const item = pausedFailed('AS-9', { last_activity_at: '2026-10-10 12:00:05' })
  const view = open(item)
  const cached = serverApi.getItems().find((it) => it.id === 'AS-9')
  vi.stubGlobal('fetch', vi.fn(() => reply({ ok: true, item: restarted(item, { attempt: 4 }), restart: { stepIndex: IMPLEMENT_STEP_INDEX, attempt: 4 } })))

  await act(() => serverApi.requestChanges('AS-9', 'Eng', 'try X'))
  expect(serverApi.getItems().find((it) => it.id === 'AS-9')).toBe(cached)
  expect(view.getByRole('button', { name: 'Resume work' })).toBeTruthy()
  expect(serverApi.getRestartSent('AS-9')).toEqual({ stepIndex: IMPLEMENT_STEP_INDEX, attempt: 4 })
})

test('line 2: pause and resume show the answer\'s state at once, with no delta', async () => {
  const running = { ...pausedFailed('AS-2'), paused: false, activeRun: { id: 7, step_index: IMPLEMENT_STEP_INDEX, attempt: 1, started_at: new Date().toISOString(), state: 'running', reason: null } }
  const view = open(running)
  vi.stubGlobal('fetch', vi.fn(() => reply({ ok: true, paused: true, item: { ...running, paused: true, activeRun: null, last_activity_at: '2026-10-10 12:00:01' } })))
  await act(async () => view.getByRole('button', { name: 'Pause work' }).click())
  expect(view.getByRole('button', { name: 'Resume work' })).toBeTruthy()

  vi.stubGlobal('fetch', vi.fn(() => reply({ ok: true, paused: false, item: { ...running, last_activity_at: '2026-10-10 12:00:02' } })))
  await act(async () => view.getByRole('button', { name: 'Resume work' }).click())
  expect(view.getByRole('button', { name: 'Pause work' })).toBeTruthy()
})

test('R10: while /reject and /pause are pending, the button and the step stay as they were', async () => {
  const item = pausedFailed('AS-10')
  const view = open(item)
  const before = stepMeta(view)
  let answer
  vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => (answer = resolve))))

  let sent
  act(() => {
    sent = serverApi.requestChanges('AS-10', 'Eng', 'try X')
  })
  await act(async () => {})
  expect(view.getByRole('button', { name: 'Resume work' })).toBeTruthy()
  expect(stepMeta(view)).toBe(before)
  expect(count(activityTexts(view), 'requested changes')).toBe(0)
  await act(async () => {
    answer({ ok: true, status: 200, json: async () => ({ ok: true, item: restarted(item, { attempt: 2 }), restart: { stepIndex: IMPLEMENT_STEP_INDEX, attempt: 2 } }) })
    await sent
  })
  expect(view.getByRole('button', { name: 'Pause work' })).toBeTruthy()

  vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => (answer = resolve))))
  await act(async () => view.getByRole('button', { name: 'Pause work' }).click())
  expect(view.getByRole('button', { name: 'Pause work' })).toBeTruthy()
  expect(stepMeta(view)).toContain('Sent: attempt 2 starting')
  await act(async () => answer({ ok: true, status: 200, json: async () => ({ ok: true, paused: true, item: { ...restarted(item, { attempt: 2 }), paused: true, activeRun: null, last_activity_at: '2026-10-10 12:00:03' } }) }))
  expect(view.getByRole('button', { name: 'Resume work' })).toBeTruthy()
})

test('R11: a 409, no answer, a cancelled PIN retry and a failed pause each leave the cached item untouched', async () => {
  const item = pausedFailed('AS-11')
  const view = open(item)
  const cached = () => serverApi.getItems().find((it) => it.id === 'AS-11')
  const original = cached()

  vi.stubGlobal('fetch', vi.fn(() => reply({ error: 'closed' }, 409)))
  await expect(serverApi.requestChanges('AS-11', 'Eng', 'x')).rejects.toMatchObject({ message: 'closed', status: 409 })
  expect(cached()).toBe(original)

  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
  await expect(serverApi.requestChanges('AS-11', 'Eng', 'x')).rejects.toThrow('network')
  expect(cached()).toBe(original)

  // Wrong PIN, and the retry prompt is cancelled: the 401 is what comes back.
  vi.stubGlobal('fetch', vi.fn(() => reply({ error: 'bad_human_gate_key' }, 401)))
  vi.spyOn(window, 'prompt').mockReturnValue(null)
  await expect(serverApi.requestChanges('AS-11', 'Eng', 'x')).rejects.toMatchObject({ status: 401 })
  expect(cached()).toBe(original)
  expect(serverApi.getRestartSent('AS-11')).toBeNull()

  vi.stubGlobal('fetch', vi.fn(() => reply({ error: 'closed' }, 409)))
  await act(async () => view.getByRole('button', { name: 'Resume work' }).click())
  expect(view.getByRole('alert').textContent).toBe('This item is closed.')
  expect(cached()).toBe(original)
  expect(view.getByRole('button', { name: 'Resume work' })).toBeTruthy()
})
