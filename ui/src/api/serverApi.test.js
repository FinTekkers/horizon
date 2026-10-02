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

test('a pre-merge check failure stays on the tracker instead of opening the PR (HZ-183)', async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  seedItem({ id: 'X4', cursor: 5, pr_url: 'https://github.com/org/repo/pull/9' })
  const body = { error: 'pre-merge checks failed: npm test --silent', premerge: true }
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve(body) })),
  )
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {})

  await expect(serverApi.approveGate('X4', '')).resolves.toEqual(body)
  expect(openSpy).not.toHaveBeenCalled()
})

// HZ-179: the token client hits the server's routes with the right verbs, and
// createApiToken leaves nothing behind in browser storage.
test('the API token client calls GET/POST/DELETE /api/tokens and stores nothing', async () => {
  const serverApi = await import('./serverApi')
  const fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ token: 'hz_secret', tokens: [] }) }),
  )
  vi.stubGlobal('fetch', fetchMock)

  await serverApi.listApiTokens()
  await serverApi.createApiToken({ name: 'ci-bot', expiresInDays: 30 })
  await serverApi.revokeApiToken('tok_1')

  const calls = fetchMock.mock.calls.map(([url, opts]) => [opts?.method || 'GET', url.replace(serverApi.API_BASE, '')])
  expect(calls).toEqual([
    ['GET', '/tokens'],
    ['POST', '/tokens'],
    ['DELETE', '/tokens/tok_1'],
  ])
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ name: 'ci-bot', expiresInDays: 30 })
  expect(JSON.stringify({ ...localStorage })).not.toContain('hz_secret')
  expect(JSON.stringify({ ...sessionStorage })).not.toContain('hz_secret')
})

// HZ-208: the enabled switch's client. POST with the PIN in the header only —
// never the URL, never localStorage (gatePost would have cached it there).
test('setProjectEnabled POSTs {enabled} with the PIN in x-human-key only, and stores nothing', async () => {
  localStorage.clear()
  const serverApi = await import('./serverApi')
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, enabled: false }) }))
  vi.stubGlobal('fetch', fetchSpy)

  await expect(serverApi.setProjectEnabled(7, false, 'pin-1234')).resolves.toEqual({ ok: true, enabled: false })
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  const [url, opts] = fetchSpy.mock.calls[0]
  expect(url).toBe(`${serverApi.API_BASE}/projects/7/enabled`)
  expect(String(url)).not.toContain('pin-1234')
  expect(opts.method).toBe('POST')
  expect(opts.headers['Content-Type']).toBe('application/json')
  expect(opts.headers['x-human-key']).toBe('pin-1234')
  expect(JSON.parse(opts.body)).toEqual({ enabled: false })
  expect(localStorage.length).toBe(0)
})

test('setProjectEnabled throws the server’s error text on a 401', async () => {
  localStorage.clear()
  const serverApi = await import('./serverApi')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'human_gate_key_required' }) })),
  )
  const err = await serverApi.setProjectEnabled(7, true, 'bad').catch((e) => e)
  expect(err.message).toBe('human_gate_key_required')
  expect(err.status).toBe(401)
  expect(localStorage.length).toBe(0)
})
