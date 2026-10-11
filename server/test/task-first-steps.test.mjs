// HZ-413: a new Task runs its first three steps (outcome, How we'll verify and
// Guardrails) on the PM lane by itself, and waits at
// Approve & prioritize with desc, metric and guardrails written. No phase
// restart and no PIN. Runs on the mock path (FARM_URL unset), so the step
// behaviours are orchestrator.js's MOCK_STEP_BEHAVIOR; the farm half is
// farm/tests/test_task_steps.py.
//
// Guardrail 2: Approve & prioritize stays a human gate for a Task, Autopilot
// included.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-first-steps-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '5'
for (const key of ['FARM_URL', 'GITHUB_TOKEN', 'CARETAKER_HOURLY_LIMIT', 'WA_NOTIFY_ENABLED', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]
globalThis.fetch = async () => {
  throw new Error('task-first-steps test: no network')
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const actor = await import('../src/caretakerActor.js')
const { STEPS, kindStepIndex, firstStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {} })

const OUTCOME = firstStepIndex('task')
const VERIFY = kindStepIndex("How we'll verify", 'task')
const GUARDRAILS = kindStepIndex('Guardrails', 'task')
const GATE = kindStepIndex('Approve & prioritize', 'task')
const silent = { info() {}, warn() {}, error() {} }

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('condition never became true')
}

const doneRunsAt = (id, stepIndex) =>
  db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'done'").get(id, stepIndex).n
const eventsOf = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
const gateDecisionsOf = (id) => db.prepare('SELECT COUNT(*) AS n FROM gate_decision WHERE item_id = ?').get(id).n

test('sanity: the three Task steps sit on the PM lane, in order, right before the Task gate', () => {
  assert.equal(OUTCOME, firstStepIndex('task'))
  assert.deepEqual([OUTCOME + 1, OUTCOME + 2, OUTCOME + 3], [VERIFY, GUARDRAILS, GATE])
  for (const i of [OUTCOME, VERIFY, GUARDRAILS]) assert.equal(STEPS[i].runsIn, 'pm', STEPS[i].label)
  assert.equal(STEPS[GATE].kind, 'gate')
})

test('a new Task with empty fields walks steps 0-2 by itself and waits at Approve & prioritize', async () => {
  const id = store.createLocalItem({ title: 'Backfill the ledger', outcome: '', metric: '', priority: 'Medium', kind: 'task' })
  assert.equal(typeof id, 'string', JSON.stringify(id))
  const created = store.getItem(id)
  assert.deepEqual([created.desc, created.metric, created.guardrails], ['', '', ''], 'the steps must write all three fields')

  await waitFor(() => store.getItem(id).cursor === GATE)
  // Still at the gate after a further kick: nothing moves it but a human.
  orchestrator.kick(id)
  await new Promise((r) => setTimeout(r, 50))
  const item = store.getItem(id)
  assert.equal(item.cursor, GATE)

  // Each field holds the Task step's own text, not the change steps'.
  assert.equal(item.desc, 'Deliver: Backfill the ledger')
  assert.match(item.metric, /count what the run of “Backfill the ledger” wrote, spot-check a sample and report every failure/)
  assert.match(item.guardrails, /^Draft — run safety: /)
  assert.match(item.guardrails, /safe to re-run/)

  for (const i of [OUTCOME, VERIFY, GUARDRAILS]) assert.equal(doneRunsAt(id, i), 1, `step "${STEPS[i].label}" ran once`)
  const events = eventsOf(id)
  assert.equal(events.filter((t) => /^restarted the/.test(t)).length, 0, events.join('\n'))
  assert.equal(gateDecisionsOf(id), 0)
})

test('Autopilot never approves a Task at Approve & prioritize', async () => {
  assert.equal(actor.ACT_GATES.includes(GATE), false)

  const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Autopilot project', 1)").run().lastInsertRowid)
  db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(projectId)
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id) VALUES ('T-AUTO', 'Autopilot task', 'High', ?, 'task', ?)").run(
    OUTCOME,
    projectId,
  )
  orchestrator.kick('T-AUTO')
  await waitFor(() => store.getItem('T-AUTO').cursor === GATE)

  // The caretaker decided to approve this arrival; the actor must still not act.
  const arrival = db
    .prepare("SELECT id FROM step_run WHERE item_id = 'T-AUTO' AND step_index = ? AND status = 'done'")
    .get(GUARDRAILS).id
  db.prepare(
    "INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, rule_id, reason) VALUES ('T-AUTO', ?, ?, 'on', 'approve', 'r1', 'looks fine')",
  ).run(GATE, arrival)
  const calls = []
  const gateActions = {
    approve: async (...args) => {
      calls.push(['approve', ...args])
      return { ok: true, closed: false }
    },
    sendBack: async (...args) => {
      calls.push(['sendBack', ...args])
      return { ok: true }
    },
  }
  await actor.actOnDecisions({ gateActions, log: silent, limit: 10 })
  orchestrator.kick('T-AUTO')
  await new Promise((r) => setTimeout(r, 50))

  assert.equal(store.getItem('T-AUTO').cursor, GATE)
  assert.deepEqual(calls, [])
  assert.equal(gateDecisionsOf('T-AUTO'), 0)
  assert.equal(eventsOf('T-AUTO').filter((t) => t.startsWith('approved')).length, 0)
})
