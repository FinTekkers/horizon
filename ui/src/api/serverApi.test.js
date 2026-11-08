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
    this.listeners = {}
    this.readyState = MockEventSource.CONNECTING
    MockEventSource.instances.push(this)
    MockEventSource.log.push(`open ${MockEventSource.instances.length - 1}`)
  }
  // HZ-318: named `snapshot` and `delta` events.
  addEventListener(type, fn) {
    this.listeners[type] = fn
  }
  dispatch(type, data) {
    this.listeners[type]({ data: JSON.stringify(data) })
  }
  // HZ-388: the browser's own open, so the stream counts as live.
  open() {
    this.readyState = MockEventSource.OPEN
    this.onopen?.()
  }
  close() {
    this.readyState = MockEventSource.CLOSED
    MockEventSource.log.push(`close ${MockEventSource.instances.indexOf(this)}`)
  }
}
MockEventSource.CONNECTING = 0
MockEventSource.OPEN = 1
MockEventSource.CLOSED = 2
MockEventSource.instances = []
// Every construct and close by instance index, in order ('open 0', 'close 0',
// …) — proves the old stream closed before the new one opened.
MockEventSource.log = []

// serverApi keeps its `items` cache as module-private state, only ever
// populated by an SSE snapshot. Simulate the server pushing one down so
// approveGate has something to look up by id.
function seedItem(item) {
  const source = MockEventSource.instances.at(-1)
  source.onmessage({ data: JSON.stringify({ items: [item] }) })
}

// vi.resetModules() gives each test a fresh serverApi, but its
// visibilitychange listener would stay on `document` and fire into later
// tests. Track them so afterEach can take them off.
let documentListeners = []

beforeEach(() => {
  MockEventSource.instances = []
  MockEventSource.log = []
  vi.stubGlobal('EventSource', MockEventSource)
  const add = document.addEventListener.bind(document)
  vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, options) => {
    documentListeners.push([type, fn, options])
    add(type, fn, options)
  })
})

afterEach(async () => {
  ;(await import('./serverApi')).setPinRequester(null)
  documentListeners.forEach(([type, fn, options]) => document.removeEventListener(type, fn, options))
  documentListeners = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  vi.resetModules()
})

// HZ-704: the server's 401 to a protected request that carried no PIN, or a
// wrong one.
const pinRequired = () => ({ ok: false, status: 401, json: async () => ({ error: 'human_gate_key_required' }) })

// HZ-704: the PIN dialog, answering `pins` in turn and then cancelling (null).
function answerPins(serverApi, ...pins) {
  const requester = vi.fn()
  pins.forEach((pin) => requester.mockResolvedValueOnce(pin))
  requester.mockResolvedValue(null)
  serverApi.setPinRequester(requester)
  return requester
}

// HZ-704: a protected request goes out first with no PIN, same-origin marked.
function expectPinless(opts) {
  expect(opts.headers['x-horizon-csrf']).toBe('1')
  expect(opts.headers).not.toHaveProperty('x-human-key')
}

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

// HZ-384: Approve the run asks for the PIN like every gate, and sends the
// hash of the run plan the card showed so a newer plan is never approved
// unseen. HZ-491: and the runner it showed.
test("approving a Task prompts for the PIN and sends the shown run plan's hash and runner", async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  seedItem({ id: 'TK-9', kind: 'task', cursor: 23, pr_url: null, runPlan: { commands: 3, budgetMinutes: 20, hash: 'plan-hash-1', runner: 'host' } })
  const requester = answerPins(serverApi, '271828')
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pinRequired())
    .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, closed: false }) })
  vi.stubGlobal('fetch', fetchMock)

  await expect(serverApi.approveGate('TK-9', '')).resolves.toEqual({ ok: true, closed: false })
  expect(requester).toHaveBeenCalledTimes(1)
  expect(requester).toHaveBeenCalledWith({ retry: false })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expectPinless(fetchMock.mock.calls[0][1])
  const [url, init] = fetchMock.mock.calls[1]
  expect(url).toContain('/items/TK-9/move')
  expect(init.headers['x-human-key']).toBe('271828')
  expect(JSON.parse(init.body)).toEqual({ action: 'approve', from: 'task.approve-run', planHash: 'plan-hash-1', runner: 'host' })
})

// HZ-541: the first gate sends the hash of the golden-cases set the tab
// showed, so a regenerated set is never approved unseen. An approved set, or
// another gate, sends none.
test('approving the first gate sends the shown golden-cases hash, and only there', async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  const goldenCases = { hash: 'golden-hash-1', approved: false, gateIndex: 3, cases: [] }
  const items = [
    { id: 'GC-1', cursor: 3, pr_url: null, goldenCases },
    { id: 'GC-2', cursor: 5, pr_url: null, goldenCases },
    { id: 'GC-3', cursor: 3, pr_url: null, goldenCases: { ...goldenCases, approved: true } },
  ]
  MockEventSource.instances.at(-1).onmessage({ data: JSON.stringify({ items }) })
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, closed: false }) }))
  vi.stubGlobal('fetch', fetchMock)

  await serverApi.approveGate('GC-1', '')
  await serverApi.approveGate('GC-2', '')
  await serverApi.approveGate('GC-3', '')
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
    { action: 'approve', from: 'change.approve-prioritize', goldenHash: 'golden-hash-1' },
    { action: 'approve', from: 'change.approve-design' },
    { action: 'approve', from: 'change.approve-prioritize' },
  ])
})

// HZ-642: Approve & file's Autopilot choice goes in the approval body at that
// gate only; any other gate's approval sends no filedAutopilot key.
test('approving Approve & file sends filedAutopilot, and no other gate does', async () => {
  const { APPROVE_FILE_GATE_INDEX } = await import('../../../domain/js/lifecycle.js')
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  const items = [
    { id: 'PL-1', kind: 'plan', cursor: APPROVE_FILE_GATE_INDEX, pr_url: null },
    { id: 'PL-2', kind: 'plan', cursor: APPROVE_FILE_GATE_INDEX, pr_url: null },
    { id: 'CH-1', cursor: 3, pr_url: null },
  ]
  MockEventSource.instances.at(-1).onmessage({ data: JSON.stringify({ items }) })
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, closed: false }) }))
  vi.stubGlobal('fetch', fetchMock)

  await serverApi.approveGate('PL-1', '', { filedAutopilot: 'off' })
  await serverApi.approveGate('PL-2', '')
  await serverApi.approveGate('CH-1', '', { filedAutopilot: 'off' })
  expect(fetchMock.mock.calls.map(([url]) => url.replace(serverApi.API_BASE, ''))).toEqual([
    '/items/PL-1/move',
    '/items/PL-2/move',
    '/items/CH-1/move',
  ])
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
    { action: 'approve', from: 'plan.approve-file', filedAutopilot: 'off' },
    { action: 'approve', from: 'plan.approve-file', filedAutopilot: 'default' },
    { action: 'approve', from: 'change.approve-prioritize' },
  ])
})

