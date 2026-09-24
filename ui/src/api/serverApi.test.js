// HZ-62: serverApi.approveGate's null-guard (gatePost can resolve to `null`
// on a fetch rejection or an abandoned PIN prompt) previously crashed with an
// unhandled rejection instead of returning a clean `{ ok: false }` — which
// would have defeated the guardrail that a failed approval must never
// navigate the user away. This file pins that branch down directly, since
// App.test.jsx mocks the whole `./api` module and never exercises the real
// serverApi code.

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

class MockEventSource {
  constructor(url) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  close() {}
}
MockEventSource.instances = []

// serverApi keeps its `items` cache as module-private state, only ever
// populated by an SSE snapshot. Simulate the server pushing one down so
// approveGate has something to look up by id.
function seedItem(item) {
  const source = MockEventSource.instances.at(-1)
  source.onmessage({ data: JSON.stringify({ items: [item] }) })
}

beforeEach(() => {
  MockEventSource.instances = []
  vi.stubGlobal('EventSource', MockEventSource)
  localStorage.setItem('horizon_gate_pin', 'test-pin')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  vi.resetModules()
})

test('a fetch rejection during approve resolves to { ok: false } instead of throwing', async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  seedItem({ id: 'X1', cursor: 3, pr_url: null })
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))))

  await expect(serverApi.approveGate('X1', 'notes')).resolves.toEqual({ ok: false })
})

test('a successful approval parses and returns the response body', async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  seedItem({ id: 'X2', cursor: 3, pr_url: null })
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, closed: true }) }),
    ),
  )

  await expect(serverApi.approveGate('X2', '')).resolves.toEqual({ ok: true, closed: true })
})

test('a non-401 approval failure opens the PR tab and still returns the parsed body', async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  seedItem({ id: 'X3', cursor: 5, pr_url: 'https://github.com/org/repo/pull/9' })
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: 'merge_conflict' }) }),
    ),
  )
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {})

  await expect(serverApi.approveGate('X3', '')).resolves.toEqual({ error: 'merge_conflict' })
  expect(openSpy).toHaveBeenCalledWith('https://github.com/org/repo/pull/9', '_blank', 'noopener')
})
