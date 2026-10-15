// Orchestrator-level dispatch guard for work-item dependencies (HZ-78,
// success metric: "an item declared dependent on another is not dispatched
// while the blocker is unsatisfied, and starts automatically once it is").
// Same shape as orchestrator-abandon.test.mjs: runs in mock mode (FARM_URL
// unset) so runnable()'s new !isBlocked(...) clause is exercised directly,
// without needing a real farm process.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-orch-dep-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '5'
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, endIndex, EXECUTE_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const insertItem = db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor, repo, issue) VALUES (?, ?, 'Medium', ?, ?, ?)",
)

assert.equal(STEPS[11].kind, 'agent')
const CLOSED = endIndex('change')
const FINAL_GATE = endIndex('change') - 1
assert.equal(STEPS[FINAL_GATE].kind, 'gate')

test('kick() on a blocked item parked at a live agent step does not dispatch', () => {
  insertItem.run('DO-BLOCKER', 'Blocker', 11, null, null)
  insertItem.run('DO-BLOCKED', 'Blocked dependent', 11, null, null)
  store.addDependency('DO-BLOCKED', 'DO-BLOCKER')

  orchestrator.kick('DO-BLOCKED')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'DO-BLOCKED'").get().n, 0)
  assert.equal(store.getItem('DO-BLOCKED').cursor, 11, 'cursor is untouched — no run was dispatched')

  // The blocker itself, with no dependency of its own, dispatches normally —
  // proves the guard is specific to the blocked item, not global breakage.
  orchestrator.kick('DO-BLOCKER')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'DO-BLOCKER'").get().n, 1)
})

test('the boot-time resume sweep skips a blocked item even though it sits mid agent-step (orchestrator.init -> resumeActiveItems)', () => {
  insertItem.run('DO-RESUME-BLOCKER', 'Blocker', 11, null, null)
  insertItem.run('DO-RESUME-BLOCKED', 'Blocked, mid-step at boot', 11, null, null)
  store.addDependency('DO-RESUME-BLOCKED', 'DO-RESUME-BLOCKER')

  orchestrator.init({ info: () => {}, warn: () => {} })
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'DO-RESUME-BLOCKED'").get().n,
    0,
    'resumeActiveItems must not kick a blocked item back into dispatch',
  )
})

test('a blocked item sitting at a gate step is also never runnable (kick no-ops regardless of step kind)', () => {
  insertItem.run('DO-GATE-BLOCKER', 'Blocker', 11, null, null)
  insertItem.run('DO-GATE-BLOCKED', 'Blocked at a gate', 3, null, null)
  assert.equal(STEPS[3].kind, 'gate')
  store.addDependency('DO-GATE-BLOCKED', 'DO-GATE-BLOCKER')
  orchestrator.kick('DO-GATE-BLOCKED') // no-ops for gate steps regardless, but must not throw or dispatch
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'DO-GATE-BLOCKED'").get().n, 0)
})

// End-to-end scenario matching the outcome's HZ-77-depends-on-HZ-76 example,
// as a server-side integration test (UI is out of scope for this item — see
// guardrails). Drives the mock pipeline for real: the dependent never gets a
// step_run row while blocked, and picks up automatically, with no manual
// kick, the moment the blocker's approveGate call closes it.
test('end-to-end: a dependent item is never dispatched while its blocker is open, and starts automatically once the blocker closes', async () => {
  insertItem.run('E2E-76', 'Failure classification (blocker)', FINAL_GATE, null, null)
  insertItem.run('E2E-77', 'Pause banner (dependent)', 11, null, null)
  const addResult = store.addDependency('E2E-77', 'E2E-76')
  assert.equal(addResult.ok, true)
  assert.equal(addResult.blocked, true)
  assert.deepEqual(addResult.blockedBy.map((b) => b.id), ['E2E-76'])

  orchestrator.kick('E2E-77')
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'E2E-77'").get().n,
    0,
    'HZ-77 must not race ahead of HZ-76',
  )
  assert.ok(
    store.listItems().find((it) => it.id === 'E2E-77').blocked,
    'the API payload reads HZ-77 as blocked, naming HZ-76 as the blocker',
  )

  const approval = store.approveGate('E2E-76', FINAL_GATE, '')
  assert.equal(approval.ok, true)
  assert.equal(approval.closed, true)

  // approveGate's wakeDependents call already fired kick('E2E-77')
  // synchronously — the step_run row exists without any manual kick.
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'E2E-77'").get().n,
    1,
    'HZ-77 starts automatically the instant HZ-76 is satisfied',
  )
  assert.equal(store.listItems().find((it) => it.id === 'E2E-77').blocked, false)
})

// ---- HZ-467: a change dependent plans freely; implement waits for the merge ----

const github = await import('../src/github.js')
const { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX, firstStepIndex } = await import('../../domain/js/lifecycle.js')

const runsAt = (id, step) =>
  db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ?').get(id, step).n
