// Store-level tests for work-item dependencies (HZ-78). Enforcement of
// "don't dispatch" lives in orchestrator.js's runnable() — see
// dependency-orchestrator.test.mjs — this file covers the write-time graph
// rules (cycle rejection, self-dependency, abandoned-blocker handling) and
// the read-side API payload (blocked / blockedBy / blockedByAbandoned).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-dep-store-')), 'test.db')

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS } = await import('../src/lifecycle.js')

const insertItem = db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor, repo, issue) VALUES (?, ?, 'Medium', ?, ?, ?)",
)

assert.equal(STEPS[11].kind, 'agent')
assert.equal(STEPS[3].kind, 'gate')
const CLOSED = STEPS.length

function itemView(id) {
  return store.listItems().find((it) => it.id === id)
}

function spyRunner() {
  const kicked = []
  store.registerAgentRunner({ kick: (id) => kicked.push(id), cancel: () => {} })
  return kicked
}

test.after(() => store.registerAgentRunner({ kick: () => {}, cancel: () => {} }))

test('addDependency on an unknown item is not_found', () => {
  insertItem.run('D-BLOCKER-1', 'Blocker', 11, null, null)
  assert.deepEqual(store.addDependency('NOPE', 'D-BLOCKER-1'), { error: 'not_found' })
})

test('addDependency on an unknown blocker is blocker_not_found', () => {
  insertItem.run('D-DEP-1', 'Dependent', 11, null, null)
  assert.deepEqual(store.addDependency('D-DEP-1', 'NOPE'), { error: 'blocker_not_found' })
})

test('addDependency rejects self-dependency', () => {
  insertItem.run('D-SELF', 'Self', 11, null, null)
  const result = store.addDependency('D-SELF', 'D-SELF')
  assert.equal(result.error, 'self_dependency')
})

test('addDependency rejects a direct two-node cycle with a clear error', () => {
  insertItem.run('D-CYCLE-A', 'A', 11, null, null)
  insertItem.run('D-CYCLE-B', 'B', 11, null, null)
  assert.deepEqual(store.addDependency('D-CYCLE-A', 'D-CYCLE-B'), { ok: true, blocked: true, blockedByAbandoned: false, blockedBy: [{ id: 'D-CYCLE-B', title: 'B', abandoned: false }], dependents: [] })
  const result = store.addDependency('D-CYCLE-B', 'D-CYCLE-A')
  assert.equal(result.error, 'cycle')
  assert.match(result.message, /D-CYCLE-A/)
})

test('addDependency rejects a longer transitive cycle (A -> B -> C, then C -> A)', () => {
  insertItem.run('D-CHAIN-A', 'A', 11, null, null)
  insertItem.run('D-CHAIN-B', 'B', 11, null, null)
  insertItem.run('D-CHAIN-C', 'C', 11, null, null)
  assert.equal(store.addDependency('D-CHAIN-A', 'D-CHAIN-B').ok, true)
  assert.equal(store.addDependency('D-CHAIN-B', 'D-CHAIN-C').ok, true)
  const result = store.addDependency('D-CHAIN-C', 'D-CHAIN-A')
  assert.equal(result.error, 'cycle')
})

test('addDependency on an already-closed blocker leaves the dependent unblocked immediately, no wake needed', () => {
  insertItem.run('D-CLOSED-BLOCKER', 'Already done', CLOSED, null, null)
  insertItem.run('D-DEP-ON-CLOSED', 'Dependent', 11, null, null)
  const result = store.addDependency('D-DEP-ON-CLOSED', 'D-CLOSED-BLOCKER')
  assert.deepEqual(result, { ok: true, blocked: false, blockedByAbandoned: false, blockedBy: [], dependents: [] })
  assert.equal(itemView('D-DEP-ON-CLOSED').blocked, false)
})

test('addDependency on an already-abandoned blocker is rejected (fail closed, same policy as cycles)', () => {
  insertItem.run('D-ABANDONED-BLOCKER', 'Will be abandoned', 11, null, null)
  insertItem.run('D-DEP-ON-ABANDONED', 'Dependent', 11, null, null)
  assert.deepEqual(store.abandonItem('D-ABANDONED-BLOCKER', 'no longer needed'), { ok: true })
  const result = store.addDependency('D-DEP-ON-ABANDONED', 'D-ABANDONED-BLOCKER')
  assert.equal(result.error, 'blocker_abandoned')
})

