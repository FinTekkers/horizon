// HZ-544: the item page's "Turn off Autopilot for <id>" checkbox. Ticking it
// posts { off: true } with no gate PIN; unticking goes through the PIN dialog
// (HZ-704: asked after the server's 401) and sends the PIN. The box and the "Autopilot off" chip show the server's
// answer (data.item), never an optimistic flip, so a refused or cancelled
// change leaves both as they were, with the reason on screen.
//
// The real serverApi and the real Tracker, wired as App.jsx wires them, with
// fetch, EventSource and the PIN dialog (setPinRequester) stubbed.

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

let requester
beforeEach(() => {
  localStorage.clear()
  requester = vi.fn(async () => null)
  serverApi.setPinRequester(requester)
})

afterEach(() => {
  serverApi.setPinRequester(null)
  cleanup()
  vi.unstubAllGlobals()
  vi.stubGlobal('EventSource', MockEventSource)
  vi.restoreAllMocks()
  localStorage.clear()
})

const noop = () => {}

function Page({ id, projects }) {
  const items = useSyncExternalStore(serverApi.subscribe, serverApi.getItems)
  const item = items.find((it) => it.id === id)
  if (!item) return null
  return (
    <Tracker
      item={item}
      projects={projects}
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

function open(item, projects) {
  const view = render(<Page id={item.id} projects={projects} />)
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
  expect(requester).not.toHaveBeenCalled()
  expect(box(view, item).checked).toBe(true)
  expect(chip(view)?.textContent).toBe('Autopilot off')
  expect(acceptMeta(view)).toContain('Autopilot is off for this item')
  expect(view.container.textContent).toContain(`Every gate on ${item.id} waits for you`)
})

test('unticking asks for the gate PIN, sends it, and the chip goes', async () => {
  const item = atAccept({ autopilotOff: true })
  const view = open(item)
  expect(chip(view)).not.toBeNull()
  requester.mockImplementation(async () => '4321')
  const fetch = stubRoute(vi.fn().mockReturnValueOnce(reply({ error: 'human_gate_key_required' }, 401)).mockReturnValue(reply({ ok: true, autopilotOff: false, item: answered(item, false) })))

  await click(box(view, item))

  expect(requester).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[0][1].headers['x-horizon-csrf']).toBe('1')
  expect(fetch.mock.calls[0][1].headers['x-human-key']).toBeUndefined()
  const [, init] = fetch.mock.calls[1]
  expect(init.headers['x-human-key']).toBe('4321')
  expect(JSON.parse(init.body)).toEqual({ off: false })
  expect(box(view, item).checked).toBe(false)
  expect(chip(view)).toBeNull()
  expect(acceptMeta(view)).not.toContain('Autopilot is off')
})

test('a cancelled PIN dialog sends nothing more: the box stays ticked and the chip stays', async () => {
  const item = atAccept({ autopilotOff: true })
  const view = open(item)
  const fetch = stubRoute(() => reply({ error: 'human_gate_key_required' }, 401))

  await click(box(view, item))

  expect(requester).toHaveBeenCalledTimes(1)
  // Only the PIN-less first request went out.
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0][1].headers['x-human-key']).toBeUndefined()
  expect(box(view, item).checked).toBe(true)
  expect(chip(view)).not.toBeNull()
  expect(toggleError(view).textContent).toContain('needs your gate PIN')
})

test('a wrong PIN (401) asks again, and cancelling leaves the item off and says so', async () => {
  const item = atAccept({ autopilotOff: true })
  const view = open(item)
  // The first dialog answers; the retry dialog after the 401 is cancelled.
  requester.mockResolvedValueOnce('wrong')
  const fetch = stubRoute(() => reply({ error: 'human_gate_key_required' }, 401))

  await click(box(view, item))

  expect(requester.mock.calls).toEqual([[{ retry: false }], [{ retry: true }]])
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[1][1].headers['x-human-key']).toBe('wrong')
  expect(box(view, item).checked).toBe(true)
  expect(chip(view)).not.toBeNull()
  expect(toggleError(view).textContent).toContain('needs your gate PIN')
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

// HO-900: the repo's backend comes from the per-repo setting the projects carry
// (GET /api/projects' repos[].backend), never from the item.
const projectsWith = (repo, backend) => [{ id: 1, name: 'FinTekkers', repos: [{ repo, backend }] }]
const SL_REASON = /not available on sl items/
const noBox = (view, item) => view.queryByRole('checkbox', { name: `Turn off Autopilot for ${item.id}` })

test('an open sl item with no issue in an Autopilot-on project says why, shows no box, and sends nothing', () => {
  const route = stubRoute(() => reply({ ok: true }))
  const item = atAccept({ issue: null, repo: 'Org/local' })
  const view = open(item, projectsWith('Org/local', 'sl'))
  expect(view.getByText(SL_REASON)).toBeTruthy()
  expect(noBox(view, item)).toBeNull()
  expect(route).not.toHaveBeenCalled()
})

test('an sl item never shows a live box, even when it carries an issue number', () => {
  const item = atAccept({ issue: 364, repo: 'Org/local' })
  const view = open(item, projectsWith('Org/local', 'sl'))
  expect(noBox(view, item)).toBeNull()
  expect(view.getByText(SL_REASON)).toBeTruthy()
})

test('a github repo keeps the unticked box and shows no sl reason', () => {
  const item = atAccept()
  const view = open(item, projectsWith('FinTekkers/ledger-models', 'github'))
  expect(box(view, item).checked).toBe(false)
  expect(view.queryByText(SL_REASON)).toBeNull()
})

test('a github item with no issue shows neither the box nor the sl reason', () => {
  const item = atAccept({ issue: null })
  const view = open(item, projectsWith('FinTekkers/ledger-models', 'github'))
  expect(noBox(view, item)).toBeNull()
  expect(view.queryByText(SL_REASON)).toBeNull()
})

test('a local item with no repo shows neither the box nor the sl reason', () => {
  const item = atAccept({ issue: null, repo: null })
  const view = open(item, projectsWith('Org/local', 'sl'))
  expect(noBox(view, item)).toBeNull()
  expect(view.queryByText(SL_REASON)).toBeNull()
})