// HZ-709: a gate is named by its permanent key — the snapshot's
// currentStepKey — never by its position. HZ-711: an approve is a move, so the
// key goes in the body as `from`, and the notes as `note`.
test('approving posts an approve move from <currentStepKey>, with no numeric step segment or index', async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  seedItem({ id: 'KEY-1', cursor: 13, currentStepKey: 'change.accept-code', pr_url: null })
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, closed: false }) }))
  vi.stubGlobal('fetch', fetchMock)

  await serverApi.approveGate('KEY-1', 'ship it')
  const [url, init] = fetchMock.mock.calls[0]
  const path = url.replace(serverApi.API_BASE, '')
  expect(path).toBe('/items/KEY-1/move')
  expect(path.split('/').some((segment) => /^\d+$/.test(segment))).toBe(false)
  const body = JSON.parse(init.body)
  expect(body).toEqual({ action: 'approve', from: 'change.accept-code', note: 'ship it' })
  expect(Object.values(body).some((value) => typeof value === 'number')).toBe(false)
})

// HZ-711: a Return to or Retry is one move, named by step keys only: `stepKey`
// the target the tab picked from the item's moves (HZ-799), `from` the step
// the tab shows the item at. No numeric step segment and no step index is sent.
test('moveItem posts { stepKey, from, note } by step key, with no numeric step segment or index', async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  seedItem({ id: 'KEY-2', cursor: 13, currentStepKey: 'change.accept-code', pr_url: null })
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }))
  vi.stubGlobal('fetch', fetchMock)

  await expect(serverApi.moveItem('KEY-2', { stepKey: 'change.draft-plan', note: 'redo' })).resolves.toEqual({ ok: true })
  const [url, init] = fetchMock.mock.calls[0]
  const path = url.replace(serverApi.API_BASE, '')
  expect(path).toBe('/items/KEY-2/move')
  expect(path.split('/').some((segment) => /^\d+$/.test(segment))).toBe(false)
  const body = JSON.parse(init.body)
  expect(body).toEqual({ stepKey: 'change.draft-plan', from: 'change.accept-code', note: 'redo' })
  expect(Object.values(body).some((value) => typeof value === 'number')).toBe(false)
})

// Without the snapshot's currentStepKey, `from` is the key at the cursor.
test('moveItem names `from` by the key at the cursor when the snapshot has no currentStepKey', async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  seedItem({ id: 'KEY-3', cursor: 7, pr_url: null })
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }))
  vi.stubGlobal('fetch', fetchMock)

  await serverApi.moveItem('KEY-3', { stepKey: 'change.arch-review' })
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ stepKey: 'change.arch-review', from: 'change.arch-review', note: '' })
})

test('moveItem and abandonItem reject with not_found for an item this tab has not seen, sending nothing', async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)

  await expect(serverApi.moveItem('NOPE-1', { stepKey: 'change.arch-review' })).rejects.toThrow('not_found')
  await expect(serverApi.abandonItem('NOPE-1', 'why')).rejects.toThrow('not_found')
  expect(fetchMock).not.toHaveBeenCalled()
})

// HZ-389: a 2xx answer's item replaces the cached one at once, and its
// `restart` is kept for the step card — by step key — via getRestartSent.
test("moveItem applies the answer's item and records its restart for getRestartSent", async () => {
  const serverApi = await import('./serverApi')
  const changed = vi.fn()
  serverApi.subscribe(changed)
  seedItem({ id: 'MV-1', cursor: 13, currentStepKey: 'change.accept-code', pr_url: null, last_activity_at: '2026-11-05T10:00:00.000Z' })
  const answered = { id: 'MV-1', cursor: 11, currentStepKey: 'change.implement', pr_url: null, last_activity_at: '2026-11-05T10:00:05.000Z' }
  const restart = { stepIndex: 11, stepKey: 'change.implement', attempt: 3 }
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, item: answered, restart }) })))
  changed.mockClear()

  await serverApi.moveItem('MV-1', { stepKey: 'change.implement', note: 'fix it' })
  expect(serverApi.getItems().find((it) => it.id === 'MV-1')).toEqual(answered)
  expect(serverApi.getRestartSent('MV-1')).toEqual(restart)
  expect(changed).toHaveBeenCalled()
})

// An answer older than the cached item (a delta landed first) is not applied,
// but its restart is still recorded.
test("moveItem keeps a newer cached item over a stale answer's, and still records the restart", async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  const cached = { id: 'MV-2', cursor: 12, currentStepKey: 'change.auto-review', pr_url: null, last_activity_at: '2026-11-05T10:00:09.000Z' }
  seedItem(cached)
  const answered = { id: 'MV-2', cursor: 11, currentStepKey: 'change.implement', pr_url: null, last_activity_at: '2026-11-05T10:00:05.000Z' }
  const restart = { stepIndex: 11, stepKey: 'change.implement', attempt: 2 }
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, item: answered, restart }) })))

  await serverApi.moveItem('MV-2', { stepKey: 'change.auto-review' })
  expect(serverApi.getItems().find((it) => it.id === 'MV-2')).toEqual(cached)
  expect(serverApi.getRestartSent('MV-2')).toEqual(restart)
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
// never the URL, never storage. HZ-704: the PIN comes from the dialog, asked
// only after the first, PIN-less request is refused.
test('setProjectEnabled POSTs {enabled} with the PIN in x-human-key only, and stores nothing', async () => {
  localStorage.clear()
  const serverApi = await import('./serverApi')
  const requester = answerPins(serverApi, 'pin-1234')
  const fetchSpy = vi
    .fn()
    .mockResolvedValueOnce(pinRequired())
    .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, enabled: false }) })
  vi.stubGlobal('fetch', fetchSpy)

  await expect(serverApi.setProjectEnabled(7, false)).resolves.toEqual({ ok: true, enabled: false })
  expect(requester).toHaveBeenCalledTimes(1)
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expectPinless(fetchSpy.mock.calls[0][1])
  const [url, opts] = fetchSpy.mock.calls[1]
  expect(url).toBe(`${serverApi.API_BASE}/projects/7/enabled`)
  expect(String(url)).not.toContain('pin-1234')
  expect(opts.method).toBe('POST')
  expect(opts.headers['Content-Type']).toBe('application/json')
  expect(opts.headers['x-human-key']).toBe('pin-1234')
  expect(JSON.parse(opts.body)).toEqual({ enabled: false })
  expect(localStorage.length).toBe(0)
})

