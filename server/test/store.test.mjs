// Store-level tests for the feedback path (success metric 2, UI leg) and
// issue-body parsing. Each node --test file runs in its own process, so the
// DB is a private temp file set before the first import of db.js.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-store-')), 'test.db')

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../src/lifecycle.js')

// Deterministic fixtures; cursor 11 is an agent step (implement), 3 is a gate.
const insertItem = db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor, repo, issue) VALUES (?, ?, 'Medium', ?, ?, ?)",
)
insertItem.run('T-AGENT', 'On an agent step', 11, null, null)
insertItem.run('T-GATE', 'Parked at a gate', 3, null, null)
insertItem.run('T-CLOSED', 'Closed item', STEPS.length, null, null)

assert.equal(STEPS[11].kind, 'agent')
assert.equal(STEPS[3].kind, 'gate')

const feedbackRows = (id) => db.prepare('SELECT * FROM feedback WHERE item_id = ? ORDER BY id').all(id)

test('addFeedback on an unknown item is not_found', () => {
  assert.deepEqual(store.addFeedback('NOPE-1', { message: 'hello' }), { error: 'not_found' })
})

test('addFeedback on a closed item is rejected', () => {
  assert.deepEqual(store.addFeedback('T-CLOSED', { message: 'too late' }), { error: 'closed' })
})

test('addFeedback with a blank message is rejected', () => {
  assert.deepEqual(store.addFeedback('T-GATE', { message: '   ' }), { error: 'empty_message' })
})

test('feedback while parked at a gate queues (delivered_at NULL), in order', () => {
  assert.deepEqual(store.addFeedback('T-GATE', { message: 'first note' }), { ok: true, queued: true })
  assert.deepEqual(store.addFeedback('T-GATE', { message: 'second note' }), { ok: true, queued: true })
  const rows = feedbackRows('T-GATE')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.message), ['first note', 'second note'])
  assert.ok(rows.every((r) => r.delivered_at === null))
})

test('feedback on a live agent step supersedes the run and re-kicks (rerun:true)', () => {
  const calls = []
  store.registerAgentRunner({
    kick: (id) => calls.push(['kick', id]),
    cancel: (id, status) => calls.push(['cancel', id, status]),
  })
  const result = store.addFeedback('T-AGENT', { message: 'change direction' })
  assert.deepEqual(result, { ok: true, rerun: true })
  assert.deepEqual(calls, [['cancel', 'T-AGENT', 'superseded'], ['kick', 'T-AGENT']])
  const rows = feedbackRows('T-AGENT')
  assert.equal(rows.length, 1)
  // Defaults the target to the step's owning agent so dispatch prompts name it.
  assert.equal(rows[0].target, STEPS[11].agent)
  store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
})

test('feedback on a paused item queues instead of re-running', () => {
  db.prepare('UPDATE work_item SET paused = 1 WHERE id = ?').run('T-AGENT')
  assert.deepEqual(store.addFeedback('T-AGENT', { message: 'while paused' }), { ok: true, queued: true })
  db.prepare('UPDATE work_item SET paused = 0 WHERE id = ?').run('T-AGENT')
})

test('the same GitHub comment id is ingested exactly once', () => {
  const first = store.addFeedback('T-GATE', { message: 'gh comment', source: 'github', ghCommentId: 777 })
  assert.deepEqual(first, { ok: true, queued: true })
  const again = store.addFeedback('T-GATE', { message: 'gh comment (edited)', source: 'github', ghCommentId: 777 })
  assert.deepEqual(again, { ok: true, duplicate: true })
  assert.equal(feedbackRows('T-GATE').filter((r) => r.gh_comment_id === 777).length, 1)
})

// ---- specialist persona (HZ-4) ----

test('the persona migration is idempotent and NULL rows read back as null', () => {
  // Re-running the ALTER is what db.js's migration loop does on every boot.
  assert.throws(() => db.exec('ALTER TABLE work_item ADD COLUMN persona TEXT'), /duplicate column/)
  const gate = store.listItems().find((it) => it.id === 'T-GATE')
  assert.equal(gate.persona, null) // farm/UI resolve NULL to fullstack
})