const viewOf = (id) => store.listItems().find((it) => it.id === id)
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
async function waitForCursor(id, cursor, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (store.getItem(id).cursor === cursor) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`${id} never reached step ${cursor} (cursor ${store.getItem(id).cursor})`)
}
// A blocker parked at Accept the code with an open PR, not yet merged.
const insertAtAccept = (id, repo, pr) => {
  insertItem.run(id, `${id} blocker`, ACCEPT_GATE_INDEX, repo, null)
  db.prepare('UPDATE work_item SET pr = ? WHERE id = ?').run(pr, id)
}
const REVIEW_GATE = IMPLEMENT_STEP_INDEX - 1
assert.equal(STEPS[REVIEW_GATE].kind, 'gate')

test('planning runs past an unmerged blocker from step 0 to gate 10; implement waits even after gate 10 is approved', async () => {
  insertAtAccept('MR-BLOCKER', 'acme/merge-release', 4671)
  insertItem.run('MR-DEP', 'Plans while its blocker is open', 0, null, null)
  store.addDependency('MR-DEP', 'MR-BLOCKER')
  assert.equal(viewOf('MR-DEP').blocked, false, 'planning is not shown as stuck')

  orchestrator.kick('MR-DEP')
  for (let gate = 0; gate < REVIEW_GATE; gate++) {
    if (STEPS[gate].kind !== 'gate') continue
    await waitForCursor('MR-DEP', gate)
    assert.equal(store.approveGate('MR-DEP', gate, '').ok, true)
  }
  await waitForCursor('MR-DEP', REVIEW_GATE)
  for (let step = 0; step < REVIEW_GATE; step++) {
    if (STEPS[step].kind === 'agent') assert.ok(runsAt('MR-DEP', step) >= 1, `step ${step} (${STEPS[step].label}) ran`)
  }

  assert.equal(store.approveGate('MR-DEP', REVIEW_GATE, '').ok, true)
  await settle()
  assert.equal(store.getItem('MR-DEP').cursor, IMPLEMENT_STEP_INDEX)
  assert.equal(runsAt('MR-DEP', IMPLEMENT_STEP_INDEX), 0, 'implement is never dispatched while the blocker is unmerged')
  const view = viewOf('MR-DEP')
  assert.equal(view.blocked, true)
  assert.deepEqual(view.blockedBy, [{ id: 'MR-BLOCKER', title: 'MR-BLOCKER blocker', abandoned: false, merged: false }])
})

test('a GitHub merge event releases implement on the next dispatch, with no deploy and no close', () => {
  assert.equal(runsAt('MR-DEP', IMPLEMENT_STEP_INDEX), 0)
  assert.equal(github.handlePrStateChange('acme/merge-release', 4671, { merged: true }), true)

  const blocker = store.getItem('MR-BLOCKER')
  assert.ok(blocker.merged_at, 'the merge is recorded')
  assert.ok(blocker.cursor < CLOSED, 'the blocker has not closed')
  assert.equal(runsAt('MR-DEP', IMPLEMENT_STEP_INDEX), 1, 'implement dispatched at the merge')
  assert.equal(viewOf('MR-DEP').blocked, false)
})

test('an approved Accept with no merge does not release implement', () => {
  insertAtAccept('MR-APPROVED-BLOCKER', 'acme/merge-approved', 4672)
  db.prepare("INSERT INTO gate_decision (item_id, step_index, decision, decided_by) VALUES ('MR-APPROVED-BLOCKER', ?, 'approved', 'You')").run(
    ACCEPT_GATE_INDEX,
  )
  insertItem.run('MR-APPROVED-DEP', 'Waits for a real merge', IMPLEMENT_STEP_INDEX, null, null)
  store.addDependency('MR-APPROVED-DEP', 'MR-APPROVED-BLOCKER')
  orchestrator.kick('MR-APPROVED-DEP')
  assert.equal(store.getItem('MR-APPROVED-BLOCKER').merged_at, null)
  assert.equal(runsAt('MR-APPROVED-DEP', IMPLEMENT_STEP_INDEX), 0)
})

test('with two blockers, implement waits until both have merged', () => {
  insertAtAccept('MR-TWO-B1', 'acme/merge-two', 4673)
  insertAtAccept('MR-TWO-B2', 'acme/merge-two', 4674)
  insertItem.run('MR-TWO-DEP', 'Waits for two merges', IMPLEMENT_STEP_INDEX, null, null)
  store.addDependency('MR-TWO-DEP', 'MR-TWO-B1')
  store.addDependency('MR-TWO-DEP', 'MR-TWO-B2')

  store.markMerged('MR-TWO-B1')
  assert.equal(runsAt('MR-TWO-DEP', IMPLEMENT_STEP_INDEX), 0, 'one blocker is still unmerged')
  assert.deepEqual(viewOf('MR-TWO-DEP').blockedBy.map((b) => [b.id, b.merged]), [['MR-TWO-B1', true], ['MR-TWO-B2', false]])

  store.markMerged('MR-TWO-B2')
  assert.equal(runsAt('MR-TWO-DEP', IMPLEMENT_STEP_INDEX), 1)
})