// HZ-245: the check-commands save — PUT, the PIN in x-human-key only.
test('saveRepoChecks PUTs {repo, ...checks} with the PIN in x-human-key only, and stores nothing', async () => {
  localStorage.clear()
  const serverApi = await import('./serverApi')
  answerPins(serverApi, 'pin-1234')
  const reply = { ok: true, repo: 'acme/web', checks: { install: 'npm ci', test: 'npm test', lint: null, e2e: null } }
  const fetchSpy = vi.fn().mockResolvedValueOnce(pinRequired()).mockResolvedValue({ ok: true, status: 200, json: async () => reply })
  vi.stubGlobal('fetch', fetchSpy)

  const checks = { install: 'npm ci', test: 'npm test', lint: '', e2e: '' }
  await expect(serverApi.saveRepoChecks(7, 'acme/web', checks)).resolves.toEqual(reply)
  expectPinless(fetchSpy.mock.calls[0][1])
  const [url, opts] = fetchSpy.mock.calls[1]
  expect(url).toBe(`${serverApi.API_BASE}/projects/7/repos/checks`)
  expect(String(url)).not.toContain('pin-1234')
  expect(opts.method).toBe('PUT')
  expect(opts.headers['x-human-key']).toBe('pin-1234')
  expect(JSON.parse(opts.body)).toEqual({ repo: 'acme/web', ...checks })
  expect(localStorage.length).toBe(0)
})

// HZ-304: the 'no checks' / 'no deploy' marks — PUT, the PIN in x-human-key only.
test('saveRepoMarks PUTs {repo, ...marks} with the PIN in x-human-key only, stores nothing, and throws 401s', async () => {
  localStorage.clear()
  const serverApi = await import('./serverApi')
  answerPins(serverApi, 'pin-1234')
  const reply = { ok: true, repo: 'acme/web', marks: { noChecks: true, noDeploy: false } }
  const fetchSpy = vi.fn().mockResolvedValueOnce(pinRequired()).mockResolvedValue({ ok: true, status: 200, json: async () => reply })
  vi.stubGlobal('fetch', fetchSpy)

  await expect(serverApi.saveRepoMarks(7, 'acme/web', { noChecks: true })).resolves.toEqual(reply)
  expectPinless(fetchSpy.mock.calls[0][1])
  const [url, opts] = fetchSpy.mock.calls[1]
  expect(url).toBe(`${serverApi.API_BASE}/projects/7/repos/marks`)
  expect(String(url)).not.toContain('pin-1234')
  expect(opts.method).toBe('PUT')
  expect(opts.headers['x-human-key']).toBe('pin-1234')
  expect(JSON.parse(opts.body)).toEqual({ repo: 'acme/web', noChecks: true })
  expect(opts.body).not.toContain('pin-1234')
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)

  // A wrong PIN, then a cancelled dialog: rejects with the 401 on the error.
  answerPins(serverApi, 'bad')
  vi.stubGlobal('fetch', vi.fn(async () => pinRequired()))
  const err = await serverApi.saveRepoMarks(7, 'acme/web', { noDeploy: true }).catch((e) => e)
  expect(err.message).toBe('pin_needed')
  expect(err.response.status).toBe(401)
})

// HZ-494: the test-login env file — a path only, the PIN in x-human-key only.
test('saveRepoTestEnvFile PUTs {repo, path} with the PIN in x-human-key only, and throws 400s', async () => {
  localStorage.clear()
  const serverApi = await import('./serverApi')
  answerPins(serverApi, 'pin-1234')
  const reply = { ok: true, repo: 'acme/web', testEnvFile: '/etc/acme/e2e.env' }
  const fetchSpy = vi.fn().mockResolvedValueOnce(pinRequired()).mockResolvedValue({ ok: true, status: 200, json: async () => reply })
  vi.stubGlobal('fetch', fetchSpy)

  await expect(serverApi.saveRepoTestEnvFile(7, 'acme/web', '/etc/acme/e2e.env')).resolves.toEqual(reply)
  expectPinless(fetchSpy.mock.calls[0][1])
  const [url, opts] = fetchSpy.mock.calls[1]
  expect(url).toBe(`${serverApi.API_BASE}/projects/7/repos/test-env`)
  expect(opts.method).toBe('PUT')
  expect(opts.headers['x-human-key']).toBe('pin-1234')
  expect(JSON.parse(opts.body)).toEqual({ repo: 'acme/web', path: '/etc/acme/e2e.env' })
  expect(localStorage.length).toBe(0)

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'Path must be absolute and normalised' }) })),
  )
  const err = await serverApi.saveRepoTestEnvFile(7, 'acme/web', 'relative.env').catch((e) => e)
  expect(err.message).toBe('Path must be absolute and normalised')
  expect(err.status).toBe(400)
})

test('dryRunDeployTarget POSTs an empty body with the PIN in x-human-key only, and throws 401s', async () => {
  localStorage.clear()
  const serverApi = await import('./serverApi')
  answerPins(serverApi, '1234')
  const reply = { key: 'horizon', ranAt: '2026-10-03T12:00:00.000Z', results: [] }
  const fetchSpy = vi.fn().mockResolvedValueOnce(pinRequired()).mockResolvedValue({ ok: true, status: 200, json: async () => reply })
  vi.stubGlobal('fetch', fetchSpy)

  await expect(serverApi.dryRunDeployTarget('horizon')).resolves.toEqual(reply)
  expectPinless(fetchSpy.mock.calls[0][1])
  const [url, opts] = fetchSpy.mock.calls[1]
  expect(url).toBe(`${serverApi.API_BASE}/admin/deploy-targets/horizon/dry-run`)
  expect(String(url)).not.toContain('1234')
  expect(opts.method).toBe('POST')
  expect(opts.headers['x-human-key']).toBe('1234')
  expect(JSON.parse(opts.body)).toEqual({})
  expect(localStorage.length).toBe(0)

  // A wrong PIN, then a cancelled dialog: rejects with the 401 on the error.
  answerPins(serverApi, 'bad')
  vi.stubGlobal('fetch', vi.fn(async () => pinRequired()))
  const err = await serverApi.dryRunDeployTarget('horizon').catch((e) => e)
  expect(err.message).toBe('pin_needed')
  expect(err.response.status).toBe(401)
})

