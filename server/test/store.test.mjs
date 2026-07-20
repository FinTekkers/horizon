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
