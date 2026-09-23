// Orchestrator-level dispatch guard for abandoned items (HZ-59, success
// metric: "a test asserts an abandoned item is never dispatched again even
// when resumed or kicked"). Runs in mock mode (FARM_URL unset) so the
// boot-time resume sweep (resumeActiveItems, called from init()) exercises
// runnable()'s isAbandoned guard without needing a real farm process — see
// orchestrator.test.mjs for the farm-dispatch-path tests.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-abandon-')), 'test.db')
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const insertAbandoned = db.prepare(
  `INSERT INTO work_item (id, title, priority, cursor, abandoned_at, abandoned_reason, abandoned_by)
   VALUES (?, ?, 'Medium', ?, datetime('now'), ?, ?)`,
)

test('kick() on an abandoned item parked at a live agent step does not dispatch', () => {
  insertAbandoned.run('AB-KICK', 'Abandoned, kicked directly', 11, 'no longer needed', 'Dana')
  assert.equal(STEPS[11].kind, 'agent')
  orchestrator.kick('AB-KICK')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'AB-KICK'").get().n, 0)
  assert.equal(store.getItem('AB-KICK').cursor, 11, 'cursor is untouched — no run was dispatched')
})

test('the boot-time resume sweep skips an abandoned item even though it sits mid agent-step (orchestrator.init -> resumeActiveItems)', () => {
  insertAbandoned.run('AB-RESUME', 'Abandoned, mid-step at boot', 11, 'no longer needed', 'Dana')
  orchestrator.init({ info: () => {}, warn: () => {} })
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'AB-RESUME'").get().n,
    0,
    'resumeActiveItems must not kick an abandoned item back into dispatch',
  )
  assert.equal(store.getItem('AB-RESUME').cursor, 11)
})

test('an abandoned item sitting at a gate step is also never runnable (not just agent steps)', () => {
  insertAbandoned.run('AB-GATE', 'Abandoned at a gate', 3, 'stopped before approval', 'Dana')
  assert.equal(STEPS[3].kind, 'gate')
  orchestrator.kick('AB-GATE') // no-ops for gate steps regardless, but must not throw or dispatch
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'AB-GATE'").get().n, 0)
})
