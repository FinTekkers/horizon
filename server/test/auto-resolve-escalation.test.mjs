// HZ-235 metric line 4: an auto-started run has the button's outcomes. A
// conflict that needs judgment escalates to a full implement cycle with the
// same feedback a human-started run gives; only the recorded trigger (actor,
// gate_action.started_by) differs. And a button run after an auto run records
// started_by = 'human' again — the claim upsert rewrites it.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupAutoResolve } from './helpers/autoResolveHarness.mjs'

const h = await setupAutoResolve('auto-resolve-escalation')
const { db, lifecycle, orchestrator, autoResolve } = h
const { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } = lifecycle

beforeEach(() => h.reset())

const feedbackOf = (id) => db.prepare('SELECT message FROM feedback WHERE item_id = ? ORDER BY id').all(id).map((r) => r.message)
const mergeConflict = { ok: true, resolved: false, reason: 'merge_conflict', detail: 'src/a.js' }

test('a merge_conflict reply sends an auto-run item back to implement with the button run’s feedback text', async () => {
  // The button run, for comparison.
  h.conflictedAtGate('ES-BTN', 901)
  db.prepare('UPDATE work_item SET pr_mergeable = 0 WHERE id = ?').run('ES-BTN')
  h.farmReplyNext(mergeConflict)
  const click = await h.resolvePost('ES-BTN')
  assert.equal(click.statusCode, 200)
  assert.equal(h.row('ES-BTN').cursor, IMPLEMENT_STEP_INDEX)
  assert.equal(h.gateAction('ES-BTN').started_by, 'human')

  // The same reply on an auto-started run.
  h.conflictedAtGate('ES-AUTO', 902)
  h.farmReplyNext(mergeConflict)
  await h.mergeWebhook(950)
  await autoResolve.whenIdleForTest()

  assert.equal(h.row('ES-AUTO').cursor, IMPLEMENT_STEP_INDEX, 'escalated to a full implement cycle')
  assert.equal(h.gateAction('ES-AUTO').state, 'escalated')
  assert.equal(h.gateAction('ES-AUTO').started_by, 'main_moved')
  const expected = `: ${orchestrator.CONFLICT_ESCALATION_REASONS.merge_conflict}`
  assert.deepEqual(feedbackOf('ES-BTN').map((m) => m.replace('PR #901', 'PR #N')), feedbackOf('ES-AUTO').map((m) => m.replace('PR #902', 'PR #N')))
  assert.ok(feedbackOf('ES-AUTO').some((m) => m === `PR #902${expected}`))
  assert.match(h.itemLines('ES-AUTO')[0], /: started — escalated$/)
})

test('started_by upsert: an auto run, then a button run, records human', async () => {
  h.conflictedAtGate('ES-UP', 903)
  h.farmReplyNext({ ok: true, resolved: true, summary: 'merged' })
  await h.mergeWebhook(951)
  await autoResolve.whenIdleForTest()
  assert.equal(h.gateAction('ES-UP').started_by, 'main_moved')
  assert.equal(h.row('ES-UP').cursor, ACCEPT_GATE_INDEX)

  // GitHub flags it conflicted again; a human clicks the button.
  db.prepare('UPDATE work_item SET pr_mergeable = 0 WHERE id = ?').run('ES-UP')
  h.farmReplyNext({ ok: true, resolved: true, summary: 'merged' })
  const click = await h.resolvePost('ES-UP')
  assert.equal(click.statusCode, 200)
  assert.equal(h.gateAction('ES-UP').started_by, 'human')
  assert.equal(h.events('ES-UP').filter((t) => t.startsWith('main moved')).length, 1, 'the button writes no "started automatically" line')
})