// A 401 no PIN can answer (a lost login) never opens the dialog.
test('setProjectEnabled throws the server’s error text on a 401', async () => {
  localStorage.clear()
  const serverApi = await import('./serverApi')
  const requester = answerPins(serverApi, 'pin-1234')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'login_required' }) })),
  )
  const err = await serverApi.setProjectEnabled(7, true).catch((e) => e)
  expect(err.message).toBe('login_required')
  expect(err.status).toBe(401)
  expect(requester).not.toHaveBeenCalled()
  expect(localStorage.length).toBe(0)
})

// ---- HZ-259: deploy target create / edit / delete — PIN in x-human-key only ----

const PIN = 'pin-5678'
const DOCS_FIELDS = {
  repo: 'FinTekkers/docs',
  script: 'deploy-docs.sh',
  service: 'fintekkers-docs',
  repoDir: '/opt/fintekkers/docs',
  stateKey: 'docs',
  healthUrl: 'https://docs.example/',
  healthCheckType: 'http-200',
}

// HZ-704: the first request carries no PIN; the one after its 401 carries the
// dialog's PIN, in the header only.
function expectPinInHeaderOnly(fetchSpy) {
  expectPinless(fetchSpy.mock.calls[0][1])
  const [url, opts] = fetchSpy.mock.calls[1]
  expect(opts.headers['x-human-key']).toBe(PIN)
  expect(String(url)).not.toContain(PIN)
  expect(String(opts.body ?? '')).not.toContain(PIN)
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
}

async function expectPinlessError(call) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'deploy_target_invalid', reason: 'service x not in horizon-deploy.sudoers' }),
    })),
  )
  const err = await call().catch((e) => e)
  expect(err.status).toBe(400)
  expect(err.code).toBe('deploy_target_invalid')
  expect(err.reason).toBe('service x not in horizon-deploy.sudoers')
  expect(JSON.stringify({ message: err.message, code: err.code, reason: err.reason })).not.toContain(PIN)
}

test('createDeployTarget POSTs the target with the PIN in x-human-key only', async () => {
  localStorage.clear()
  sessionStorage.clear()
  const serverApi = await import('./serverApi')
  answerPins(serverApi, PIN)
  const fetchSpy = vi.fn().mockResolvedValueOnce(pinRequired()).mockResolvedValue({ ok: true, status: 201, json: async () => ({ ok: true }) })
  vi.stubGlobal('fetch', fetchSpy)

  const target = { key: 'docs', ...DOCS_FIELDS }
  await expect(serverApi.createDeployTarget(target)).resolves.toEqual({ ok: true })
  const [url, opts] = fetchSpy.mock.calls[1]
  expect(url).toBe(`${serverApi.API_BASE}/admin/deploy-targets`)
  expect(opts.method).toBe('POST')
  expect(JSON.parse(opts.body)).toEqual(target)
  expectPinInHeaderOnly(fetchSpy)
  await expectPinlessError(() => serverApi.createDeployTarget(target))
})

test('updateDeployTarget PUTs the fields to the key path with the PIN in x-human-key only', async () => {
  localStorage.clear()
  sessionStorage.clear()
  const serverApi = await import('./serverApi')
  answerPins(serverApi, PIN)
  const fetchSpy = vi.fn().mockResolvedValueOnce(pinRequired()).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
  vi.stubGlobal('fetch', fetchSpy)

  await serverApi.updateDeployTarget('docs', DOCS_FIELDS)
  const [url, opts] = fetchSpy.mock.calls[1]
  expect(url).toBe(`${serverApi.API_BASE}/admin/deploy-targets/docs`)
  expect(opts.method).toBe('PUT')
  expect(JSON.parse(opts.body)).toEqual(DOCS_FIELDS)
  expectPinInHeaderOnly(fetchSpy)
  await expectPinlessError(() => serverApi.updateDeployTarget('docs', DOCS_FIELDS))
})

test('deleteDeployTarget sends DELETE with no body and the PIN in x-human-key only', async () => {
  localStorage.clear()
  sessionStorage.clear()
  const serverApi = await import('./serverApi')
  answerPins(serverApi, PIN)
  const fetchSpy = vi.fn().mockResolvedValueOnce(pinRequired()).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
  vi.stubGlobal('fetch', fetchSpy)

  await serverApi.deleteDeployTarget('docs')
  const [url, opts] = fetchSpy.mock.calls[1]
  expect(url).toBe(`${serverApi.API_BASE}/admin/deploy-targets/docs`)
  expect(opts.method).toBe('DELETE')
  expect(opts.body).toBeUndefined()
  expect(opts.headers['Content-Type']).toBeUndefined()
  expectPinInHeaderOnly(fetchSpy)
  await expectPinlessError(() => serverApi.deleteDeployTarget('docs'))
})

// HZ-230: the Board's usual-duration hint reads HZ-229's durationEstimates
// straight off the snapshot — no fetch of its own.
test('getDurationEstimates returns the snapshot estimates and keeps them across a snapshot without the field', async () => {
  const fetchSpy = vi.fn(() => Promise.reject(new Error('no fetch expected')))
  vi.stubGlobal('fetch', fetchSpy)
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  expect(serverApi.getDurationEstimates()).toBeNull()

  const estimates = { 7: { medianSec: 1200, count: 5 }, premerge: null, resolve: null }
  const source = MockEventSource.instances.at(-1)
  source.onmessage({ data: JSON.stringify({ items: [], durationEstimates: estimates }) })
  expect(serverApi.getDurationEstimates()).toEqual(estimates)

  // The concierge's /api/farm/snapshot shape carries no durationEstimates.
  source.onmessage({ data: JSON.stringify({ items: [] }) })
  expect(serverApi.getDurationEstimates()).toEqual(estimates)
  expect(fetchSpy).not.toHaveBeenCalled()
})

