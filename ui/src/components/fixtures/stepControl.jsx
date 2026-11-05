// HZ-711: one mocked item snapshot for the step-control tests, and a harness
// that mounts the real App — the real serverApi and HZ-704's PIN dialog —
// over a stubbed stream and fetch. The `moves` blocks are written out, as the
// server would send them: the UI must list exactly these and work out nothing.
// Two deliberate oddities a UI rule would never produce: the gate offers a
// return to another gate (change.approve-design) and leaves out an agent
// step before it (change.arch-review).
import { vi } from 'vitest'
import { act, render } from '@testing-library/react'

export const PIN = '418273'

const base = {
  kind: 'change',
  priority: 'High',
  project_id: null,
  repo: null,
  issue: null,
  pr: null,
  paused: false,
  events: [],
  stepOutputs: {},
  blockedBy: [],
  dependents: [],
  personas: {},
  last_activity_at: '2026-11-05T12:00:00Z',
}

// Waiting at Review before execution.
export const GATE_ITEM = {
  ...base,
  id: 'HZ-901',
  title: 'Gate item',
  cursor: 10,
  currentStepKey: 'change.review-before-exec',
  activeRun: null,
  moves: {
    approve: { key: 'change.review-before-exec', label: 'Review before execution' },
    targets: [
      {
        key: 'change.approve-design',
        label: 'Approve the high-level design',
        action: 'return',
        isDefault: false,
        redo: 'Redoes 6 steps, from “Approve the high-level design” to “Review before execution”.',
        reapprovals: ['Approve the high-level design'],
        stopsRunning: false,
      },
      {
        key: 'change.draft-plan',
        label: 'Draft implementation plan',
        action: 'return',
        isDefault: true,
        redo: 'Redoes 5 steps, from “Draft implementation plan” to “Review before execution”.',
        reapprovals: [],
        stopsRunning: false,
      },
      {
        key: 'change.summarize-reviews',
        label: 'Summarize reviews & recommend',
        action: 'return',
        isDefault: false,
        redo: 'Redoes 2 steps, from “Summarize reviews & recommend” to “Review before execution”.',
        reapprovals: [],
        stopsRunning: false,
      },
    ],
    canAbandon: true,
    amend: null,
  },
}

// Running Specialist agent implements.
export const RUNNING_ITEM = {
  ...base,
  id: 'HZ-902',
  title: 'Running item',
  cursor: 11,
  currentStepKey: 'change.implement',
  activeRun: { id: 77, step_index: 11, state: 'running', attempt: 1, started_at: '2026-11-05T12:00:00Z' },
  moves: {
    approve: null,
    targets: [
      {
        key: 'change.review-before-exec',
        label: 'Review before execution',
        action: 'return',
        isDefault: true,
        redo: 'Redoes 2 steps, from “Review before execution” to “Specialist agent implements”.',
        reapprovals: ['Review before execution'],
        stopsRunning: true,
      },
      {
        key: 'change.implement',
        label: 'Specialist agent implements',
        action: 'retry',
        isDefault: false,
        redo: 'Runs “Specialist agent implements” again.',
        reapprovals: [],
        stopsRunning: true,
      },
    ],
    canAbandon: true,
    amend: null,
  },
}

class MockEventSource {
  constructor(url) {
    this.url = url
    this.listeners = {}
    this.readyState = 1
    MockEventSource.instances.push(this)
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn
  }
  dispatch(type, data) {
    this.listeners[type]?.({ data: JSON.stringify(data) })
  }
  close() {
    this.readyState = 2
  }
}
MockEventSource.CONNECTING = 0
MockEventSource.OPEN = 1
MockEventSource.CLOSED = 2

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, clone() { return this } })

// The stubbed server. `moveReply(body, headers)` answers POST /items/:id/move
// once the PIN is right (default: ok). Every request is kept in `calls`.
export function stubServer({ moveReply = () => json(200, { ok: true }) } = {}) {
  const calls = []
  MockEventSource.instances = []
  vi.stubGlobal('EventSource', MockEventSource)
  const fetchSpy = vi.fn(async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null }
    calls.push(call)
    if (call.url.endsWith('/auth/me')) return json(200, { user: { name: 'Owner', email: 'o@example.com', isAdmin: true } })
    if (/\/items\/[^/]+\/move$/.test(call.url)) {
      if (call.headers['x-human-key'] !== PIN) return json(401, { error: 'human_gate_key_required' })
      return moveReply(call.body, call.headers)
    }
    return json(404, { error: 'not_found' })
  })
  vi.stubGlobal('fetch', fetchSpy)
  const prompt = vi.fn(() => null)
  vi.stubGlobal('prompt', prompt)
  window.prompt = prompt
  return {
    calls,
    prompt,
    json,
    moves: () => calls.filter((c) => /\/items\/[^/]+\/move$/.test(c.url)),
    push: (items) => MockEventSource.instances.at(-1).dispatch('snapshot', { items, projects: [], activeProjectId: null }),
  }
}

// Mounts the real App at `path` (e.g. '/hz-901', '/', '/?approvals') under
// the PIN dialog, then pushes `items` as the stream's first snapshot.
export async function mountApp(server, path, items = [GATE_ITEM, RUNNING_ITEM]) {
  window.history.replaceState({}, '', path)
  const { default: App } = await import('../../App')
  const { PinDialogProvider } = await import('../PinDialog')
  const view = render(
    <PinDialogProvider>
      <App />
    </PinDialogProvider>,
  )
  await vi.waitFor(() => {
    if (!MockEventSource.instances.length) throw new Error('no stream yet')
  })
  act(() => server.push(items))
  return view
}