test('an abandoned blocker that had merged still holds implement and escalates', () => {
  insertAtAccept('MR-ABANDON-BLOCKER', 'acme/merge-abandon', 4675)
  insertItem.run('MR-ABANDON-DEP', 'Waits on a blocker that is then abandoned', IMPLEMENT_STEP_INDEX, null, null)
  store.addDependency('MR-ABANDON-DEP', 'MR-ABANDON-BLOCKER')
  db.prepare("UPDATE work_item SET merged_at = datetime('now') WHERE id = 'MR-ABANDON-BLOCKER'").run()
  store.abandonItem('MR-ABANDON-BLOCKER', 'superseded', 'Dana')

  orchestrator.kick('MR-ABANDON-DEP')
  assert.equal(runsAt('MR-ABANDON-DEP', IMPLEMENT_STEP_INDEX), 0)
  const view = viewOf('MR-ABANDON-DEP')
  assert.equal(view.blocked, true)
  assert.equal(view.blockedByAbandoned, true)
  assert.match(view.events[0].text, /MR-ABANDON-BLOCKER .*abandoned/)
})

test('a task dependent stays held on an early agent step while its blocker is open', () => {
  insertAtAccept('MR-TASK-BLOCKER', 'acme/merge-task', 4676)
  const taskKind = STEPS[EXECUTE_STEP_INDEX].itemKind
  const start = firstStepIndex(taskKind)
  assert.equal(STEPS[start].kind, 'agent')
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind) VALUES ('MR-TASK-DEP', 'Task dependent', 'Medium', ?, ?)").run(
    start,
    taskKind,
  )
  store.addDependency('MR-TASK-DEP', 'MR-TASK-BLOCKER')
  orchestrator.kick('MR-TASK-DEP')
  assert.equal(runsAt('MR-TASK-DEP', start), 0)
  assert.equal(viewOf('MR-TASK-DEP').blocked, true)

  // A merge is not enough for a task: it waits for the close, as before.
  store.markMerged('MR-TASK-BLOCKER')
  assert.equal(runsAt('MR-TASK-DEP', start), 0)
  assert.equal(viewOf('MR-TASK-DEP').blocked, true)
})

test('an overlap-added dependency (actor Horizon) lets planning run and holds implement until the merge', () => {
  insertAtAccept('MR-OVERLAP-BLOCKER', 'acme/merge-overlap', 4677)
  const PLAN_STEP = REVIEW_GATE - 1
  assert.equal(STEPS[PLAN_STEP].kind, 'agent')
  insertItem.run('MR-OVERLAP-DEP', 'Linked by the overlap check', PLAN_STEP, null, null)
  assert.equal(store.addDependency('MR-OVERLAP-DEP', 'MR-OVERLAP-BLOCKER', 'Horizon').ok, true)
  assert.equal(db.prepare("SELECT created_by FROM work_item_dependency WHERE item_id = 'MR-OVERLAP-DEP'").get().created_by, 'Horizon')

  orchestrator.kick('MR-OVERLAP-DEP')
  assert.equal(runsAt('MR-OVERLAP-DEP', PLAN_STEP), 1, 'planning runs')

  orchestrator.cancel('MR-OVERLAP-DEP')
  db.prepare("UPDATE work_item SET cursor = ? WHERE id = 'MR-OVERLAP-DEP'").run(IMPLEMENT_STEP_INDEX)
  orchestrator.kick('MR-OVERLAP-DEP')
  assert.equal(runsAt('MR-OVERLAP-DEP', IMPLEMENT_STEP_INDEX), 0, 'implement waits for the merge')

  assert.equal(github.handlePrStateChange('acme/merge-overlap', 4677, { merged: true }), true)
  assert.equal(runsAt('MR-OVERLAP-DEP', IMPLEMENT_STEP_INDEX), 1)
})

test('a GitHub reopen clears merged_at, so a new dependent at implement is held again', () => {
  const projectId = db.prepare("INSERT INTO project (name) VALUES ('merge-reopen')").run().lastInsertRowid
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/merge-reopen', 'MRO')").run(projectId)
  const issue = { number: 5, title: 'Reopened blocker', body: 'do it', labels: [] }
  store.upsertFromGithub({ ...issue, state: 'open' }, 'acme/merge-reopen')
  store.markMerged('MRO-5')
  store.upsertFromGithub({ ...issue, state: 'closed' }, 'acme/merge-reopen')
  assert.ok(store.getItem('MRO-5').merged_at)

  store.upsertFromGithub({ ...issue, state: 'open' }, 'acme/merge-reopen')
  orchestrator.cancel('MRO-5')
  assert.equal(store.getItem('MRO-5').merged_at, null, 'its old merge no longer counts')

  insertItem.run('MRO-DEP', 'Depends on the reopened item', IMPLEMENT_STEP_INDEX, null, null)
  store.addDependency('MRO-DEP', 'MRO-5')
  orchestrator.kick('MRO-DEP')
  assert.equal(runsAt('MRO-DEP', IMPLEMENT_STEP_INDEX), 0)
  assert.equal(viewOf('MRO-DEP').blocked, true)
})