// ---- HZ-310: removeDependency posts one edge and surfaces failures ----

test('removeDependency POSTs {dependsOnId} to the item\'s remove route and rejects on a 404', async () => {
  const serverApi = await import('./serverApi')
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
  vi.stubGlobal('fetch', fetchSpy)

  await expect(serverApi.removeDependency('X-1', 'X-B')).resolves.toEqual({ ok: true })
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  const [url, opts] = fetchSpy.mock.calls[0]
  expect(url).toBe(`${serverApi.API_BASE}/items/X-1/dependencies/remove`)
  expect(opts.method).toBe('POST')
  expect(JSON.parse(opts.body)).toEqual({ dependsOnId: 'X-B' })

  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'not_found' }) })))
  await expect(serverApi.removeDependency('X-1', 'X-B')).rejects.toThrow('not_found')
})

// ---- HZ-318: the slim feed — named snapshot/delta events ----

test('the stream opens with ?v=2 and a `snapshot` event replaces the board', async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  const source = MockEventSource.instances.at(-1)
  expect(source.url).toBe(`${serverApi.API_BASE}/stream?v=2`)
  source.dispatch('snapshot', { items: [{ id: 'A' }, { id: 'B' }], activeProjectId: 4 })
  expect(serverApi.getItems().map((it) => it.id)).toEqual(['A', 'B'])
  expect(serverApi.getActiveProjectId()).toBe(4)
})

test('a default `message` frame (a server from before HZ-318) still applies as a whole board', async () => {
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  const source = MockEventSource.instances.at(-1)
  source.dispatch('snapshot', { items: [{ id: 'A' }, { id: 'B' }] })
  source.onmessage({ data: JSON.stringify({ items: [{ id: 'C', stepOutputs: {} }] }) })
  expect(serverApi.getItems()).toEqual([{ id: 'C', stepOutputs: {} }])
})

test('a `delta` merges upserts, drops removed ids and keeps unchanged items as the same objects', async () => {
  const serverApi = await import('./serverApi')
  const seen = vi.fn()
  serverApi.subscribe(seen)
  const source = MockEventSource.instances.at(-1)
  source.dispatch('snapshot', {
    items: [{ id: 'A', title: 'a' }, { id: 'B', title: 'b' }, { id: 'C', title: 'c' }],
    farm: { status: 'running' },
    projects: [{ id: 1 }],
  })
  const [a, , c] = serverApi.getItems()

  source.dispatch('delta', { upserts: [{ id: 'B', title: 'b2' }], removed: [], top: { farm: { status: 'paused' } } })
  let items = serverApi.getItems()
  expect(items.map((it) => it.title)).toEqual(['a', 'b2', 'c'])
  expect(items[0]).toBe(a)
  expect(items[2]).toBe(c)
  expect(serverApi.getFarm()).toEqual({ status: 'paused' })
  expect(serverApi.getProjects()).toEqual([{ id: 1 }])

  source.dispatch('delta', { upserts: [{ id: 'AA', title: 'new' }], removed: ['C'], top: {}, order: ['A', 'AA', 'B'] })
  items = serverApi.getItems()
  expect(items.map((it) => it.id)).toEqual(['A', 'AA', 'B'])
  expect(items[0]).toBe(a)
  expect(seen).toHaveBeenCalledTimes(3)
})

test('subscribeStepOutputs opens the item\'s own stream, passes each `outputs` frame on, and closes it', async () => {
  const serverApi = await import('./serverApi')
  const outputs = { 4: { output: 'done', attempt: 1, artifact: null, attemptCount: 0, label: 'x' } }
  const seen = vi.fn()
  const close = serverApi.subscribeStepOutputs('X 1', seen)
  const stream = MockEventSource.instances.at(-1)
  expect(stream.url).toBe(`${serverApi.API_BASE}/items/X%201/stream`)
  stream.dispatch('outputs', { id: 'X 1', stepOutputs: outputs })
  expect(seen).toHaveBeenCalledWith(outputs)
  stream.close = vi.fn()
  close()
  expect(stream.close).toHaveBeenCalled()
})

// ---- HZ-388: a stalled stream is noticed within 45 s and replaced ----

// 45 s of silence trips the watchdog; the first reconnect waits the 1 s backoff.
const STALL_MS = 45_000

test('a silent board stream closes after 45 s, exactly one new stream opens after the backoff, and its snapshot applies', async () => {
  vi.useFakeTimers()
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  const [first] = MockEventSource.instances
  // Never opens: a stall while CONNECTING is replaced too.
  vi.advanceTimersByTime(STALL_MS - 1)
  expect(first.readyState).toBe(MockEventSource.CONNECTING)
  vi.advanceTimersByTime(1)
  expect(first.readyState).toBe(MockEventSource.CLOSED)
  expect(MockEventSource.instances).toHaveLength(1)

  vi.advanceTimersByTime(1_000)
  expect(MockEventSource.instances).toHaveLength(2)
  const second = MockEventSource.instances[1]
  expect(second.url).toBe(`${serverApi.API_BASE}/stream?v=2`)
  expect(MockEventSource.log.indexOf('close 0')).toBeLessThan(MockEventSource.log.indexOf('open 1'))
  expect(MockEventSource.log.filter((e) => e.startsWith('open'))).toEqual(['open 0', 'open 1'])

  second.open()
  second.dispatch('snapshot', { items: [{ id: 'NOW', title: 'current' }] })
  expect(serverApi.getItems()).toEqual([{ id: 'NOW', title: 'current' }])

  vi.advanceTimersByTime(30_000)
  expect(MockEventSource.instances).toHaveLength(2)
  expect(first.readyState).toBe(MockEventSource.CLOSED)
})

test('a silent item stream reopens once after 45 s and passes its outputs frame on', async () => {
  vi.useFakeTimers()
  const serverApi = await import('./serverApi')
  const seen = vi.fn()
  serverApi.subscribeStepOutputs('X-1', seen)
  const [first] = MockEventSource.instances
  first.open()
  first.dispatch('outputs', { id: 'X-1', stepOutputs: { 0: { output: 'old' } } })

  vi.advanceTimersByTime(STALL_MS)
  expect(first.readyState).toBe(MockEventSource.CLOSED)
  vi.advanceTimersByTime(1_000)
  expect(MockEventSource.instances).toHaveLength(2)
  const second = MockEventSource.instances[1]
  expect(second.url).toBe(`${serverApi.API_BASE}/items/X-1/stream`)
  expect(MockEventSource.log.indexOf('close 0')).toBeLessThan(MockEventSource.log.indexOf('open 1'))
  expect(MockEventSource.log.filter((e) => e.startsWith('open'))).toEqual(['open 0', 'open 1'])

  second.dispatch('outputs', { id: 'X-1', stepOutputs: { 0: { output: 'new' } } })
  expect(seen).toHaveBeenLastCalledWith({ 0: { output: 'new' } })
})

