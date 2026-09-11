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
const { STEPS } = await import('../src/lifecycle.js')

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