// ---- automated review (HZ-30) ----

test('the review_cycle_count column and pipeline_v3_review_shift migration are idempotent', () => {
  assert.throws(
    () => db.exec('ALTER TABLE work_item ADD COLUMN review_cycle_count INTEGER NOT NULL DEFAULT 0'),
    /duplicate column/,
  )
  // Re-running the shift transaction must not double-shift a second time —
  // it's guarded by the same setting-row-as-atomic-lock trick as
  // pipeline_v2_shift: the INSERT is the LAST statement, so a second run
  // fails on the primary-key collision and its UPDATEs never apply.
  assert.throws(
    () => db.prepare("INSERT INTO setting (key, value) VALUES ('pipeline_v3_review_shift', 'done')").run(),
    /UNIQUE constraint failed/,
  )
  assert.equal(STEPS[REVIEW_STEP_INDEX].label, 'Automated review (code + QA)')
  assert.equal(STEPS[ACCEPT_GATE_INDEX].label, 'Accept the code')
  assert.equal(store.getItem('T-AGENT').review_cycle_count, 0)
})

test('requestChanges rejecting the Accept-the-code gate sends the item back to Eng implement, not the Review step', () => {
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, review_cycle_count) VALUES (?, ?, ?, ?, ?)',
  ).run('T-ACCEPT-GATE', 'Awaiting accept', 'Medium', ACCEPT_GATE_INDEX, 2)
  const result = store.requestChanges('T-ACCEPT-GATE', 'Accept the code', 'this has a bug')
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('T-ACCEPT-GATE')
  // Not REVIEW_STEP_INDEX — re-running Review alone would just re-judge the
  // same unchanged diff and produce the identical verdict.
  assert.equal(item.cursor, IMPLEMENT_STEP_INDEX)
  // A human-directed rework gets a fresh set of automated review cycles.
  assert.equal(item.review_cycle_count, 0)
  const feedback = db.prepare("SELECT target, message FROM feedback WHERE item_id = 'T-ACCEPT-GATE'").get()
  assert.equal(feedback.target, STEPS[IMPLEMENT_STEP_INDEX].agent)
  assert.equal(feedback.message, 'this has a bug')
})

test('requestChanges rejecting a non-accept gate still walks back to the nearest agent step', () => {
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, review_cycle_count) VALUES (?, ?, ?, ?, ?)',
  ).run('T-OTHER-GATE', 'Awaiting a different gate', 'Medium', 5, 0)
  const result = store.requestChanges('T-OTHER-GATE', 'Approve the high-level design', 'needs another pass')
  assert.deepEqual(result, { ok: true })
  assert.equal(store.getItem('T-OTHER-GATE').cursor, 4) // nearest preceding agent step (Ensemble), unaffected by HZ-30
})

test('setPersona validates, persists, logs an event and notifies', () => {
  let notified = 0
  const off = store.onChange(() => notified++)
  assert.deepEqual(store.setPersona('NOPE-1', 'python_backend'), { error: 'not_found' })
  assert.deepEqual(store.setPersona('T-CLOSED', 'python_backend'), { error: 'closed' })
  assert.deepEqual(store.setPersona('T-GATE', 'rustacean'), { error: 'bad_persona' })
  assert.equal(notified, 0)

  assert.deepEqual(store.setPersona('T-GATE', 'python_backend'), { ok: true })
  assert.equal(notified, 1)
  assert.equal(store.getItem('T-GATE').persona, 'python_backend')
  const event = db.prepare("SELECT text FROM event WHERE item_id = 'T-GATE' ORDER BY id DESC").get()
  assert.equal(event.text, 'set the specialist persona to Python backend')
  off()
})

