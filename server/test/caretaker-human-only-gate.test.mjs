// HZ-384: on an Autopilot 'on' project the caretaker never approves a Task's
// Approve the run gate, whatever it decided. The decision is recorded once as
// a 'skipped' action — which does not count toward the hourly limit — with one
// activity event, and gateActions.approve is never called for it.
//
// actOnDecisions is driven directly with spy gateActions, so a call for this
// gate would be seen rather than refused further down.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

globalThis.fetch = async () => {
  throw new Error('caretaker-human-only-gate test: no network')
}
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-caretaker-human-only-')), 'test.db')
for (const key of ['FARM_URL', 'GITHUB_TOKEN', 'CARETAKER_HOURLY_LIMIT', 'WA_NOTIFY_ENABLED', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const actor = await import('../src/caretakerActor.js')
const { STEPS, requiredStepIndex, APPROVE_RUN_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const silent = { info() {}, warn() {}, error() {} }
const DESIGN_GATE = requiredStepIndex('Approve the high-level design')

const calls = []
const gateActions = {
  approve: async (...args) => {
    calls.push({ fn: 'approve', args })
    return { ok: true, closed: false }
  },
  sendBack: async (...args) => {
    calls.push({ fn: 'sendBack', args })
    return { ok: true }
  },
}

const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Autopilot project', 1)").run().lastInsertRowid)
db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(projectId)

// An item parked at `gate`, fed by a done run of the step before it, and the
// caretaker's 'approve' decision for that arrival.
function arriveWithApproval(id, gate, kind) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id) VALUES (?, ?, 'High', ?, ?, ?)").run(
    id,
    `fixture ${id}`,
    gate,
    kind,
    projectId,
  )
  const runId = Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, agent, status, output, artifact) VALUES (?, ?, 'x', 'done', 'ok', 'ok')")
      .run(id, gate - 1).lastInsertRowid,
  )
  db.prepare(
    "INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, rule_id, reason) VALUES (?, ?, ?, 'on', 'approve', 'r1', 'looks fine')",
  ).run(id, gate, runId)
}

const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const actionsOf = (id) => db.prepare('SELECT action, outcome, error FROM caretaker_action WHERE item_id = ?').all(id)
const eventsOf = (id) => db.prepare('SELECT who, text FROM event WHERE item_id = ? ORDER BY id').all(id)

test('Approve the run is never acted on, for any reason', () => {
  assert.equal(STEPS[APPROVE_RUN_GATE_INDEX].label, 'Approve the run')
  assert.equal(actor.ACT_GATES.includes(APPROVE_RUN_GATE_INDEX), false)
})

test('two caretaker passes leave the gate pending, never call approve, and log the refusal exactly once', async () => {
  arriveWithApproval('T-AUTO', APPROVE_RUN_GATE_INDEX, 'task')

  await actor.actOnDecisions({ gateActions, log: silent, limit: 1 })
  await actor.actOnDecisions({ gateActions, log: silent, limit: 1 })

  assert.equal(cursorOf('T-AUTO'), APPROVE_RUN_GATE_INDEX)
  assert.deepEqual(calls.filter((c) => c.args[0] === 'T-AUTO'), [])
  assert.deepEqual(actionsOf('T-AUTO'), [{ action: 'approve', outcome: 'skipped', error: 'human_pin_required' }])
  const events = eventsOf('T-AUTO')
  assert.deepEqual(events, [
    {
      who: 'Caretaker',
      text: 'Autopilot did not approve “Approve the run”: it needs a human with the gate PIN — left for a human',
    },
  ])
  assert.equal(events.filter((e) => e.text.startsWith('could not approve')).length, 0, 'approveGate was never reached')
})

test('the skipped refusal does not use up the hourly limit: a change gate right after it is still acted on', async () => {
  arriveWithApproval('C-NEXT', DESIGN_GATE, 'change')
  const counts = await actor.actOnDecisions({ gateActions, log: silent, limit: 1 })

  assert.equal(counts.acted, 1)
  assert.equal(counts.limited, 0)
  assert.deepEqual(
    calls.map((c) => [c.fn, c.args[0], c.args[1]]),
    [['approve', 'C-NEXT', DESIGN_GATE]],
  )
  assert.deepEqual(actionsOf('C-NEXT'), [{ action: 'approve', outcome: 'ok', error: null }])
})
