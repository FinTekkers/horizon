// Companion to orchestrator-reconcile.test.mjs, in its own process: FARM_URL
// must be unset BEFORE orchestrator.js's first import (it reads config.js's
// FARM_URL once, at import time), so this can't share a process with the
// FARM_URL-configured reconcile tests.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-reconcile-mock-')), 'test.db')
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

let fetchCalled = false
globalThis.fetch = async () => {
  fetchCalled = true
  return { ok: true, json: async () => ({}) }
}

test('reconcileActiveRuns is a pure no-op with no FARM_URL configured — mock mode has no farm to ask', async () => {
  const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)')
  insertItem.run('RCM-1', 'Mock mode', 'Medium', IMPLEMENT_STEP_INDEX)
  db.prepare('INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, ?)').run(
    'RCM-1',
    IMPLEMENT_STEP_INDEX,
    STEPS[IMPLEMENT_STEP_INDEX].agent,
    'active',
  )

  const result = await orchestrator.reconcileActiveRuns()

  assert.deepEqual(result, { checked: 0, failed: 0 })
  assert.equal(fetchCalled, false, 'no farm call may be made when FARM_URL is unset')
  assert.equal(
    db.prepare("SELECT status FROM step_run WHERE item_id = 'RCM-1'").get().status,
    'active',
    'mock-mode active rows are handled by closeAllOrphanedRuns at boot, not this sweep',
  )
})