test('setPersona rejects items in an inactive project', () => {
  const projectA = db.prepare("INSERT INTO project (name) VALUES ('proj-a')").run().lastInsertRowid
  const projectB = db.prepare("INSERT INTO project (name) VALUES ('proj-b')").run().lastInsertRowid
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES ('T-OTHER', 'Other project', 'Medium', 3, ?)").run(projectB)
  db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES ('active_project_id', ?)").run(String(projectA))
  assert.deepEqual(store.setPersona('T-OTHER', 'fullstack'), { error: 'project_not_active' })
  db.prepare("DELETE FROM setting WHERE key = 'active_project_id'").run()
})

test('upsertFromGithub never clobbers the persona', () => {
  const projectId = db.prepare("INSERT INTO project (name) VALUES ('gh-sync')").run().lastInsertRowid
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/demo', 'AC')").run(projectId)
  store.upsertFromGithub({ number: 9, title: 'Synced item', body: 'do the thing', state: 'open', labels: [] }, 'acme/demo')
  assert.deepEqual(store.setPersona('AC-9', 'frontend_ui'), { ok: true })
  // A later sync (edited title/body) must leave the human's persona alone.
  store.upsertFromGithub({ number: 9, title: 'Synced item (edited)', body: 'do it better', state: 'open', labels: [] }, 'acme/demo')
  const item = store.getItem('AC-9')
  assert.equal(item.title, 'Synced item (edited)')
  assert.equal(item.persona, 'frontend_ui')
})

test('upsertFromGithub keeps same-numbered issues from two repos apart', () => {
  // Issue numbers are per-repo; two connected repos both having a #25 must not
  // trip a unique constraint (this is what broke connecting a fourth repo).
  const projectId = db.prepare("INSERT INTO project (name) VALUES ('multi-repo')").run().lastInsertRowid
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/one', 'ON')").run(projectId)
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/two', 'TW')").run(projectId)
  const issue = { number: 25, title: 'Same number', body: '', state: 'open', labels: [] }
  assert.equal(store.upsertFromGithub(issue, 'acme/one'), true)
  assert.equal(store.upsertFromGithub(issue, 'acme/two'), true)
  assert.equal(store.getItem('ON-25').repo, 'acme/one')
  assert.equal(store.getItem('TW-25').repo, 'acme/two')
  // The same issue in the same repo is still one row.
  assert.equal(store.upsertFromGithub({ ...issue, title: 'Edited' }, 'acme/one'), true)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_item WHERE issue = 25 AND repo LIKE 'acme/%'").get().n, 2)
})

// ---- priority (HZ-7, the WhatsApp concierge's set_priority action) ----

test('setPriority validates, persists, logs an event and notifies', () => {
  let notified = 0
  const off = store.onChange(() => notified++)
  assert.deepEqual(store.setPriority('NOPE-1', 'High'), { error: 'not_found' })
  assert.deepEqual(store.setPriority('T-CLOSED', 'High'), { error: 'closed' })
  assert.deepEqual(store.setPriority('T-GATE', 'urgent'), { error: 'bad_priority' })
  assert.deepEqual(store.setPriority('T-GATE', 'high'), { error: 'bad_priority' }) // enum is case-sensitive
  assert.equal(notified, 0)

  assert.deepEqual(store.setPriority('T-GATE', 'High'), { ok: true })
  assert.equal(notified, 1)
  assert.equal(store.getItem('T-GATE').priority, 'High')
  const event = db.prepare("SELECT text FROM event WHERE item_id = 'T-GATE' ORDER BY id DESC").get()
  assert.equal(event.text, 'set the priority to High (was Medium)')
  off()
})

test('setPriority to the current value is a no-op: ok, no extra event, no notify', () => {
  let notified = 0
  const off = store.onChange(() => notified++)
  const before = db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = 'T-GATE'").get().n
  assert.deepEqual(store.setPriority('T-GATE', 'High'), { ok: true, unchanged: true })
  assert.equal(notified, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = 'T-GATE'").get().n, before)
  off()
})

test('setPriority rejects items in an inactive project', () => {
  const projectC = db.prepare("INSERT INTO project (name) VALUES ('proj-c')").run().lastInsertRowid
  const projectD = db.prepare("INSERT INTO project (name) VALUES ('proj-d')").run().lastInsertRowid
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES ('T-PRIO', 'Other project', 'Medium', 3, ?)",
  ).run(projectD)
  db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES ('active_project_id', ?)").run(String(projectC))
  assert.deepEqual(store.setPriority('T-PRIO', 'High'), { error: 'project_not_active' })
  db.prepare("DELETE FROM setting WHERE key = 'active_project_id'").run()
})