test('the item stream recovers from a second stall after the doubled backoff', async () => {
  vi.useFakeTimers()
  const serverApi = await import('./serverApi')
  const seen = vi.fn()
  serverApi.subscribeStepOutputs('X-1', seen)
  vi.advanceTimersByTime(STALL_MS + 1_000)
  expect(MockEventSource.instances).toHaveLength(2)

  // The second stream stalls as well, before it ever opens.
  vi.advanceTimersByTime(STALL_MS)
  expect(MockEventSource.instances[1].readyState).toBe(MockEventSource.CLOSED)
  vi.advanceTimersByTime(1_999)
  expect(MockEventSource.instances).toHaveLength(2)
  vi.advanceTimersByTime(1)
  expect(MockEventSource.instances).toHaveLength(3)
  const third = MockEventSource.instances[2]
  third.dispatch('outputs', { id: 'X-1', stepOutputs: { 1: { output: 'third' } } })
  expect(seen).toHaveBeenLastCalledWith({ 1: { output: 'third' } })
})

test('a heartbeat every 15 s for 3 minutes reconnects neither stream and touches no state', async () => {
  vi.useFakeTimers()
  const serverApi = await import('./serverApi')
  const listener = vi.fn()
  serverApi.subscribe(listener)
  const board = MockEventSource.instances[0]
  board.open()
  board.dispatch('snapshot', { items: [{ id: 'A' }] })
  const items = serverApi.getItems()
  const seen = vi.fn()
  serverApi.subscribeStepOutputs('X-1', seen)
  const item = MockEventSource.instances[1]
  item.open()
  item.dispatch('outputs', { id: 'X-1', stepOutputs: {} })
  expect(listener).toHaveBeenCalledTimes(1)
  expect(seen).toHaveBeenCalledTimes(1)

  for (let beat = 0; beat < 12; beat++) {
    vi.advanceTimersByTime(15_000)
    board.dispatch('heartbeat', {})
    item.dispatch('heartbeat', {})
  }
  vi.advanceTimersByTime(STALL_MS - 1)

  expect(MockEventSource.instances).toEqual([board, item])
  expect(board.readyState).toBe(MockEventSource.OPEN)
  expect(item.readyState).toBe(MockEventSource.OPEN)
  expect(serverApi.getItems()).toBe(items)
  expect(listener).toHaveBeenCalledTimes(1)
  expect(seen).toHaveBeenCalledTimes(1)
})

test('a tab focus while a watchdog reconnect is pending opens no second stream', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  vi.advanceTimersByTime(STALL_MS)
  expect(MockEventSource.instances[0].readyState).toBe(MockEventSource.CLOSED)

  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  document.dispatchEvent(new Event('visibilitychange'))
  expect(MockEventSource.instances).toHaveLength(1)

  vi.advanceTimersByTime(1_000)
  expect(MockEventSource.instances).toHaveLength(2)
  const open = MockEventSource.instances.filter((es) => es.readyState !== MockEventSource.CLOSED)
  expect(open).toEqual([MockEventSource.instances[1]])
})

test('a board onerror (CLOSED) and a watchdog stall share one reconnect', async () => {
  vi.useFakeTimers()
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  const [first] = MockEventSource.instances
  first.open()
  vi.advanceTimersByTime(STALL_MS - 500)
  first.readyState = MockEventSource.CLOSED
  first.onerror()
  // The old stream's watchdog would trip here; it was stopped with the reconnect.
  vi.advanceTimersByTime(1_000)
  expect(MockEventSource.instances).toHaveLength(2)
  const second = MockEventSource.instances[1]
  second.open()
  for (let beat = 0; beat < 4; beat++) {
    vi.advanceTimersByTime(15_000)
    second.dispatch('heartbeat', {})
  }
  // A late error from the replaced stream is ignored.
  first.onerror()
  vi.advanceTimersByTime(STALL_MS - 1)
  expect(MockEventSource.instances).toHaveLength(2)
  expect(second.readyState).toBe(MockEventSource.OPEN)
})

test('a closed item subscription never reopens', async () => {
  vi.useFakeTimers()
  const serverApi = await import('./serverApi')
  const close = serverApi.subscribeStepOutputs('X-1', vi.fn())
  vi.advanceTimersByTime(STALL_MS - 1)
  close()
  expect(MockEventSource.instances[0].readyState).toBe(MockEventSource.CLOSED)
  vi.advanceTimersByTime(5 * 60_000)
  expect(MockEventSource.instances).toHaveLength(1)
})

test('an item stream the browser closed for good (a 404) is never reopened', async () => {
  vi.useFakeTimers()
  const serverApi = await import('./serverApi')
  serverApi.subscribeStepOutputs('GONE-1', vi.fn())
  const [stream] = MockEventSource.instances
  stream.readyState = MockEventSource.CLOSED
  stream.onerror()
  vi.advanceTimersByTime(5 * 60_000)
  expect(MockEventSource.instances).toHaveLength(1)
})

// ---- HZ-360: the deploy block clears live, and a held Approve shows queued ----

test('getDeployBlock follows the stream, and a delta with deployBlock: null clears it', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no fetch expected'))))
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  expect(serverApi.getDeployBlock()).toBeNull()

  const block = { blocked: true, startedAt: '2026-10-08T19:12:52.000Z', latestEnd: '2026-10-08T19:37:52.000Z' }
  const source = MockEventSource.instances.at(-1)
  source.dispatch('snapshot', { items: [], deployBlock: block })
  expect(serverApi.getDeployBlock()).toEqual(block)
  // A delta about something else keeps the block.
  source.dispatch('delta', { upserts: [], removed: [], top: { farm: { status: 'running' } } })
  expect(serverApi.getDeployBlock()).toEqual(block)
  // The drain ended: the server's null replaces the block, no reload.
  source.dispatch('delta', { upserts: [], removed: [], top: { deployBlock: null } })
  expect(serverApi.getDeployBlock()).toBeNull()
})

