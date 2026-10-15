// HZ-446: a Plan's four gates are human gates. Approve & file passes only for
// a human with the gate PIN, even on Autopilot. The File items step after it
// is Horizon's own (HZ-449 files the drafts; server/test/plan-filing.test.mjs
// covers that): it never reaches the farm, and with no drafts it files
// nothing and pauses the Plan. A send-back from Review & close never re-runs
// File items.
//
// Driven through the real Fastify app on an Autopilot 'on' project, with a
// stubbed fetch recording every outbound call. Its own file because config.js
// reads the environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-plan-gates-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED', 'WA_NOTIFY_ENABLED']) delete process.env[key]

const calls = []
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  if (String(url).includes('/runs/status')) return { ok: true, json: async () => ({ states: {} }) }
  return { ok: true, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { ACT_GATES, NEVER_ACT, PLAN_GATES } = await import('../src/caretakerActor.js')
const { CARETAKER_GATES } = await import('../src/caretaker.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, kindStepIndex, gateStepIndexes, reworkTargets, defaultReworkTarget, APPROVE_FILE_GATE_INDEX } = await import(
  '../../domain/js/lifecycle.js'
)

store.purgeDemoItems()
const app = buildApp({ logger: false })
await app.ready()
orchestrator.init({ info() {}, warn() {}, error() {} })

after(async () => {
  for (const row of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(row.id)
  await app.close()
})

// This spec's own PIN, never one an earlier file set.
const PIN = 'pl4n-PIN-hz446-qv'
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
{
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(PIN, salt, 32)
  db.prepare('UPDATE user SET gate_pin_hash = ? WHERE id = ?').run(`${salt.toString('hex')}:${hash.toString('hex')}`, alice.user.id)
}

const FILE_ITEMS = kindStepIndex('File items', 'plan')
const REVIEW_CLOSE = kindStepIndex('Review & close', 'plan')
const METRICS_REVIEW = kindStepIndex('Review drafts: metrics & size', 'plan')
const REPO = 'acme/plan-gates-repo'

const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Roadmap', 1)").run().lastInsertRowid)
db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(projectId)

let nextIssue = 700
function seedPlan(id, cursor) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo, issue) VALUES (?, ?, 'High', ?, 'plan', ?, ?, ?)",
  ).run(id, `Plan fixture ${id}`, cursor, projectId, REPO, nextIssue++)
}
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const itemCount = () => db.prepare('SELECT COUNT(*) AS n FROM work_item').get().n
const approve = (id, stepIndex, pin) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/gates/${stepIndex}/approve`,
    headers: { cookie: alice.cookie, ...(pin === undefined ? {} : { 'x-human-key': pin }) },
    payload: {},
  })

test('Approve & file without the PIN is refused on an Autopilot project, and the gate stays open', async () => {
  seedPlan('P-NOPIN', APPROVE_FILE_GATE_INDEX)
  const noPin = await approve('P-NOPIN', APPROVE_FILE_GATE_INDEX)
  assert.equal(noPin.statusCode, 401)
  assert.equal(cursorOf('P-NOPIN'), APPROVE_FILE_GATE_INDEX)

  // Any caller without a proof — the caretaker's gateActions, WhatsApp, a token.
  assert.deepEqual(store.approveGate('P-NOPIN', APPROVE_FILE_GATE_INDEX, '', 'Autopilot'), { error: 'human_pin_required' })
  assert.equal(cursorOf('P-NOPIN'), APPROVE_FILE_GATE_INDEX)
})

test('Autopilot acts on no Plan gate: every one is in NEVER_ACT, none in ACT_GATES, none judged by the caretaker', () => {
  const planGates = gateStepIndexes(STEPS, 'plan')
  assert.deepEqual(PLAN_GATES, planGates)
  assert.equal(planGates.length, 4)
  for (const gate of planGates) {
    assert.ok(NEVER_ACT.includes(gate), `${STEPS[gate].label} is not in NEVER_ACT`)
    assert.ok(!ACT_GATES.includes(gate), `${STEPS[gate].label} is in ACT_GATES`)
    assert.ok(!CARETAKER_GATES.includes(gate), `${STEPS[gate].label} is judged by the caretaker`)
  }
})

test('Approve & file with the PIN advances; File items with no drafts files nothing, pauses the Plan and never reaches the farm', async () => {
  seedPlan('P-FILE', APPROVE_FILE_GATE_INDEX)
  const items = itemCount()
  calls.length = 0
  const ok = await approve('P-FILE', APPROVE_FILE_GATE_INDEX, PIN)
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(ok.json(), { ok: true, closed: false })

  // File items ran in-process and, with nothing to file, paused at its own row.
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(cursorOf('P-FILE'), FILE_ITEMS)
  assert.equal(store.getItem('P-FILE').paused, true)
  const runs = db.prepare('SELECT step_index, agent, status, output FROM step_run WHERE item_id = ?').all('P-FILE')
  assert.deepEqual(
    runs.map((r) => [r.step_index, r.agent, r.status]),
    [[FILE_ITEMS, 'Horizon', 'cancelled']],
  )
  assert.match(runs[0].output, /no item drafts to file/)

  assert.deepEqual(calls.filter((c) => c.url.includes('api.github.com')), [], 'File items called GitHub')
  assert.deepEqual(calls.filter((c) => c.url.includes('/steps/run')), [], 'File items was dispatched to the farm')
  assert.equal(itemCount(), items, 'File items wrote a work item')
  assert.ok(!config.FARM_STEP_INDEXES.has(FILE_ITEMS))
})

test('rejecting Review & close reworks to the nearest agent step, never File items', () => {
  seedPlan('P-REJECT', REVIEW_CLOSE)
  assert.equal(defaultReworkTarget(REVIEW_CLOSE), METRICS_REVIEW)
  assert.ok(!reworkTargets(REVIEW_CLOSE).some((t) => t.index === FILE_ITEMS))

  // An explicit File items target is refused, and the item stays at the gate.
  assert.deepEqual(store.requestChanges('P-REJECT', 'close gate', 'redo', 'You', FILE_ITEMS), { error: 'invalid_target' })
  assert.equal(cursorOf('P-REJECT'), REVIEW_CLOSE)

  assert.deepEqual(store.requestChanges('P-REJECT', 'close gate', 'redo the drafts review'), { ok: true })
  assert.equal(cursorOf('P-REJECT'), METRICS_REVIEW)
  const feedback = db.prepare('SELECT target FROM feedback WHERE item_id = ? ORDER BY id DESC LIMIT 1').get('P-REJECT')
  assert.equal(feedback.target, STEPS[METRICS_REVIEW].agent)
  orchestrator.cancel('P-REJECT')
})