test('activeRun in the snapshot carries the run id for the live log tail (HZ-5)', () => {
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES ('T-AGENT', 11, 2, 'Eng')")
    .run().lastInsertRowid
  const item = store.listItems().find((it) => it.id === 'T-AGENT')
  // id folded into the existing activeRun object — no sibling field.
  assert.equal(item.activeRun.id, runId)
  assert.equal(item.activeRun.step_index, 11)
  assert.equal(item.activeRun.attempt, 2)
  assert.ok(item.activeRun.started_at)
  db.prepare('DELETE FROM step_run WHERE id = ?').run(runId)
})

test('parseIssueBody lifts Outcome / Success metric / Guardrails sections', () => {
  const parsed = store.parseIssueBody(
    '## Outcome\nShip the thing\n\n## Success metric\nIt works\n\n## Guardrails\nTests pass',
  )
  assert.deepEqual(parsed, { desc: 'Ship the thing', metric: 'It works', guardrails: 'Tests pass' })
})

test('parseIssueBody without headings lands the body in desc', () => {
  const parsed = store.parseIssueBody('just a plain description')
  assert.equal(parsed.desc, 'just a plain description')
  assert.equal(parsed.metric, '')
})

// ---- currentStep (WhatsApp concierge status lines) ----

test('listItems resolves currentStep so non-UI clients can see gate state', () => {
  const byId = Object.fromEntries(store.listItems().map((it) => [it.id, it]))
  assert.deepEqual(byId['T-GATE'].currentStep, {
    index: 3, label: 'Approve & prioritize this work', kind: 'gate', phase: 'Plan', gate: true,
  })
  assert.deepEqual(byId['T-AGENT'].currentStep, {
    index: 11, label: 'Specialist agent implements', kind: 'agent', phase: 'Execute', gate: false,
  })
  assert.deepEqual(byId['T-CLOSED'].currentStep, {
    index: STEPS.length, label: 'Closed', kind: 'done', phase: 'Done', gate: false,
  })
})

test('stepOutputs carry the step label for non-UI clients', () => {
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact) VALUES ('T-GATE', 8, 1, 'QA', 'done', 'verdict: pass', '# QA review')",
  ).run()
  const gate = store.listItems().find((it) => it.id === 'T-GATE')
  assert.deepEqual(gate.stepOutputs['8'], {
    output: 'verdict: pass', attempt: 1, artifact: '# QA review', label: 'QA reviews the test plan',
  })
})

// ---- abandon (HZ-59): soft delete with a reason and an audit trail ----

const { isAbandoned, isClosed } = await import('../src/lifecycle.js')

test('abandonItem on an unknown item is not_found', () => {
  assert.deepEqual(store.abandonItem('NOPE-1', 'no longer needed'), { error: 'not_found' })
})

test('abandonItem on a closed item is rejected — abandoned is not a way to re-close a delivered item', () => {
  assert.deepEqual(store.abandonItem('T-CLOSED', 'too late'), { error: 'closed' })
})

test('abandonItem requires a non-empty, trimmed reason', () => {
  assert.deepEqual(store.abandonItem('T-GATE', ''), { error: 'reason_required' })
  assert.deepEqual(store.abandonItem('T-GATE', '   '), { error: 'reason_required' })
})

