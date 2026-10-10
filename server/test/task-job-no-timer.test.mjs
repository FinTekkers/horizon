// HZ-378 R4: the job lane arms no agent timer — at dispatch, at start, or
// on server-restart re-arm. Past the agent timeoutS the run is still active.
//
// Real timers, in the style of orchestrator-timeout.test.mjs: short, distinct
// bounds so each clock is separately observable.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-job-notimer-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '2000'
process.env.FARM_STEP_TIMEOUT_MS = '200'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { STEPS, EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const PLAN =
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '/tmp', commands: ['scripts/a.sh'], budget_minutes: 20 }, null, 2) +
  '\n```'

db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, approved_plan_hash) VALUES ('T-R4', 'No timer job', 'High', ?, 'task', ?)").run(
  EXECUTE_STEP_INDEX,
  sha256(PLAN),
)
db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES ('T-R4', ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
).run(RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, PLAN)

const statusOf = (runId) => db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status

test('R4: a job run outlives the agent timeout on every arming path', async () => {
  assert.equal(orchestrator.executionBudgetFor(EXECUTE_STEP_INDEX), null)

  orchestrator.kick('T-R4')
  await wait(10)
  const runId = db.prepare("SELECT id FROM step_run WHERE item_id = 'T-R4' AND status = 'active'").get().id

  await wait(300) // past FARM_STEP_TIMEOUT_MS (200): a dispatch-time execution timer would have fired
  assert.equal(statusOf(runId), 'active')

  assert.deepEqual(orchestrator.markFarmRunStarted(runId), { ok: true, active: true })
  await wait(300) // past the execution budget counted from start: no timer was armed
  assert.equal(statusOf(runId), 'active')

  orchestrator.rearmFarmRuns() // the server-restart path
  await wait(300)
  assert.equal(statusOf(runId), 'active')

  orchestrator.cancel('T-R4')
  assert.equal(statusOf(runId), 'cancelled')
})