test('a multi-blocker item stays blocked while either blocker is open, and only unblocks once both close', () => {
  insertItem.run('D-MULTI-DEP', 'Depends on two', 11, null, null)
  insertItem.run('D-MULTI-B1', 'Blocker one', 11, null, null)
  insertItem.run('D-MULTI-B2', 'Blocker two', 11, null, null)
  store.addDependency('D-MULTI-DEP', 'D-MULTI-B1')
  store.addDependency('D-MULTI-DEP', 'D-MULTI-B2')
  assert.equal(itemView('D-MULTI-DEP').blocked, true)
  assert.equal(itemView('D-MULTI-DEP').blockedBy.length, 2)

  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(CLOSED, 'D-MULTI-B1')
  assert.equal(itemView('D-MULTI-DEP').blocked, true, 'still blocked — the second blocker is still open')
  assert.equal(itemView('D-MULTI-DEP').blockedBy.length, 1)

  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(CLOSED, 'D-MULTI-B2')
  assert.equal(itemView('D-MULTI-DEP').blocked, false, 'both blockers closed — no longer blocked')
  assert.deepEqual(itemView('D-MULTI-DEP').blockedBy, [])
})

test('removeDependency clears the edge, is visible in the API payload, and re-kicks the dependent', () => {
  insertItem.run('D-REMOVE-DEP', 'Dependent', 11, null, null)
  insertItem.run('D-REMOVE-BLOCKER', 'Blocker', 11, null, null)
  store.addDependency('D-REMOVE-DEP', 'D-REMOVE-BLOCKER')
  assert.equal(itemView('D-REMOVE-DEP').blocked, true)

  const kicked = spyRunner()
  const result = store.removeDependency('D-REMOVE-DEP', 'D-REMOVE-BLOCKER')
  assert.deepEqual(result, { ok: true, blocked: false, blockedByAbandoned: false, blockedBy: [], dependents: [] })
  assert.ok(kicked.includes('D-REMOVE-DEP'), 'removing the last blocker must re-kick the dependent, not wait for an unrelated dispatch')
})

test('removeDependency on a dependency that was never declared is not_found', () => {
  insertItem.run('D-REMOVE-NONE', 'No deps', 11, null, null)
  assert.deepEqual(store.removeDependency('D-REMOVE-NONE', 'NOPE'), { error: 'not_found' })
})

test('wakeDependents wiring: approveGate closing the item wakes its dependents', () => {
  insertItem.run('D-WAKE-APPROVE-BLOCKER', 'Blocker', 15, null, null) // final gate
  insertItem.run('D-WAKE-APPROVE-DEP', 'Dependent', 11, null, null)
  assert.equal(STEPS[15].kind, 'gate')
  assert.equal(STEPS.length, 16)
  store.addDependency('D-WAKE-APPROVE-DEP', 'D-WAKE-APPROVE-BLOCKER')
  assert.equal(itemView('D-WAKE-APPROVE-DEP').blocked, true)

  const kicked = spyRunner()
  store.approveGate('D-WAKE-APPROVE-BLOCKER', 15, '')
  assert.equal(store.getItem('D-WAKE-APPROVE-BLOCKER').cursor, CLOSED)
  assert.ok(kicked.includes('D-WAKE-APPROVE-DEP'), 'closing the blocker via approveGate must wake the dependent')
  assert.equal(itemView('D-WAKE-APPROVE-DEP').blocked, false)
})

