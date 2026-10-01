// End-to-end proof of HZ-4's success metric in demo mode: a Python-flavored
// item reaches the intake gate carrying the eng/python persona and a UI item
// the eng/ui persona; the human's gate approval confirms the value (or an
// override just before approving), and the choice sticks.
//
// HZ-125: personas are agent-scoped, so the chain also has to keep each agent's
// slot independent — overriding the Eng persona at the gate must not disturb a
// QA one, and vice versa.

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

test('a Python item reaches the gate as eng/python, a UI item as eng/ui', async () => {
  const py = await waitForGate('PY-1')
  const ui = await waitForGate('UI-1')
  assert.deepEqual(py.personas, { eng: 'python' })
  assert.deepEqual(ui.personas, { eng: 'ui' })
})

test('gate approval confirms the proposal; a pre-approval override sticks', async () => {
  // PY-1: approve as proposed.
  let res = await inject({ method: 'POST', url: '/api/items/PY-1/gates/3/approve', payload: {} })
  assert.equal(res.statusCode, 200)
  // UI-1: the human overrides to fullstack, then approves with comments —
  // the approve-with-comments path must not reset the override.
  res = await inject({ method: 'POST', url: '/api/items/UI-1/persona', payload: { agent: 'eng', persona: 'fullstack' } })
  assert.equal(res.statusCode, 200)
  res = await inject({
    method: 'POST',
    url: '/api/items/UI-1/gates/3/approve',
    payload: { notes: 'go with the generalist' },
  })
  assert.equal(res.statusCode, 200)

  assert.deepEqual(store.getItem('PY-1').personas, { eng: 'python' })
  assert.deepEqual(store.getItem('UI-1').personas, { eng: 'fullstack' })

  // Stop the mock pipeline; later mock passes must not have re-proposed.
  db.prepare("UPDATE work_item SET paused = 1 WHERE id IN ('PY-1', 'UI-1')").run()
  orchestrator.cancel('PY-1')
  orchestrator.cancel('UI-1')
  assert.deepEqual(store.getItem('UI-1').personas, { eng: 'fullstack' })
})

test('setting one agent’s persona leaves the other agents’ slots untouched', async () => {
  // HZ-125 success metric 7 through the real HTTP surface.
  let res = await inject({ method: 'POST', url: '/api/items/PY-1/persona', payload: { agent: 'qa', persona: 'data_integrity' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(store.getItem('PY-1').personas, { eng: 'python', qa: 'data_integrity' })

  res = await inject({ method: 'POST', url: '/api/items/PY-1/persona', payload: { agent: 'eng', persona: 'performance' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(store.getItem('PY-1').personas, { eng: 'performance', qa: 'data_integrity' })

  const snapshot = (await inject({ method: 'GET', url: '/api/items' })).json()
  assert.deepEqual(snapshot.items.find((it) => it.id === 'PY-1').personas, {
    eng: 'performance',
    qa: 'data_integrity',
  })
})

test('a persona that belongs to another agent is refused, leaving the slot as it was', async () => {
  // 409 (bad_persona), the same store-level refusal every other invalid value
  // gets — an unknown AGENT is what 400s, at the schema layer.
  let res = await inject({ method: 'POST', url: '/api/items/PY-1/persona', payload: { agent: 'qa', persona: 'python' } })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'bad_persona')
  res = await inject({ method: 'POST', url: '/api/items/PY-1/persona', payload: { agent: 'devops', persona: 'python' } })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(store.getItem('PY-1').personas, { eng: 'performance', qa: 'data_integrity' })
})

// PERSONA_PROVIDERS (success metric 10) is farm-only — the server has no notion
// of a provider override, by design (see farm/personas.py on why the mapping is
// kept out of the three-way registry mirror). Its re-keying to
// "<agent>.<persona>" and the override still firing under the new key are
// proven where the code lives: farm/tests/test_personas.py and
// farm/tests/test_step_agent.py.
