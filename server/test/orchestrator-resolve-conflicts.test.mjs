// HZ-92: a PR whose only problem is a mechanical merge conflict must not
// re-run the full implement cycle. orchestrator.resolveConflicts() calls
// farmd's LLM-free /conflicts/resolve and either:
//   - leaves the item exactly where it was (no step_run row, no cursor
//     change) once farmd reports a mechanical fix, or
//   - falls back to the existing requestChanges() escalation path (the same
//     one the "send back to resolve conflicts" button always used) when
//     farmd reports it could not be sure the merge was safe.
//
// These tests exercise the Node-side contract against a mocked farmd reply —
// the real git merge/conflict/test-gate behavior is covered end-to-end in
// farm/tests/test_conflict_resolver.py.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-resolve-conflicts-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../src/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

let farmdReply = { ok: true, json: async () => ({ ok: true, resolved: true, summary: 'merged and pushed' }) }
let lastRequest = null
globalThis.fetch = async (url, opts) => {
  lastRequest = { url: String(url), body: opts?.body ? JSON.parse(opts.body) : null }
  return farmdReply
}

const insertItem = db.prepare(
  `INSERT INTO work_item (id, title, priority, cursor, repo, pr, pr_mergeable)
   VALUES (?, ?, 'Medium', ?, ?, ?, ?)`,
)

function insertDoneImplementRun(itemId, attempt) {
  db.prepare(
    `INSERT INTO step_run (item_id, step_index, attempt, agent, status, started_at, ended_at)
     VALUES (?, ?, ?, ?, 'done', datetime('now'), datetime('now'))`,
  ).run(itemId, IMPLEMENT_STEP_INDEX, attempt, STEPS[IMPLEMENT_STEP_INDEX].agent)
}

function implementRuns(itemId) {
  return db
    .prepare('SELECT attempt, status FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id')
    .all(itemId, IMPLEMENT_STEP_INDEX)
}

function eventTexts(itemId) {
  return db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(itemId).map((r) => r.text)
}

test('a mechanical fix leaves the implement step untouched: no new step_run row, no cursor change (metric 1)', async () => {
  insertItem.run('RC-1', 'Mechanical conflict', ACCEPT_GATE_INDEX, 'acme/demo', 90, 0)
  insertDoneImplementRun('RC-1', 1)

  const before = implementRuns('RC-1')
  const result = await orchestrator.resolveConflicts('RC-1', 'Alice')

  assert.deepEqual(result, { ok: true, resolved: true })
  assert.deepEqual(implementRuns('RC-1'), before, 'the implement step must gain no new attempt')
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'RC-1'").get().cursor, ACCEPT_GATE_INDEX)
  assert.ok(
    eventTexts('RC-1').some((t) => t.includes('resolved merge conflicts on PR #90 mechanically')),
    'the mechanical fix must be visible in the activity feed',
  )
  assert.equal(lastRequest.url, 'http://farm.test/conflicts/resolve')
  assert.deepEqual(lastRequest.body, { item: { id: 'RC-1', repo: 'acme/demo' }, branch: 'horizon/rc-1' })
})

test('an incompatible same-line conflict escalates to the full implement cycle, not an auto-resolve (metric 2)', async () => {
  insertItem.run('RC-2', 'Real conflict', ACCEPT_GATE_INDEX, 'acme/demo', 91, 0)
  insertDoneImplementRun('RC-2', 1)
  farmdReply = {
    ok: true,
    json: async () => ({ ok: true, resolved: false, reason: 'merge_conflict', detail: 'conflicts in: shared.txt' }),
  }

  const result = await orchestrator.resolveConflicts('RC-2', 'Alice')

  assert.deepEqual(result, { ok: true, resolved: false, escalated: true })
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'RC-2'").get().cursor, IMPLEMENT_STEP_INDEX)
  const decision = db.prepare("SELECT decision, decided_by FROM gate_decision WHERE item_id = 'RC-2'").get()
  assert.equal(decision.decision, 'rejected')
  assert.equal(decision.decided_by, 'Alice')
  const feedback = db.prepare("SELECT message FROM feedback WHERE item_id = 'RC-2'").get()
  assert.match(feedback.message, /both branches changed the same lines/)
})

test('a clean merge whose tests then fail still escalates — the gate is the suite, not marker absence (metric 3)', async () => {
  insertItem.run('RC-3', 'Tests fail after merge', ACCEPT_GATE_INDEX, 'acme/demo', 92, 0)
  insertDoneImplementRun('RC-3', 1)
  farmdReply = {
    ok: true,
    json: async () => ({ ok: true, resolved: false, reason: 'tests_failed', detail: 'pytest -q failed' }),
  }

  const result = await orchestrator.resolveConflicts('RC-3', 'Alice')

  assert.deepEqual(result, { ok: true, resolved: false, escalated: true })
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'RC-3'").get().cursor, IMPLEMENT_STEP_INDEX)
  const feedback = db.prepare("SELECT message FROM feedback WHERE item_id = 'RC-3'").get()
  assert.match(feedback.message, /repo's own tests failed afterward/)
})

test('farmd being unreachable escalates the same way as a reported failure, rather than hanging the gate', async () => {
  insertItem.run('RC-4', 'Farm unreachable', ACCEPT_GATE_INDEX, 'acme/demo', 93, 0)
  insertDoneImplementRun('RC-4', 1)
  farmdReply = { ok: false, status: 502, json: async () => ({ error: 'farm returned 502' }) }

  const result = await orchestrator.resolveConflicts('RC-4', 'Alice')

  assert.deepEqual(result, { ok: true, resolved: false, escalated: true })
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'RC-4'").get().cursor, IMPLEMENT_STEP_INDEX)
})

test('guard clauses reject before ever calling farmd', async () => {
  insertItem.run('RC-5', 'Not conflicted', ACCEPT_GATE_INDEX, 'acme/demo', 94, 1) // pr_mergeable=1, not false
  lastRequest = null

  const result = await orchestrator.resolveConflicts('RC-5', 'Alice')

  assert.deepEqual(result, { error: 'not_conflicted' })
  assert.equal(lastRequest, null, 'farmd must never be called when there is nothing to resolve')
})
