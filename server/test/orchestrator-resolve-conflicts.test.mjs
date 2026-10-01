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
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-resolve-conflicts-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
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

function allStepRuns(itemId) {
  return db.prepare('SELECT step_index, attempt, status FROM step_run WHERE item_id = ? ORDER BY id').all(itemId)
}

function insertDoneRun(itemId, stepIndex, attempt, artifact) {
  db.prepare(
    `INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact, started_at, ended_at)
     VALUES (?, ?, ?, ?, 'done', ?, datetime('now'), datetime('now'))`,
  ).run(itemId, stepIndex, attempt, STEPS[stepIndex].agent, artifact)
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

// ---- guardrail: "must leave the item's existing review/QA artifacts intact" ----

test('a mechanical fix leaves every already-passed step_run row — including review/QA — byte-for-byte untouched', async () => {
  insertItem.run('RC-6', 'Has prior review/QA artifacts', ACCEPT_GATE_INDEX, 'acme/demo', 95, 0)
  insertDoneRun('RC-6', IMPLEMENT_STEP_INDEX, 1, null)
  insertDoneRun('RC-6', REVIEW_STEP_INDEX, 1, 'code review: pass\nQA review: pass')
  farmdReply = { ok: true, json: async () => ({ ok: true, resolved: true, summary: 'merged and pushed' }) }

  const before = allStepRuns('RC-6')
  const beforeReviewArtifact = db
    .prepare('SELECT artifact FROM step_run WHERE item_id = ? AND step_index = ?')
    .get('RC-6', REVIEW_STEP_INDEX).artifact

  const result = await orchestrator.resolveConflicts('RC-6', 'Alice')

  assert.deepEqual(result, { ok: true, resolved: true })
  assert.deepEqual(allStepRuns('RC-6'), before, 'no step_run row — for any step — may be added, removed, or changed')
  assert.equal(
    db.prepare('SELECT artifact FROM step_run WHERE item_id = ? AND step_index = ?').get('RC-6', REVIEW_STEP_INDEX)
      .artifact,
    beforeReviewArtifact,
    'the review/QA artifact content itself must survive untouched',
  )
})

// ---- HZ-154: the scoped path reports mode: 'scoped' and carries a verdict ----

test('a scoped resolution records the files, the hunk count and the review verdict, and still writes no step_run row', async () => {
  insertItem.run('RC-8', 'Scoped conflict fix', ACCEPT_GATE_INDEX, 'acme/demo', 124, 0)
  insertDoneRun('RC-8', IMPLEMENT_STEP_INDEX, 7, null)
  insertDoneRun('RC-8', REVIEW_STEP_INDEX, 1, 'code review: pass\nQA review: pass')
  farmdReply = {
    ok: true,
    json: async () => ({
      ok: true,
      resolved: true,
      mode: 'scoped',
      summary: 'resolved 2 conflicted hunk(s) in 2 file(s) while merging origin/main (deterministic); 3 repo check(s) passed',
      resolution: {
        strategy: 'deterministic',
        hunks: 2,
        paths: ['farm/providers/claude.py', 'farm/providers/muse.py'],
        hunk_labels: ['farm/providers/claude.py hunk 1', 'farm/providers/muse.py hunk 1'],
      },
      review: { verdict: 'pass', reviewed: true, summary: 'both imports kept', findings: [] },
    }),
  }

  const before = allStepRuns('RC-8')
  const result = await orchestrator.resolveConflicts('RC-8', 'Alice')

  assert.deepEqual(result, {
    ok: true,
    resolved: true,
    mode: 'scoped',
    review: { verdict: 'pass', reviewed: true, summary: 'both imports kept', findings: [] },
  })
  assert.deepEqual(allStepRuns('RC-8'), before, 'the implement attempt count and the review step must not move')
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'RC-8'").get().cursor, ACCEPT_GATE_INDEX)

  const text = eventTexts('RC-8').at(-1)
  assert.match(text, /resolved 2 conflicted hunk\(s\) on PR #124/)
  assert.match(text, /farm\/providers\/claude\.py, farm\/providers\/muse\.py/)
  assert.match(text, /scoped review passed: both imports kept/)
  assert.match(text, /no re-implementation and no re-review/)
})

test("the recorded payload farmd really returns renders the same way a hand-written one does", async () => {
  // Not a literal: this is the exact body
  // farm/tests/test_farmd.py's scoped end-to-end test asserts /conflicts/resolve
  // returns over real FastAPI routing. Both halves of the seam are pinned to
  // one real reply, so a shape change on the Python side fails here too
  // instead of drifting silently past a stale mock.
  const recorded = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../farm/tests/fixtures/scoped_resolve_response.json'), 'utf8'),
  )
  insertItem.run('RC-11', 'Scoped, from the recorded farmd reply', ACCEPT_GATE_INDEX, 'acme/demo', 127, 0)
  insertDoneRun('RC-11', IMPLEMENT_STEP_INDEX, 7, null)
  farmdReply = { ok: true, json: async () => recorded }

  const before = allStepRuns('RC-11')
  const result = await orchestrator.resolveConflicts('RC-11', 'Alice')

  assert.equal(result.resolved, true)
  assert.equal(result.mode, 'scoped')
  assert.deepEqual(result.review, recorded.review)
  assert.deepEqual(allStepRuns('RC-11'), before)

  const text = eventTexts('RC-11').at(-1)
  assert.match(text, /resolved 1 conflicted hunk\(s\) on PR #127 in shared\.txt \(both sides kept, no agent needed\)/)
  assert.match(text, /no agent review — the resolution used only parent lines/)
  assert.doesNotMatch(text, /scoped review passed/, 'no reviewer ran, so no verdict may be claimed')
})

test('an agent-resolved hunk says so, and carries the scoped reviewer verdict that cleared it', async () => {
  insertItem.run('RC-12', 'Scoped, agent strategy', ACCEPT_GATE_INDEX, 'acme/demo', 128, 0)
  insertDoneRun('RC-12', IMPLEMENT_STEP_INDEX, 7, null)
  insertDoneRun('RC-12', REVIEW_STEP_INDEX, 1, 'code review: pass\nQA review: pass')
  farmdReply = {
    ok: true,
    json: async () => ({
      ok: true,
      resolved: true,
      mode: 'scoped',
      summary: 'resolved 1 conflicted hunk(s) in 1 file(s) while merging origin/main (agent); 3 repo check(s) passed',
      resolution: { strategy: 'agent', hunks: 1, paths: ['farm/step_agent.py'], hunk_labels: ['farm/step_agent.py hunk 1'] },
      review: { verdict: 'pass', reviewed: true, summary: 'the combined guard keeps both conditions', findings: [] },
    }),
  }

  const before = allStepRuns('RC-12')
  const result = await orchestrator.resolveConflicts('RC-12', 'Alice')

  assert.equal(result.resolved, true)
  assert.deepEqual(allStepRuns('RC-12'), before, 'an agent resolution is still not an implement attempt')
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'RC-12'").get().cursor, ACCEPT_GATE_INDEX)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM gate_decision WHERE item_id = 'RC-12'").get().c, 0)

  const text = eventTexts('RC-12').at(-1)
  assert.match(text, /resolved 1 conflicted hunk\(s\) on PR #128 in farm\/step_agent\.py/)
  assert.match(text, /\(resolved by an agent\)/, 'the log must say a model wrote these lines, not git')
  assert.match(text, /scoped review passed: the combined guard keeps both conditions/)
  assert.doesNotMatch(text, /no agent review/)
})

test("the Accept gate is never decided by a scoped success — it comes back to the human, PIN and all", async () => {
  insertItem.run('RC-9', 'Scoped conflict fix, gate untouched', ACCEPT_GATE_INDEX, 'acme/demo', 125, 0)
  insertDoneImplementRun('RC-9', 1)
  farmdReply = {
    ok: true,
    json: async () => ({
      ok: true,
      resolved: true,
      mode: 'scoped',
      summary: 'resolved 1 conflicted hunk(s)',
      resolution: { strategy: 'deterministic', hunks: 1, paths: ['a.py'] },
      review: { verdict: 'pass', reviewed: false, summary: 'no agent review — the resolution used only parent lines' },
    }),
  }

  const result = await orchestrator.resolveConflicts('RC-9', 'Alice')

  assert.equal(result.resolved, true)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM gate_decision WHERE item_id = 'RC-9'").get().c, 0)
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'RC-9'").get().cursor, ACCEPT_GATE_INDEX)
  // No reviewer ran, so the log must not claim a verdict one gave.
  const text = eventTexts('RC-9').at(-1)
  assert.match(text, /no agent review — the resolution used only parent lines/)
  assert.doesNotMatch(text, /scoped review passed/)
})

test('the mechanical success text is byte-identical to what it was before the scoped path existed', async () => {
  insertItem.run('RC-10', 'Still mechanical', ACCEPT_GATE_INDEX, 'acme/demo', 126, 0)
  insertDoneImplementRun('RC-10', 1)
  farmdReply = { ok: true, json: async () => ({ ok: true, resolved: true, summary: 'merged and pushed' }) }

  const result = await orchestrator.resolveConflicts('RC-10', 'Alice')

  assert.deepEqual(result, { ok: true, resolved: true }, 'no mode/review keys on the mechanical path')
  assert.equal(
    eventTexts('RC-10').at(-1),
    'resolved merge conflicts on PR #126 mechanically — no re-implementation needed (merged and pushed)',
  )
})

test('each scoped refusal escalates with its own message, and an unknown reason still falls back', async () => {
  const cases = [
    ['conflict_too_large', /too many conflicted files or lines/],
    ['conflict_unsupported', /rename, a deletion or a binary clash/],
    ['resolution_unsure', /could not be sure of the fix/],
    ['resolution_out_of_scope', /outside the conflicted regions/],
    ['markers_remaining', /conflict markers were still present/],
    ['scoped_review_rejected', /scoped review of the resolution rejected it/],
    ['scoped_checks_failed', /hunks were resolved but the repo's own checks then failed/],
    ['something_new_nobody_mapped', /the raw detail farmd sent/],
  ]
  let pr = 200
  for (const [reason, expected] of cases) {
    const id = `RC-R-${reason}`
    insertItem.run(id, `Escalates: ${reason}`, ACCEPT_GATE_INDEX, 'acme/demo', pr++, 0)
    insertDoneImplementRun(id, 1)
    farmdReply = {
      ok: true,
      json: async () => ({ ok: true, resolved: false, reason, detail: 'the raw detail farmd sent' }),
    }

    const result = await orchestrator.resolveConflicts(id, 'Alice')

    assert.deepEqual(result, { ok: true, resolved: false, escalated: true }, reason)
    assert.equal(db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor, IMPLEMENT_STEP_INDEX, reason)
    const feedback = db.prepare('SELECT message FROM feedback WHERE item_id = ?').get(id)
    assert.match(feedback.message, expected, reason)
  }
})

test('the e2e conflict-reply hook is one-shot and never stubs a second resolve', async () => {
  // Registered only when HORIZON_TEST_HOOKS=1 (app.js). The risk it carries is
  // a canned reply outliving the one call it was queued for and silently
  // standing in for a real farmd round trip — so it is consumed, not read.
  insertItem.run('RC-13', 'Hook is one-shot', ACCEPT_GATE_INDEX, 'acme/demo', 129, 0)
  insertItem.run('RC-14', 'Second resolve hits farmd', ACCEPT_GATE_INDEX, 'acme/demo', 130, 0)
  orchestrator.setConflictReplyForTest({ ok: true, resolved: true, summary: 'canned' })
  farmdReply = {
    ok: true,
    json: async () => ({ ok: true, resolved: false, reason: 'merge_conflict', detail: 'from the real farmd' }),
  }
  lastRequest = null

  const first = await orchestrator.resolveConflicts('RC-13', 'Alice')
  assert.deepEqual(first, { ok: true, resolved: true })
  assert.equal(lastRequest, null, 'the canned reply must replace the farmd call, not race it')

  const second = await orchestrator.resolveConflicts('RC-14', 'Alice')
  assert.deepEqual(second, { ok: true, resolved: false, escalated: true })
  assert.equal(lastRequest.url, 'http://farm.test/conflicts/resolve', 'the next call must go to the real farmd')
})

test('an escalated conflict still leaves every prior step_run row — including review/QA — untouched (only feedback/cursor move)', async () => {
  insertItem.run('RC-7', 'Escalates, has prior review/QA artifacts', ACCEPT_GATE_INDEX, 'acme/demo', 96, 0)
  insertDoneRun('RC-7', IMPLEMENT_STEP_INDEX, 1, null)
  insertDoneRun('RC-7', REVIEW_STEP_INDEX, 1, 'code review: pass\nQA review: pass')
  farmdReply = {
    ok: true,
    json: async () => ({ ok: true, resolved: false, reason: 'merge_conflict', detail: 'conflicts in: shared.txt' }),
  }

  const before = allStepRuns('RC-7')
  const result = await orchestrator.resolveConflicts('RC-7', 'Alice')

  assert.deepEqual(result, { ok: true, resolved: false, escalated: true })
  assert.deepEqual(allStepRuns('RC-7'), before, 'escalation must not touch any existing step_run row either')
})