test('an Approve the server held for a deploy marks the item queued in this tab at once', async () => {
  const serverApi = await import('./serverApi')
  const changed = vi.fn()
  serverApi.subscribe(changed)
  seedItem({ id: 'X5', cursor: 13, pr: 360, pr_url: 'https://github.com/org/repo/pull/360', acceptWaiting: null })
  const latestEnd = '2026-10-08T19:37:52.000Z'
  const body = { ok: true, held: true, latestEnd, actor: 'Dana' }
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })))
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {})
  changed.mockClear()

  await expect(serverApi.approveGate('X5', '')).resolves.toEqual(body)
  expect(serverApi.getDeployBlock()).toEqual({ blocked: true, startedAt: null, latestEnd })
  expect(serverApi.getItems().find((it) => it.id === 'X5').acceptWaiting).toEqual({ source: 'human', actor: 'Dana' })
  expect(changed).toHaveBeenCalled()
  expect(openSpy).not.toHaveBeenCalled()
})

// ---- HZ-470: Kill and a move reject when they did not go through ----
// HZ-711: both are moves from the step the cached item is at, so each test
// seeds it first; a rejection leaves it untouched.

const GATE_PIN = '4729'
const GATE_ITEM = { id: 'K-1', cursor: 13, currentStepKey: 'change.accept-code', pr_url: null }
const GATE_ACTIONS = [
  [
    'abandonItem',
    (api) => api.abandonItem('K-1', 'why', { removeDependentLinks: true }),
    '/items/K-1/move',
    { action: 'abandon', from: 'change.accept-code', note: 'why', removeDependentLinks: true },
  ],
  [
    'moveItem',
    (api) => api.moveItem('K-1', { stepKey: 'change.implement', note: 'why' }),
    '/items/K-1/move',
    { stepKey: 'change.implement', from: 'change.accept-code', note: 'why' },
  ],
  // HZ-802: Release on a filed ask's hold.
  ['releaseAsk', (api) => api.releaseAsk('K-1', 7, 'why'), '/items/K-1/asks/7/release', { reason: 'why' }],
]
const gateItem = (api) => api.getItems().find((it) => it.id === 'K-1')

// HZ-802: a move that cannot dispatch says why; the rejection carries the
// server's words, so the dialog can show them.
test("a move's 409 carries the server's message as serverMessage", async () => {
  const serverApi = await import('./serverApi')
  answerPins(serverApi, GATE_PIN)
  const fetchSpy = vi.fn(gateAnswer(409, { error: 'blocked_by', message: 'Blocked by MDI-129 (Add rates)', itemId: 'MDI-129' }))
  vi.stubGlobal('fetch', fetchSpy)
  serverApi.subscribe(() => {})
  seedItem(GATE_ITEM)

  const err = await serverApi.moveItem('K-1', { stepKey: 'change.implement' }).catch((e) => e)
  expect(err.message).toBe('blocked_by')
  expect(err.status).toBe(409)
  expect(err.serverMessage).toBe('Blocked by MDI-129 (Add rates)')
  expect(fetchSpy).toHaveBeenCalledTimes(1)
})

test('a 409 with no message leaves serverMessage unset', async () => {
  const serverApi = await import('./serverApi')
  answerPins(serverApi, GATE_PIN)
  vi.stubGlobal('fetch', vi.fn(gateAnswer(409, { error: 'closed' })))
  serverApi.subscribe(() => {})
  seedItem(GATE_ITEM)
  const err = await serverApi.moveItem('K-1', { stepKey: 'change.implement' }).catch((e) => e)
  expect(err.serverMessage).toBeUndefined()
})

function gateAnswer(status, body) {
  return () => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) })
}

for (const [name, act, path, body] of GATE_ACTIONS) {
  const call = (api) => {
    api.subscribe(() => {})
    seedItem(GATE_ITEM)
    return act(api)
  }

  test(`${name} resolves with the body on a 2xx, sending the PIN once`, async () => {
    const serverApi = await import('./serverApi')
    const requester = answerPins(serverApi, GATE_PIN)
    const fetchSpy = vi.fn().mockImplementationOnce(gateAnswer(401, { error: 'human_gate_key_required' })).mockImplementation(gateAnswer(200, { ok: true }))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(call(serverApi)).resolves.toEqual({ ok: true })
    expect(requester).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expectPinless(fetchSpy.mock.calls[0][1])
    const [url, opts] = fetchSpy.mock.calls[1]
    expect(url).toBe(`${serverApi.API_BASE}${path}`)
    expect(JSON.parse(opts.body)).toEqual(body)
    expect(opts.headers['x-human-key']).toBe(GATE_PIN)
    expect(opts.headers['x-horizon-csrf']).toBe('1')
    expect(localStorage.getItem('horizon_gate_pin')).toBeNull()
  })

  test(`${name} rejects with 'network' when fetch rejects, after exactly one request`, async () => {
    const serverApi = await import('./serverApi')
    answerPins(serverApi, GATE_PIN)
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network down')))
    vi.stubGlobal('fetch', fetchSpy)

    const err = await call(serverApi).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('network')
    expect(err.message).not.toContain(GATE_PIN)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(gateItem(serverApi)).toEqual(GATE_ITEM)
  })

  for (const [status, body, message] of [
    [404, { error: 'not_found' }, 'not_found'],
    [409, { error: 'closed' }, 'closed'],
    [500, {}, 'HTTP 500'],
  ]) {
    test(`${name} rejects with '${message}' and status ${status} on a ${status}, after exactly one request`, async () => {
      const serverApi = await import('./serverApi')
      answerPins(serverApi, GATE_PIN)
      const fetchSpy = vi.fn(gateAnswer(status, body))
      vi.stubGlobal('fetch', fetchSpy)

      const err = await call(serverApi).catch((e) => e)
      expect(err.message).toBe(message)
      expect(err.status).toBe(status)
      expect(err.message).not.toContain(GATE_PIN)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(gateItem(serverApi)).toEqual(GATE_ITEM)
    })
  }

  test(`${name} rejects with 'pin_needed' when the PIN retry dialog is cancelled, re-sending nothing`, async () => {
    const serverApi = await import('./serverApi')
    const requester = answerPins(serverApi, 'wrong')
    const fetchSpy = vi.fn(gateAnswer(401, { error: 'bad_human_gate_key' }))
    vi.stubGlobal('fetch', fetchSpy)

    const err = await call(serverApi).catch((e) => e)
    expect(err.message).toBe('pin_needed')
    expect(err.response.status).toBe(401)
    expect(err.message).not.toContain(GATE_PIN)
    expect(requester.mock.calls).toEqual([[{ retry: false }], [{ retry: true }]])
    // The PIN-less request, then the wrong PIN; the retry was cancelled.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test(`${name} asks again with retry while the PIN is wrong, then sends the right one`, async () => {
    const serverApi = await import('./serverApi')
    const requester = answerPins(serverApi, 'stale', GATE_PIN)
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(gateAnswer(401, { error: 'human_gate_key_required' }))
      .mockImplementationOnce(gateAnswer(401, { error: 'bad_human_gate_key' }))
      .mockImplementation(gateAnswer(200, { ok: true }))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(call(serverApi)).resolves.toEqual({ ok: true })
    expect(requester.mock.calls).toEqual([[{ retry: false }], [{ retry: true }]])
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(fetchSpy.mock.calls.map(([, opts]) => opts.headers['x-human-key'])).toEqual([undefined, 'stale', GATE_PIN])
  })

  for (const [label, entered] of [
    ['cancelled', null],
    ['empty', ''],
  ]) {
    test(`${name} with a ${label} PIN dialog after the 401 rejects with 'pin_needed' and sends nothing more`, async () => {
      const serverApi = await import('./serverApi')
      const requester = vi.fn(async () => entered)
      serverApi.setPinRequester(requester)
      const fetchSpy = vi.fn().mockImplementationOnce(gateAnswer(401, { error: 'human_gate_key_required' })).mockImplementation(gateAnswer(200, { ok: true }))
      vi.stubGlobal('fetch', fetchSpy)

      await expect(call(serverApi)).rejects.toThrow('pin_needed')
      expect(requester).toHaveBeenCalledTimes(1)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expectPinless(fetchSpy.mock.calls[0][1])
      expect(gateItem(serverApi)).toEqual(GATE_ITEM)
    })
  }

  test(`${name} on a PIN-verified session sends once with no PIN and asks nothing`, async () => {
    const serverApi = await import('./serverApi')
    const requester = answerPins(serverApi, GATE_PIN)
    const fetchSpy = vi.fn(gateAnswer(200, { ok: true }))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(call(serverApi)).resolves.toEqual({ ok: true })
    expect(requester).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expectPinless(fetchSpy.mock.calls[0][1])
  })
}

