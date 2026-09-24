// Orchestrator-level dispatch guard for work-item dependencies (HZ-78,
// success metric: "an item declared dependent on another is not dispatched
// while the blocker is unsatisfied, and starts automatically once it is").
// Same shape as orchestrator-abandon.test.mjs: runs in mock mode (FARM_URL
// unset) so runnable()'s new !isBlocked(...) clause is exercised directly,
// without needing a real farm process.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-dep-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '5'
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const insertItem = db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor, repo, issue) VALUES (?, ?, 'Medium', ?, ?, ?)",
)

assert.equal(STEPS[11].kind, 'agent')
const CLOSED = STEPS.length
const FINAL_GATE = STEPS.length - 1
assert.equal(STEPS[FINAL_GATE].kind, 'gate')

test('kick() on a blocked item parked at a live agent step does not dispatch', () => {
  insertItem.run('DO-BLOCKER', 'Blocker', 11, null, null)
  insertItem.run('DO-BLOCKED', 'Blocked dependent', 11, null, null)
  store.addDependency('DO-BLOCKED', 'DO-BLOCKER')

  orchestrator.kick('DO-BLOCKED')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'DO-BLOCKED'").get().n, 0)
  assert.equal(store.getItem('DO-BLOCKED').cursor, 11, 'cursor is untouched — no run was dispatched')

  // The blocker itself, with no dependency of its own, dispatches normally —
  // proves the guard is specific to the blocked item, not global breakage.
  orchestrator.kick('DO-BLOCKER')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'DO-BLOCKER'").get().n, 1)
})

test('the boot-time resume sweep skips a blocked item even though it sits mid agent-step (orchestrator.init -> resumeActiveItems)', () => {
  insertItem.run('DO-RESUME-BLOCKER', 'Blocker', 11, null, null)
  insertItem.run('DO-RESUME-BLOCKED', 'Blocked, mid-step at boot', 11, null, null)
  store.addDependency('DO-RESUME-BLOCKED', 'DO-RESUME-BLOCKER')

  orchestrator.init({ info: () => {}, warn: () => {} })
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'DO-RESUME-BLOCKED'").get().n,
    0,
    'resumeActiveItems must not kick a blocked item back into dispatch',
  )
})

test('a blocked item sitting at a gate step is also never runnable (kick no-ops regardless of step kind)', () => {
  insertItem.run('DO-GATE-BLOCKER', 'Blocker', 11, null, null)
  insertItem.run('DO-GATE-BLOCKED', 'Blocked at a gate', 3, null, null)
  assert.equal(STEPS[3].kind, 'gate')
  store.addDependency('DO-GATE-BLOCKED', 'DO-GATE-BLOCKER')
  orchestrator.kick('DO-GATE-BLOCKED') // no-ops for gate steps regardless, but must not throw or dispatch
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'DO-GATE-BLOCKED'").get().n, 0)
})

// End-to-end scenario matching the outcome's HZ-77-depends-on-HZ-76 example,
// as a server-side integration test (UI is out of scope for this item — see
// guardrails). Drives the mock pipeline for real: the dependent never gets a
// step_run row while blocked, and picks up automatically, with no manual
// kick, the moment the blocker's approveGate call closes it.
test('end-to-end: a dependent item is never dispatched while its blocker is open, and starts automatically once the blocker closes', async () => {
  insertItem.run('E2E-76', 'Failure classification (blocker)', FINAL_GATE, null, null)
  insertItem.run('E2E-77', 'Pause banner (dependent)', 11, null, null)
  const addResult = store.addDependency('E2E-77', 'E2E-76')
  assert.equal(addResult.ok, true)
  assert.equal(addResult.blocked, true)
  assert.deepEqual(addResult.blockedBy.map((b) => b.id), ['E2E-76'])

  orchestrator.kick('E2E-77')
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'E2E-77'").get().n,
    0,
    'HZ-77 must not race ahead of HZ-76',
  )
  assert.ok(
    store.listItems().find((it) => it.id === 'E2E-77').blocked,
    'the API payload reads HZ-77 as blocked, naming HZ-76 as the blocker',
  )

  const approval = store.approveGate('E2E-76', FINAL_GATE, '')
  assert.equal(approval.ok, true)
  assert.equal(approval.closed, true)

  // approveGate's wakeDependents call already fired kick('E2E-77')
  // synchronously — the step_run row exists without any manual kick.
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'E2E-77'").get().n,
    1,
    'HZ-77 starts automatically the instant HZ-76 is satisfied',
  )
  assert.equal(store.listItems().find((it) => it.id === 'E2E-77').blocked, false)
})