// approveGateFromGithub only ever advances cursor from ACCEPT_GATE_INDEX
// (13) to the Deploy step (14) — Deploy and the final "Review the work &
// close" gate (15) still follow it in this pipeline, so it can never
// actually close an item today. It is still wired the same way as
// approveGate and the upsertFromGithub close-sync branch (see
// store.js:approveGateFromGithub), matching the other two isClosed
// transition points for whenever the pipeline shortens. This test pins the
// reachable half of that: merging the PR must NOT wake dependents when it
// only advances the item without closing it — proving the wake call is
// correctly conditioned on isClosed, not unconditional on every approval.
test('approveGateFromGithub does not wake dependents when the merge only advances the item, not closes it', () => {
  insertItem.run('D-WAKE-GH-BLOCKER', 'Blocker via PR merge', STEPS.findIndex((s) => s.label === 'Accept the code'), 'acme/repo', 900)
  insertItem.run('D-WAKE-GH-DEP', 'Dependent', 11, null, null)
  db.prepare("UPDATE work_item SET pr = 42 WHERE id = 'D-WAKE-GH-BLOCKER'").run()
  store.addDependency('D-WAKE-GH-DEP', 'D-WAKE-GH-BLOCKER')

  const kicked = spyRunner()
  store.approveGateFromGithub('D-WAKE-GH-BLOCKER')
  assert.notEqual(store.getItem('D-WAKE-GH-BLOCKER').cursor, CLOSED, 'sanity: Deploy + the final gate still follow Accept-the-code')
  assert.ok(!kicked.includes('D-WAKE-GH-DEP'), 'still blocked — the blocker has not actually closed yet')
  assert.equal(itemView('D-WAKE-GH-DEP').blocked, true)
})

test('wakeDependents wiring: upsertFromGithub closing the issue wakes dependents', () => {
  const projectId = db.prepare("INSERT INTO project (name) VALUES ('dep-gh-sync')").run().lastInsertRowid
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'acme/dep-sync', 'DS')").run(projectId)
  store.upsertFromGithub({ number: 77, title: 'GH blocker', body: 'do it', state: 'open', labels: [] }, 'acme/dep-sync')
  insertItem.run('D-WAKE-SYNC-DEP', 'Dependent', 11, null, null)
  store.addDependency('D-WAKE-SYNC-DEP', 'DS-77')
  assert.equal(itemView('D-WAKE-SYNC-DEP').blocked, true)

  const kicked = spyRunner()
  store.upsertFromGithub({ number: 77, title: 'GH blocker', body: 'do it', state: 'closed', labels: [] }, 'acme/dep-sync')
  assert.equal(store.getItem('DS-77').cursor, CLOSED)
  assert.ok(kicked.includes('D-WAKE-SYNC-DEP'), 'closing the underlying GitHub issue must wake dependents too, not only human gate approval')
})

test('an abandoned blocker escalates: the dependent gets an event, stays blocked (blockedByAbandoned), and is NOT paused', () => {
  insertItem.run('D-ESCALATE-BLOCKER', 'Will be abandoned', 11, null, null)
  insertItem.run('D-ESCALATE-DEP', 'Dependent', 11, null, null)
  store.addDependency('D-ESCALATE-DEP', 'D-ESCALATE-BLOCKER')

  store.abandonItem('D-ESCALATE-BLOCKER', 'no longer needed', 'Dana')

  const dep = itemView('D-ESCALATE-DEP')
  assert.equal(dep.blocked, true, 'never silently unblocked onto a dead dependency')
  assert.equal(dep.blockedByAbandoned, true)
  assert.equal(dep.paused, false, 'must not be modeled as paused — that is a human action with a Resume button, not this')
  const lastEvent = dep.events[0]
  assert.match(lastEvent.text, /D-ESCALATE-BLOCKER/)
  assert.match(lastEvent.text, /abandoned/)
})

test('the human remedy for an abandoned blocker is removeDependency, which clears blocked and re-kicks', () => {
  insertItem.run('D-RESOLVE-BLOCKER', 'Will be abandoned', 11, null, null)
  insertItem.run('D-RESOLVE-DEP', 'Dependent', 11, null, null)
  store.addDependency('D-RESOLVE-DEP', 'D-RESOLVE-BLOCKER')
  store.abandonItem('D-RESOLVE-BLOCKER', 'no longer needed')
  assert.equal(itemView('D-RESOLVE-DEP').blocked, true)

  const kicked = spyRunner()
  store.removeDependency('D-RESOLVE-DEP', 'D-RESOLVE-BLOCKER')
  assert.equal(itemView('D-RESOLVE-DEP').blocked, false)
  assert.ok(kicked.includes('D-RESOLVE-DEP'))
})