// ---- HZ-509: screenshot images need the PIN, and a GET carries no body ----

const pngResponse = () => ({ ok: true, status: 200, blob: () => Promise.resolve(new Blob(['png'])) })

test('getScreenshotImage sends a GET with no PIN and no body, and returns an object URL', async () => {
  const serverApi = await import('./serverApi')
  const fetchSpy = vi.fn(() => Promise.resolve(pngResponse()))
  vi.stubGlobal('fetch', fetchSpy)
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:shot') })

  await expect(serverApi.getScreenshotImage('HZ-1', 'board', 'diff')).resolves.toBe('blob:shot')
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  const [url, init] = fetchSpy.mock.calls[0]
  expect(url).toMatch(/\/items\/HZ-1\/screenshots\/board\/diff$/)
  expect(init.method).toBe('GET')
  expect(init.headers).toEqual({ 'x-horizon-csrf': '1' })
  expect(init).not.toHaveProperty('body')
})

test('getScreenshotImage asks for the PIN on a 401 and retries with it', async () => {
  const serverApi = await import('./serverApi')
  const fetchSpy = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({ error: 'human_gate_key_required' }) })
    .mockResolvedValueOnce(pngResponse())
  vi.stubGlobal('fetch', fetchSpy)
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:shot') })
  const requester = answerPins(serverApi, '271828')

  await expect(serverApi.getScreenshotImage('HZ-1', 'board', 'new')).resolves.toBe('blob:shot')
  expect(requester).toHaveBeenCalledTimes(1)
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect(fetchSpy.mock.calls[1][1].headers).toEqual({ 'x-horizon-csrf': '1', 'x-human-key': '271828' })
  expect(fetchSpy.mock.calls[1][1]).not.toHaveProperty('body')
})

// HZ-549: the Productivity page's one client function — a plain GET with the
// range and project in the query string, URL-encoded.
test('getProductivity GETs /admin/productivity with range and project in the query string', async () => {
  const serverApi = await import('./serverApi')
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ source: 'fixture' }) }))
  vi.stubGlobal('fetch', fetchSpy)

  await expect(serverApi.getProductivity({ range: '7d', project: 'a&b' })).resolves.toEqual({ source: 'fixture' })
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(fetchSpy.mock.calls[0][0]).toBe(`${serverApi.API_BASE}/admin/productivity?range=7d&project=a%26b`)
})

// ---- HZ-661: a member's active project and repo can clear live ----

test('activeProjectId and repoUrl follow the stream: null clears them, a missing key keeps them', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no fetch expected'))))
  const serverApi = await import('./serverApi')
  serverApi.subscribe(() => {})
  expect(serverApi.hasSnapshot()).toBe(false)
  const source = MockEventSource.instances.at(-1)
  source.dispatch('snapshot', { items: [], projects: [{ id: 3, name: 'Acme' }], activeProjectId: 3, repoUrl: 'https://github.com/acme/web' })
  expect(serverApi.hasSnapshot()).toBe(true)
  expect(serverApi.getActiveProjectId()).toBe(3)
  const issue = { issue: 9 }
  expect(serverApi.issueUrl(issue)).toBe('https://github.com/acme/web/issues/9')
  // A delta about something else keeps both.
  source.dispatch('delta', { upserts: [], removed: [], top: { farm: { status: 'running' } } })
  expect(serverApi.getActiveProjectId()).toBe(3)
  expect(serverApi.issueUrl(issue)).toBe('https://github.com/acme/web/issues/9')
  // Removed from the project: the server's nulls replace them, no reload.
  source.dispatch('delta', { upserts: [], removed: [], top: { projects: [], activeProjectId: null, repoUrl: null } })
  expect(serverApi.getActiveProjectId()).toBeNull()
  expect(serverApi.getProjects()).toEqual([])
  expect(serverApi.issueUrl(issue)).toBeNull()
})