test('abandonItem cancels the in-flight run, marks the item abandoned (distinct from closed), and logs an event with the reason and actor', () => {
  insertItem.run('T-ABANDON', 'Abandon me', 11, null, null)
  const calls = []
  store.registerAgentRunner({
    kick: (id) => calls.push(['kick', id]),
    cancel: (id, status) => calls.push(['cancel', id, status]),
  })
  const result = store.abandonItem('T-ABANDON', 'no longer a priority', 'Dana')
  assert.deepEqual(result, { ok: true })
  // Cancellation happens so the in-flight run stops burning a concurrency
  // slot — the same /steps/cancel path pause/reject already use.
  assert.deepEqual(calls, [['cancel', 'T-ABANDON', 'cancelled']])
  store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

  const item = store.getItem('T-ABANDON')
  assert.equal(isAbandoned(item), true)
  assert.equal(isClosed(item), false, 'abandoned must not also read as closed')
  assert.equal(item.cursor, 11, 'abandonment does not touch cursor — it is not modeled as completed')
  assert.equal(item.abandoned_reason, 'no longer a priority')
  assert.equal(item.abandoned_by, 'Dana')
  assert.ok(item.abandoned_at)

  const event = db.prepare("SELECT who, text FROM event WHERE item_id = 'T-ABANDON' ORDER BY id DESC LIMIT 1").get()
  assert.equal(event.who, 'Dana')
  assert.equal(event.text, 'abandoned this item: no longer a priority')

  const snapshot = store.listItems().find((it) => it.id === 'T-ABANDON')
  assert.equal(snapshot.abandoned_reason, 'no longer a priority')
  assert.equal(snapshot.abandoned_by, 'Dana')
})

test('abandonItem is not re-entrant — abandoning twice is rejected, not a double event', () => {
  insertItem.run('T-ABANDON-TWICE', 'Abandon twice', 4, null, null)
  assert.deepEqual(store.abandonItem('T-ABANDON-TWICE', 'first reason'), { ok: true })
  assert.deepEqual(store.abandonItem('T-ABANDON-TWICE', 'second reason'), { error: 'already_abandoned' })
  const item = store.getItem('T-ABANDON-TWICE')
  assert.equal(item.abandoned_reason, 'first reason', 'the second call must not overwrite the first')
})

test('soft delete: step_run, artifact and gate_decision history survive abandonment unchanged, and the active run is handed to agentRunner.cancel (not deleted here)', () => {
  insertItem.run('T-ABANDON-HISTORY', 'Has history', 6, null, null)
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact) VALUES ('T-ABANDON-HISTORY', 4, 1, 'Ensemble', 'done', 'planned options', '# plan')",
  ).run()
  db.prepare(
    "INSERT INTO gate_decision (item_id, step_index, decision, notes, decided_by) VALUES ('T-ABANDON-HISTORY', 5, 'approved', 'looks good', 'Dana')",
  ).run()
  const runId = db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES ('T-ABANDON-HISTORY', 6, 1, 'Eng', 'active')",
  ).run().lastInsertRowid
  const eventCountBefore = db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = 'T-ABANDON-HISTORY'").get().n

  // Stand in for the real orchestrator.cancel (registered at boot; see
  // orchestrator.test.mjs for its own coverage) — closes the active row the
  // same way, so this test can assert abandonItem delegates rather than
  // deleting or racing it directly.
  const calls = []
  store.registerAgentRunner({
    kick: () => {},
    cancel: (id, status) => {
      calls.push([id, status])
      db.prepare("UPDATE step_run SET status = ?, ended_at = datetime('now') WHERE item_id = ? AND status = 'active'").run(
        status,
        id,
      )
    },
  })

  const result = store.abandonItem('T-ABANDON-HISTORY', 'evidence must survive')
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls, [['T-ABANDON-HISTORY', 'cancelled']])
  store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

  // Nothing was deleted — soft delete only.
  const doneRun = db.prepare("SELECT * FROM step_run WHERE item_id = 'T-ABANDON-HISTORY' AND step_index = 4").get()
  assert.equal(doneRun.status, 'done')
  assert.equal(doneRun.artifact, '# plan')
  const gate = db.prepare("SELECT * FROM gate_decision WHERE item_id = 'T-ABANDON-HISTORY'").get()
  assert.equal(gate.notes, 'looks good')
  // The active run is closed (cancelled), not deleted — its row still reads back.
  const closedRun = db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId)
  assert.equal(closedRun.status, 'cancelled')
  const eventCountAfter = db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = 'T-ABANDON-HISTORY'").get().n
  assert.equal(eventCountAfter, eventCountBefore + 1, 'abandonment adds an event, never removes one')
})

