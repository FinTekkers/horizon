// HZ-731 metric 5: the "G2 rework" golden run, with asks in play. As HZ-710's
// plan defines the run: start from a running "Specialist agent implements",
// return to planning, then approve every gate and finish; the running run is
// cancelled as superseded. HZ-710's own move is not on main, so the return
// here is main's existing rework lever (restartPhase into the phase that
// holds "Draft implementation plan").
//
// What this item adds must not change the run: an open soft ask never holds
// it, and a blocking ask the rework raises holds Implement only until the
// owner dismisses it. Mock mode (FARM_URL unset), every agent step a real
// mock run, every gate approved through store.approveGate as a human would.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

globalThis.fetch = async () => {
  throw new Error('ask-g2-rework test: no network')
}

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-ask-g2-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '20'
for (const key of ['FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { dismissAsk } = await import('../src/asks.js')
const { STEPS, IMPLEMENT_STEP_INDEX, isClosed, requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: orchestrator.kick, cancel: orchestrator.cancel })
after(() => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

const DRAFT_PLAN = requiredStepIndex('Draft implementation plan')
const REVIEW_BEFORE = requiredStepIndex('Review before execution')
const ID = 'G2-REWORK'

const runs = (stepIndex) => db.prepare('SELECT id, status FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id').all(ID, stepIndex)
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
async function waitFor(predicate, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`${ID} never ${what} (cursor ${store.getItem(ID).cursor})`)
}
const atGate = () => STEPS[store.getItem(ID).cursor]?.kind === 'gate'
function seedAsk(kind, title) {
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output) VALUES (?, ?, 1, 'Architect', 'done', 'x')")
    .run(ID, DRAFT_PLAN + 1).lastInsertRowid
  const draft = { title, repo: 'Acme/g2', outcome: 'o', metric: '1. a\n2. b\n3. c', guardrails: '1. g' }
  return Number(
    db
      .prepare("INSERT INTO ask (item_id, step_run_id, step_index, kind, status, draft_json, why) VALUES (?, ?, ?, ?, 'open', ?, 'raised in rework')")
      .run(ID, runId, DRAFT_PLAN + 1, kind, JSON.stringify(draft)).lastInsertRowid,
  )
}

test('G2 rework: a running Implement returns to planning and is superseded; a blocking ask raised in rework holds Implement until dismissed; the run finishes', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES (?, 'G2 rework fixture', 'High', ?)").run(ID, IMPLEMENT_STEP_INDEX)
  seedAsk('soft', 'A suggested follow-up')

  // A running Implement: an open soft ask does not hold it.
  orchestrator.kick(ID)
  assert.deepEqual(runs(IMPLEMENT_STEP_INDEX).map((r) => r.status), ['active'])

  // Return to planning; the running Implement is superseded.
  assert.equal(store.restartPhase(ID, STEPS[DRAFT_PLAN].phase, 'G2 rework: re-plan').ok, true)
  assert.deepEqual(runs(IMPLEMENT_STEP_INDEX).map((r) => r.status), ['superseded'])

  // Approve each gate up to Review before execution as it comes.
  let blockingAsk = null
  for (;;) {
    await waitFor(atGate, 'reached a gate')
    const gate = store.getItem(ID).cursor
    if (gate === REVIEW_BEFORE) {
      assert.ok(runs(DRAFT_PLAN).some((r) => r.status === 'done'), '“Draft implementation plan” ran again')
      // The re-run review raised a blocking ask; the owner approves anyway.
      blockingAsk = seedAsk('blocking', 'Prerequisite found in rework')
    }
    assert.equal(store.approveGate(ID, gate, '').ok, true, `approve “${STEPS[gate].label}”`)
    if (gate === REVIEW_BEFORE) break
  }

  // Implement is held by the open blocking ask, by name.
  await settle()
  assert.equal(store.getItem(ID).cursor, IMPLEMENT_STEP_INDEX)
  assert.equal(runs(IMPLEMENT_STEP_INDEX).length, 1, 'no new Implement run while the blocking ask is open')
  assert.equal(store.itemViewById(ID).startHold.title, 'Prerequisite found in rework')

  // The owner dismisses it (as the Dismiss route does, then kicks).
  const dismissed = dismissAsk(store.getItem(ID), blockingAsk, { reason: 'Covered by this item.', actor: 'Owner', queueFeedbackOnce: store.queueFeedbackOnce })
  assert.equal(dismissed.ok, true)
  orchestrator.kick(ID)
  assert.equal(runs(IMPLEMENT_STEP_INDEX).length, 2)

  // And the run finishes: every later gate approved, the item closed.
  while (!isClosed(store.getItem(ID))) {
    await waitFor(() => atGate() || isClosed(store.getItem(ID)), 'reached a gate or closed')
    if (isClosed(store.getItem(ID))) break
    const gate = store.getItem(ID).cursor
    assert.equal(store.approveGate(ID, gate, '').ok, true, `approve “${STEPS[gate].label}”`)
  }
  assert.deepEqual(runs(IMPLEMENT_STEP_INDEX).map((r) => r.status), ['superseded', 'done'])
  assert.equal(Object.hasOwn(store.itemViewById(ID), 'startHold'), false)
})
