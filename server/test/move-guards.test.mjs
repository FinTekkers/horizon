// HZ-708: the existing move paths refuse what the UI only hid. A restart may
// not skip ahead or reopen a closed item, and a merged item's code is never
// rewound to before Accept the code. Every refusal changes nothing: no cancel,
// no gate_decision, feedback or event row, the cursor and runs as they were.
// Steps are named by label throughout.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-move-guards-')), 'test.db')

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, kindStepIndex, firstStepIndex, isClosed } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const runnerCalls = []
store.registerAgentRunner({
  kick: (...a) => runnerCalls.push(['kick', ...a]),
  cancel: (...a) => runnerCalls.push(['cancel', ...a]),
})

const at = (label, kind = 'change') => kindStepIndex(label, kind)
const IMPLEMENT = at('Specialist agent implements')
const ACCEPT = at('Accept the code')
const DEPLOY = at('Deploy the changes')
const REVIEW_CLOSE = at('Review the work & close')
const DRAFT_PLAN = at('Draft implementation plan')
const PLAN_GATE = at('Review before execution')
// Phases by the label of a row in them, never by number.
const PLAN_PHASE = STEPS[DRAFT_PLAN].phase
const EXECUTE_PHASE = STEPS[IMPLEMENT].phase
const DEPLOY_PHASE = STEPS[DEPLOY].phase
const FIRST_PHASE = STEPS[firstStepIndex('change')].phase

function makeItem(id, cursor, extra = {}) {
  const cols = ['id', 'title', 'priority', 'cursor', ...Object.keys(extra)]
  db.prepare(`INSERT INTO work_item (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(
    id,
    `Move guard fixture ${id}`,
    'Medium',
    cursor,
    ...Object.values(extra),
  )
  return id
}

// A run in flight on the item, so "changes nothing" includes "cancels nothing".
function runningAgent(id, stepIndex) {
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')").run(
    id,
    stepIndex,
    STEPS[stepIndex].agent || 'Horizon',
  )
}

const count = (table, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE item_id = ?`).get(id).n
const snapshot = (id) => ({
  cursor: store.getItem(id).cursor,
  merged_at: store.getItem(id).merged_at,
  gate_decision: count('gate_decision', id),
  feedback: count('feedback', id),
  event: count('event', id),
  runs: db.prepare('SELECT id, step_index, status FROM step_run WHERE item_id = ? ORDER BY id').all(id),
})

// The call is refused with `error` and leaves every trace of the item as it was.
function assertRefused(id, error, call) {
  const before = snapshot(id)
  runnerCalls.length = 0
  assert.deepEqual(call(), { error })
  assert.deepEqual(snapshot(id), before, `${error} changed the item`)
  assert.deepEqual(runnerCalls, [], `${error} reached the agent runner`)
}

// ---- metric 1: no forward restart, no restart of a closed item ----

test('restarting a phase after the current one is refused and changes nothing, a running agent included', () => {
  const id = makeItem('MG-AHEAD', DRAFT_PLAN)
  runningAgent(id, DRAFT_PLAN)
  assertRefused(id, 'phase_ahead', () => store.restartPhase(id, EXECUTE_PHASE, 'skip ahead'))
  assert.equal(snapshot(id).runs[0].status, 'active')
})

test('restarting the current phase still works', () => {
  const id = makeItem('MG-CURRENT', PLAN_GATE)
  assert.deepEqual(store.restartPhase(id, PLAN_PHASE, 'again'), { ok: true })
  assert.equal(STEPS[store.getItem(id).cursor].phase, PLAN_PHASE)
})

test('restarting an earlier phase still works', () => {
  const id = makeItem('MG-EARLIER', PLAN_GATE)
  assert.deepEqual(store.restartPhase(id, FIRST_PHASE, 'from the top'), { ok: true })
  assert.equal(store.getItem(id).cursor, firstStepIndex('change'))
})

test('an item closed through the Review the work & close approval refuses a restart of any phase', () => {
  const id = makeItem('MG-CLOSED', REVIEW_CLOSE)
  assert.equal(store.approveGate(id, REVIEW_CLOSE, '', 'You').ok, true)
  assert.ok(isClosed(store.getItem(id)), 'the approval did not close the item')
  for (const phase of [FIRST_PHASE, EXECUTE_PHASE, DEPLOY_PHASE]) {
    assertRefused(id, 'closed', () => store.restartPhase(id, phase, 'reopen'))
  }
})

// ---- metric 3: a merged item is never rewound before Accept the code ----

const MERGED = { merged_at: '2026-11-01 00:00:00', kind: 'change' }

test('merged: an explicit send-back to Specialist agent implements is refused and changes nothing', () => {
  const id = makeItem('MG-M-IMPL', REVIEW_CLOSE, MERGED)
  assertRefused(id, 'merged_target', () => store.requestChanges(id, 'Review the work & close', 'redo', 'You', IMPLEMENT))
})

test('merged: restarting the Execute phase is refused and changes nothing', () => {
  const id = makeItem('MG-M-EXEC', REVIEW_CLOSE, MERGED)
  runningAgent(id, DEPLOY)
  assertRefused(id, 'merged_target', () => store.restartPhase(id, EXECUTE_PHASE, 'rewind'))
  assert.equal(snapshot(id).runs[0].status, 'active')
})

test('merged: a default send-back from Accept the code is refused and changes nothing', () => {
  const id = makeItem('MG-M-ACCEPT', ACCEPT, MERGED)
  assertRefused(id, 'merged_target', () => store.requestChanges(id, 'Accept the code', ''))
})

test('merged: an explicit send-back to Deploy the changes works', () => {
  const id = makeItem('MG-M-DEPLOY', REVIEW_CLOSE, MERGED)
  assert.deepEqual(store.requestChanges(id, 'Review the work & close', 'redeploy', 'You', DEPLOY), { ok: true })
  assert.equal(STEPS[store.getItem(id).cursor].label, 'Deploy the changes')
})

test('merged: a default send-back from Review the work & close lands on Deploy the changes', () => {
  const id = makeItem('MG-M-DEFAULT', REVIEW_CLOSE, MERGED)
  assert.deepEqual(store.requestChanges(id, 'Review the work & close', ''), { ok: true })
  assert.equal(STEPS[store.getItem(id).cursor].label, 'Deploy the changes')
})

test('merged: restarting the Deploy phase still works', () => {
  const id = makeItem('MG-M-RDEPLOY', REVIEW_CLOSE, MERGED)
  assert.deepEqual(store.restartPhase(id, DEPLOY_PHASE, 'redeploy'), { ok: true })
  assert.equal(STEPS[store.getItem(id).cursor].label, 'Deploy the changes')
})

test('an unmerged item at Accept the code still sends back to Specialist agent implements', () => {
  const id = makeItem('MG-UNMERGED', ACCEPT)
  assert.deepEqual(store.requestChanges(id, 'Accept the code', ''), { ok: true })
  assert.equal(STEPS[store.getItem(id).cursor].label, 'Specialist agent implements')
})
