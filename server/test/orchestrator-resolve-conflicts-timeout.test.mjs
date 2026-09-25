// HZ-92: resolveConflicts()'s farmd call runs a real git merge plus the
// target repo's own test suite, so it can legitimately take a while — but it
// must never hang forever. A short FARM_CONFLICT_RESOLVE_TIMEOUT_MS here
// (separate process/import from the other orchestrator-resolve-conflicts
// tests, same reasoning as config-farm-timeouts-override.test.mjs — config.js
// reads env once at import time) makes that bound observable within a fast
// test: a farmd that never responds must still escalate, not hang the
// Accept-gate request.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-resolve-conflicts-timeout-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_CONFLICT_RESOLVE_TIMEOUT_MS = '200'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

// A farmd that never responds — models a network partition or a wedged
// merge/test subprocess on the farm side, not an HTTP error it can report.
globalThis.fetch = (_url, { signal } = {}) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
  })

const insertItem = db.prepare(
  `INSERT INTO work_item (id, title, priority, cursor, repo, pr, pr_mergeable)
   VALUES (?, ?, 'Medium', ?, ?, ?, ?)`,
)

test('a farmd that never responds is aborted at FARM_CONFLICT_RESOLVE_TIMEOUT_MS and escalates instead of hanging the gate forever', async () => {
  insertItem.run('RC-T1', 'Farmd hangs', ACCEPT_GATE_INDEX, 'acme/demo', 97, 0)

  const started = Date.now()
  const result = await orchestrator.resolveConflicts('RC-T1', 'Alice')
  const elapsedMs = Date.now() - started

  assert.deepEqual(result, { ok: true, resolved: false, escalated: true })
  assert.ok(elapsedMs < 5000, `expected the abort to fire near the 200ms timeout, took ${elapsedMs}ms`)
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'RC-T1'").get().cursor, IMPLEMENT_STEP_INDEX)
  const feedback = db.prepare("SELECT message FROM feedback WHERE item_id = 'RC-T1'").get()
  assert.match(feedback.message, /timed out after 200ms/)
})
