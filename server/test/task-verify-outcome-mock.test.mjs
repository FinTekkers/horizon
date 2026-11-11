// HO-841 R6: the mock path's Verify & report has no Execute job record, so it
// stores the outcome the farm path would with none: never
// `done_proof_incomplete`, and never a cause. Mock mode (FARM_URL unset).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-verify-outcome-mock-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '5'
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { VERIFY_REPORT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const VERIFY_LABEL = 'Verify & report'

async function mockVerify(id, verdict) {
  const original = orchestrator.MOCK_STEP_BEHAVIOR[VERIFY_LABEL]
  orchestrator.MOCK_STEP_BEHAVIOR[VERIFY_LABEL] = () => ({ summary: 'judged (mock)', artifact_md: '## Verdict', verdict })
  try {
    db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, 'Medium', ?, 'task')").run(id, id, VERIFY_REPORT_STEP_INDEX)
    orchestrator.kick(id)
    for (let i = 0; i < 100 && store.getItem(id).cursor === VERIFY_REPORT_STEP_INDEX; i++) await new Promise((r) => setTimeout(r, 10))
  } finally {
    orchestrator.MOCK_STEP_BEHAVIOR[VERIFY_LABEL] = original
  }
  return db
    .prepare("SELECT status, verdict, verify_outcome, execute_cause FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'done'")
    .get(id, VERIFY_REPORT_STEP_INDEX)
}

test('a mock done_proof_incomplete is stored as work_failed with no cause', async () => {
  const row = await mockVerify('MV-DPI', { verdict: 'done_proof_incomplete', execute_cause: 'prereq', summary: 'x' })
  assert.deepEqual(row, { status: 'done', verdict: 'fail', verify_outcome: 'work_failed', execute_cause: null })
})

test('the stock mock Verify writes verify_outcome pass', async () => {
  const id = 'MV-PASS'
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, 'Medium', ?, 'task')").run(id, id, VERIFY_REPORT_STEP_INDEX)
  orchestrator.kick(id)
  for (let i = 0; i < 100 && store.getItem(id).cursor === VERIFY_REPORT_STEP_INDEX; i++) await new Promise((r) => setTimeout(r, 10))
  const row = db.prepare("SELECT verdict, verify_outcome, execute_cause FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'done'").get(id, VERIFY_REPORT_STEP_INDEX)
  assert.deepEqual(row, { verdict: 'pass', verify_outcome: 'pass', execute_cause: null })
})
