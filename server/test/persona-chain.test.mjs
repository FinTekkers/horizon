// End-to-end proof of HZ-4's success metric in demo mode: a Python-flavored
// item reaches the intake gate carrying the python_backend persona and a UI
// item the frontend_ui persona; the human's gate approval confirms the value
// (or an override just before approving), and the choice sticks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-chain-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '10'
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
const inject = (opts) => app.inject({ ...opts, headers: { 'x-human-key': pin, ...opts.headers, cookie } })

db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor) VALUES ('PY-1', 'Fix flaky pytest fixture in the payments API', 'Medium', 0)",
).run()
db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor) VALUES ('UI-1', 'Restyle the dashboard card component (React)', 'Medium', 0)",
).run()

orchestrator.init({ info: () => {}, warn: () => {} })

async function waitForGate(id, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (store.getItem(id).cursor === 3) return store.getItem(id)
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`${id} never reached the intake gate (cursor ${store.getItem(id).cursor})`)
}

test('a Python item reaches the gate as python_backend, a UI item as frontend_ui', async () => {
  const py = await waitForGate('PY-1')
  const ui = await waitForGate('UI-1')
  assert.equal(py.persona, 'python_backend')
  assert.equal(ui.persona, 'frontend_ui')
})

test('gate approval confirms the proposal; a pre-approval override sticks', async () => {
  // PY-1: approve as proposed.
  let res = await inject({ method: 'POST', url: '/api/items/PY-1/gates/3/approve', payload: {} })
  assert.equal(res.statusCode, 200)
  // UI-1: the human overrides to fullstack, then approves with comments —
  // the approve-with-comments path must not reset the override.
  res = await inject({ method: 'POST', url: '/api/items/UI-1/persona', payload: { persona: 'fullstack' } })
  assert.equal(res.statusCode, 200)
  res = await inject({
    method: 'POST',
    url: '/api/items/UI-1/gates/3/approve',
    payload: { notes: 'go with the generalist' },
  })
  assert.equal(res.statusCode, 200)

  assert.equal(store.getItem('PY-1').persona, 'python_backend')
  assert.equal(store.getItem('UI-1').persona, 'fullstack')

  // Stop the mock pipeline; later mock passes must not have re-proposed.
  db.prepare("UPDATE work_item SET paused = 1 WHERE id IN ('PY-1', 'UI-1')").run()
  orchestrator.cancel('PY-1')
  orchestrator.cancel('UI-1')
  assert.equal(store.getItem('UI-1').persona, 'fullstack')
})