test('paused and blocked are independent — neither implies the other', () => {
  insertItem.run('D-INDEP-PAUSED', 'Paused, no deps', 11, null, null)
  store.setPaused('D-INDEP-PAUSED', true)
  const pausedOnly = itemView('D-INDEP-PAUSED')
  assert.equal(pausedOnly.paused, true)
  assert.equal(pausedOnly.blocked, false)

  insertItem.run('D-INDEP-BLOCKED-DEP', 'Blocked, not paused', 11, null, null)
  insertItem.run('D-INDEP-BLOCKED-BLOCKER', 'Blocker', 11, null, null)
  store.addDependency('D-INDEP-BLOCKED-DEP', 'D-INDEP-BLOCKED-BLOCKER')
  const blockedOnly = itemView('D-INDEP-BLOCKED-DEP')
  assert.equal(blockedOnly.blocked, true)
  assert.equal(blockedOnly.paused, false)
})

test('API payload shape: blocked/blockedBy/blockedByAbandoned are present for both agent-step and gate-step dependents', () => {
  insertItem.run('D-SHAPE-BLOCKER', 'Blocker', 11, null, null)
  insertItem.run('D-SHAPE-AGENT-DEP', 'Agent-step dependent', 11, null, null)
  insertItem.run('D-SHAPE-GATE-DEP', 'Gate-step dependent', 3, null, null)
  store.addDependency('D-SHAPE-AGENT-DEP', 'D-SHAPE-BLOCKER')
  store.addDependency('D-SHAPE-GATE-DEP', 'D-SHAPE-BLOCKER')

  for (const id of ['D-SHAPE-AGENT-DEP', 'D-SHAPE-GATE-DEP']) {
    const item = itemView(id)
    assert.equal(item.blocked, true)
    assert.equal(item.blockedByAbandoned, false)
    assert.deepEqual(item.blockedBy, [{ id: 'D-SHAPE-BLOCKER', title: 'Blocker', abandoned: false }])
  }
})

// HZ-95: `dependents` is the mirror-image read of `blockedBy` — the same
// edge reported from the blocker's side. One fixture proves both directions
// from a single dependency so they cannot drift apart.
test('one dependency edge (A depends on B) is reported as a dependent on B and a blocker on A', () => {
  insertItem.run('D-MIRROR-A', 'A depends on B', 11, null, null)
  insertItem.run('D-MIRROR-B', 'B blocks A', 11, null, null)
  store.addDependency('D-MIRROR-A', 'D-MIRROR-B')

  const a = itemView('D-MIRROR-A')
  const b = itemView('D-MIRROR-B')
  assert.deepEqual(a.blockedBy, [{ id: 'D-MIRROR-B', title: 'B blocks A', abandoned: false }])
  assert.deepEqual(b.dependents, [{ id: 'D-MIRROR-A', title: 'A depends on B', abandoned: false }])
})

test('a closed dependent is filtered out of dependents, same rule as a closed blocker', () => {
  insertItem.run('D-DEPCLOSED-BLOCKER', 'Blocker', 11, null, null)
  insertItem.run('D-DEPCLOSED-DEP', 'Will close', 11, null, null)
  store.addDependency('D-DEPCLOSED-DEP', 'D-DEPCLOSED-BLOCKER')
  assert.deepEqual(itemView('D-DEPCLOSED-BLOCKER').dependents, [{ id: 'D-DEPCLOSED-DEP', title: 'Will close', abandoned: false }])

  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(CLOSED, 'D-DEPCLOSED-DEP')
  assert.deepEqual(itemView('D-DEPCLOSED-BLOCKER').dependents, [])
})

test('an abandoned dependent is flagged abandoned in dependents, not dropped', () => {
  insertItem.run('D-DEPABANDON-BLOCKER', 'Blocker', 11, null, null)
  insertItem.run('D-DEPABANDON-DEP', 'Will be abandoned', 11, null, null)
  store.addDependency('D-DEPABANDON-DEP', 'D-DEPABANDON-BLOCKER')

  store.abandonItem('D-DEPABANDON-DEP', 'no longer needed')
  assert.deepEqual(itemView('D-DEPABANDON-BLOCKER').dependents, [{ id: 'D-DEPABANDON-DEP', title: 'Will be abandoned', abandoned: true }])
})
