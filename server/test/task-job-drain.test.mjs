// HZ-378 R12: a deploy drain never lists, kills or cancels a job. An agent
// step alongside it is still drained, proving the drain itself ran.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-job-drain-')), 'test.db')
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const deployDrain = await import('../src/deployDrain.js')
const { STEPS, IMPLEMENT_STEP_INDEX, EXECUTE_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('C-R12', 'Agent step', 'High', ?)").run(IMPLEMENT_STEP_INDEX)
db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind) VALUES ('T-R12', 'Job', 'High', ?, 'task')").run(EXECUTE_STEP_INDEX)
const activeRun = (id, stepIndex) =>
  Number(
    db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')").run(
      id,
      stepIndex,
      STEPS[stepIndex].agent,
    ).lastInsertRowid,
  )
const implRun = activeRun('C-R12', IMPLEMENT_STEP_INDEX)
const jobRun = activeRun('T-R12', EXECUTE_STEP_INDEX)

const statusOf = (runId) => db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status
const eventsOf = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id)

test('R12: the drain lists the agent step but not the job, and stops only the agent step', async () => {
  const begun = deployDrain.beginDrain({ ttlS: 60 })
  assert.ok(
    begun.steps.some((s) => s.runId === implRun),
    'the agent step is listed for the drain',
  )
  assert.ok(
    !begun.steps.some((s) => s.runId === jobRun),
    'the job is not listed for the drain',
  )

  assert.deepEqual(await orchestrator.interruptStepsForDeploy([jobRun]), [
    { runId: jobRun, itemId: 'T-R12', step: 'execute', interrupted: false },
  ])
  assert.equal(statusOf(jobRun), 'active', 'a direct interrupt still refuses the job')
  assert.deepEqual(eventsOf('T-R12'), [], 'refusing the job leaves no trace')

  const [moved] = await orchestrator.interruptStepsForDeploy([implRun])
  assert.equal(moved.interrupted, true)
  assert.equal(statusOf(implRun), 'cancelled')

  deployDrain.endDrain()
  orchestrator.cancel('T-R12')
})
