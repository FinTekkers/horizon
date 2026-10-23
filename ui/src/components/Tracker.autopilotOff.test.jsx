// HZ-544: the item page's "Turn off Autopilot for <id>" checkbox. Ticking it
// posts { off: true } with no gate PIN; unticking goes through the PIN prompt
// and sends the PIN. The box and the "Autopilot off" chip show the server's
// answer (data.item), never an optimistic flip, so a refused or cancelled
// change leaves both as they were, with the reason on screen.
//
// The real serverApi and the real Tracker, wired as App.jsx wires them, with
// fetch, EventSource and window.prompt stubbed.

import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { ACCEPT_GATE_INDEX } from '../../../domain/js/lifecycle.js'

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

let prompt
beforeEach(() => {
  localStorage.clear()
  prompt = vi.fn(() => null)
  vi.stubGlobal('prompt', prompt)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.stubGlobal('EventSource', MockEventSource)
  vi.restoreAllMocks()
  localStorage.clear()
})

const noop = () => {}

function Page({ id }) {
  const items = useSyncExternalStore(serverApi.subscribe, serverApi.getItems)
  const item = items.find((it) => it.id === id)
  if (!item) return null
  return (
    <Tracker
      item={item}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onResolveConflicts={noop}
      onTogglePause={noop}
      onRestartPhase={noop}
      onSetPersona={noop}
      onAbandon={noop}
    />
  )
}

let seq = 0
// An item parked at Accept the code in an Autopilot-on project, as the board has it.
function atAccept(extra = {}) {
  return {
    id: `LM-${364 + seq++}`,
    title: 'Adjusted cost basis',
    desc: '',
    metric: '',
    guardrails: '',
    priority: 'Medium',
    cursor: ACCEPT_GATE_INDEX,
    issue: 364,
    repo: 'FinTekkers/ledger-models',
    pr: 12,
    pr_url: 'https://example.test/pr/12',
    paused: false,
    rejected: false,
    events: [],
    stepOutputs: {},
    activeRun: null,
    gateAction: null,
    autopilotOff: false,
    projectAutopilot: 'on',
    autopilotWouldHave: null,
    last_activity_at: '2026-10-22 12:00:00',
    ...extra,
  }
}
const answered = (item, autopilotOff) => ({ ...item, autopilotOff, last_activity_at: '2026-10-22 12:00:05' })

function open(item) {
  const view = render(<Page id={item.id} />)
  act(() => MockEventSource.instances.at(-1).dispatch('snapshot', { items: [item] }))
  return view
}

const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })
// The page's other panels (screenshots at Accept) fetch too; they get a 404.
// `answer` serves only the autopilot-off route, and its calls are the ones counted.
function stubRoute(answer) {
  const route = vi.fn(answer)
  vi.stubGlobal(
    'fetch',
    vi.fn((url, init) => (String(url).endsWith('/autopilot-off') ? route(url, init) : reply({ error: 'not_found' }, 404))),
  )
  return route
}
const toggleError = (view) => view.container.querySelector('.autopilot-off-toggle__error[role="alert"]')
const box = (view, item) => view.getByRole('checkbox', { name: `Turn off Autopilot for ${item.id}` })
const chip = (view) => view.container.querySelector('.tracker__meta .autopilot-off-chip')
const acceptMeta = (view) =>
  [...view.container.querySelectorAll('.step-card')]
    .find((card) => card.querySelector('.step-card__label')?.textContent === 'Accept the code')
    .querySelector('.step-card__meta').textContent
const click = (el) => act(async () => el.click())

test('ticking adds the label with no PIN, and the chip and gate note appear from the answer', async () => {
  const item = atAccept()
  const view = open(item)
  expect(chip(view)).toBeNull()
  expect(view.container.textContent).toContain("Autopilot handles this item's gates 5, 10, 13 and 15")
  const fetch = stubRoute(() => reply({ ok: true, autopilotOff: true, item: answered(item, true) }))

  await click(box(view, item))

  expect(fetch).toHaveBeenCalledTimes(1)
  const [url, init] = fetch.mock.calls[0]
  expect(url).toMatch(new RegExp(`/items/${item.id}/autopilot-off$`))
  expect(JSON.parse(init.body)).toEqual({ off: true })
  expect(init.headers['x-human-key']).toBeUndefined()
  expect(prompt).not.toHaveBeenCalled()
  expect(box(view, item).checked).toBe(true)
  expect(chip(view)?.textContent).toBe('Autopilot off')
  expect(acceptMeta(view)).toContain('Autopilot is off for this item')
  expect(view.container.textContent).toContain(`Every gate on ${item.id} waits for you`)
})

test('unticking prompts for the gate PIN, sends it, and the chip goes', async () => {
  const item = atAccept({ autopilotOff: true })
  const view = open(item)
  expect(chip(view)).not.toBeNull()
  prompt.mockImplementation(() => '4321')
  const fetch = stubRoute(() => reply({ ok: true, autopilotOff: false, item: answered(item, false) }))

  await click(box(view, item))

  expect(prompt).toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(1)
  const [, init] = fetch.mock.calls[0]
  expect(init.headers['x-human-key']).toBe('4321')
  expect(JSON.parse(init.body)).toEqual({ off: false })
  expect(box(view, item).checked).toBe(false)
  expect(chip(view)).toBeNull()
  expect(acceptMeta(view)).not.toContain('Autopilot is off')
})

test('a cancelled PIN prompt sends nothing: the box stays ticked and the chip stays', async () => {
  const item = atAccept({ autopilotOff: true })
  const view = open(item)
  const fetch = stubRoute(() => reply({}))

  await click(box(view, item))

  expect(fetch).not.toHaveBeenCalled()
  expect(box(view, item).checked).toBe(true)
  expect(chip(view)).not.toBeNull()
  expect(toggleError(view).textContent).toContain('needs your gate PIN')
})

test('a wrong PIN (401) leaves the item off and says so', async () => {
  const item = atAccept({ autopilotOff: true })
  const view = open(item)
  // The first prompt answers; the retry prompt after the 401 is cancelled.
  prompt.mockImplementationOnce(() => 'wrong')
  stubRoute(() => reply({ error: 'human_gate_key_required' }, 401))

  await click(box(view, item))

  expect(box(view, item).checked).toBe(true)
  expect(chip(view)).not.toBeNull()
  expect(toggleError(view).textContent).toContain('Gate PIN incorrect')
})

test('a GitHub refusal (502) leaves the box unticked, with no chip, and shows an error', async () => {
  const item = atAccept()
  const view = open(item)
  stubRoute(() => reply({ error: 'GitHub returned 500 adding the autopilot-off label' }, 502))

  await click(box(view, item))

  expect(box(view, item).checked).toBe(false)
  expect(chip(view)).toBeNull()
  expect(toggleError(view).textContent).toContain('did not go through')
})

test('the chip follows the answer\'s item, not the click', async () => {
  const item = atAccept()
  const view = open(item)
  stubRoute(() => reply({ ok: true, autopilotOff: false, item: answered(item, false) }))

  await click(box(view, item))

  expect(box(view, item).checked).toBe(false)
  expect(chip(view)).toBeNull()
})

for (const mode of ['shadow', 'off']) {
  test(`in an Autopilot-${mode} project a labelled item shows no chip and no gate note`, () => {
    const item = atAccept({ autopilotOff: true, projectAutopilot: mode })
    const view = open(item)
    expect(chip(view)).toBeNull()
    expect(acceptMeta(view)).not.toContain('Autopilot is off')
    expect(view.container.textContent).not.toContain('Autopilot is off for this item.')
  })
}