test('abandoned items are rejected by every other mutation — the item is frozen, not just undispatched', () => {
  insertItem.run('T-ABANDON-FROZEN', 'Frozen after abandon', 3, null, null)
  assert.equal(STEPS[3].kind, 'gate')
  assert.deepEqual(store.abandonItem('T-ABANDON-FROZEN', 'stopping this'), { ok: true })

  // Would otherwise be legal (parked exactly at a gate) if not for the
  // isAbandoned guard — proves abandonment, not step kind, is what blocks it.
  assert.deepEqual(store.approveGate('T-ABANDON-FROZEN', 3, ''), { error: 'not_at_gate' })
  assert.deepEqual(store.requestChanges('T-ABANDON-FROZEN', 'target', 'feedback'), { error: 'abandoned' })
  assert.deepEqual(store.setPaused('T-ABANDON-FROZEN', true), { error: 'abandoned' })
  assert.deepEqual(store.setPersona('T-ABANDON-FROZEN', 'fullstack'), { error: 'abandoned' })
  assert.deepEqual(store.setPriority('T-ABANDON-FROZEN', 'High'), { error: 'abandoned' })
  assert.deepEqual(store.addFeedback('T-ABANDON-FROZEN', { message: 'late note' }), { error: 'abandoned' })
  assert.deepEqual(store.restartPhase('T-ABANDON-FROZEN', 0, 'reopen attempt'), { error: 'abandoned' })
})

test('upsertFromGithub: closing the issue on an already-abandoned item does not silently complete it (self-webhook race, HZ-59)', () => {
  const projectId = db.prepare("INSERT INTO project (name) VALUES ('abandon-sync')").run().lastInsertRowid
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/abandon', 'AB')").run(projectId)
  store.upsertFromGithub({ number: 41, title: 'Will be abandoned', body: 'do the thing', state: 'open', labels: [] }, 'acme/abandon')
  assert.deepEqual(store.abandonItem('AB-41', 'stopping this work'), { ok: true })
  const beforeCursor = store.getItem('AB-41').cursor

  // Simulates the webhook that abandonItem's own GitHub close triggers,
  // landing on the DB after abandoned_at is already set (see app.js's ordering).
  store.upsertFromGithub({ number: 41, title: 'Will be abandoned', body: 'do the thing', state: 'closed', labels: [] }, 'acme/abandon')

  const item = store.getItem('AB-41')
  assert.equal(item.cursor, beforeCursor, 'cursor must not advance to STEPS.length — that would read as completed')
  assert.equal(isAbandoned(item), true)
  assert.notEqual(item.cursor, STEPS.length)
})

test('upsertFromGithub: reopening the issue on an abandoned item does not resurrect it into the pipeline', () => {
  const projectId = db.prepare("INSERT INTO project (name) VALUES ('abandon-reopen')").run().lastInsertRowid
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/reopen', 'RO')").run(projectId)
  store.upsertFromGithub({ number: 55, title: 'Reopen target', body: 'do the thing', state: 'open', labels: [] }, 'acme/reopen')
  assert.deepEqual(store.abandonItem('RO-55', 'stopping this work'), { ok: true })
  const calls = []
  store.registerAgentRunner({ kick: (id) => calls.push(id), cancel: () => {} })

  store.upsertFromGithub({ number: 55, title: 'Reopen target', body: 'do the thing', state: 'open', labels: [] }, 'acme/reopen')

  assert.ok(isAbandoned(store.getItem('RO-55')))
  assert.ok(!calls.includes('RO-55'), 'a reopen on GitHub must not silently re-enter the pipeline for an abandoned item')
  store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
})
