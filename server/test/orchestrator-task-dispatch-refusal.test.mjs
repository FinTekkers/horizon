// HZ-377a metric 3 (server half): a task parked on a runner-less step waits
// there — kick() records no run and moves no cursor. Runs in mock mode
// (FARM_URL unset) so the shared runnable() gate is exercised directly,
// without a farm process. HZ-383 gave Assess a runner; HZ-378 gave Execute
// (the job lane) and Verify & report one, so those dispatch here too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-dispatch-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '5'
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { kindStepIndex, IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, ?, ?, ?)')
const runCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ?').get(id).n

// HZ-383: Assess now runs on the farm lane, so it dispatches one run.
test('a task at Assess dispatches one run', () => {
  const assess = kindStepIndex('Assess', 'task')
  insertItem.run('DT-ASSESS', 'Task at Assess', 'Medium', assess, 'task')

  orchestrator.kick('DT-ASSESS')

  assert.equal(runCount('DT-ASSESS'), 1, 'Assess has a runner now — kick records exactly one run')
})

test('a task at Execute runs the mock job and Verify, then waits at the gate', async () => {
  const execute = kindStepIndex('Execute', 'task')
  const close = kindStepIndex('Review & close', 'task')
  insertItem.run('DT-EXECUTE', 'Task at Execute', 'Medium', execute, 'task')

  orchestrator.kick('DT-EXECUTE')
  await new Promise((r) => setTimeout(r, 200))

  assert.equal(runCount('DT-EXECUTE'), 2, 'Execute and Verify each record one mock run')
  assert.equal(store.getItem('DT-EXECUTE').cursor, close, 'the item waits at Review & close')
})

test('positive control: a change item at an agent step still dispatches', () => {
  insertItem.run('DT-CHANGE', 'Change at implement', 'Medium', IMPLEMENT_STEP_INDEX, 'change')

  orchestrator.kick('DT-CHANGE')

  assert.equal(runCount('DT-CHANGE'), 1, 'the refusal must be specific to runner-less steps, not global breakage')
})
