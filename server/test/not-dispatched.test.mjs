// HZ-802: a Task whose run was approved actually runs Execute — when its
// dependencies clear, when the blocking ask that filed one is abandoned, and
// when the owner retries Execute. An item at an agent step with nothing
// running always says why (notDispatched).
//
// HZ-712 retired the phase restart route (and store.restartPhase with it); the
// owner's retry is POST /api/items/:id/move { action: 'retry' }. The restart's
// own refusals (blocked_by, held_by_ask, needs_reapproval answered as 409)
// went with it, so those cases are gone; notDispatched still names each one.
//
// Mock mode (FARM_URL unset), like ask-start-check.test.mjs: a dispatch is a
// step_run row. Routes go through the real app with the owner's PIN.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

globalThis.fetch = async () => {
  throw new Error('not-dispatched test: no network')
}

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-not-dispatched-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '600000'
for (const key of ['FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const orchestrator = await import('../src/orchestrator.js')
const drain = await import('../src/deployDrain.js')
const { buildApp } = await import('../src/app.js')
const { STEPS, endIndex, requiredStepIndex, stepKeyAt, APPROVE_RUN_GATE_INDEX, RUN_PLAN_STEP_INDEX, EXECUTE_STEP_INDEX } = await import(
  '../../domain/js/lifecycle.js'
)

store.purgeDemoItems()
// What orchestrator.init() registers, so a merge's wakeDependents kicks.
store.registerAgentRunner({ kick: orchestrator.kick, cancel: orchestrator.cancel, waitReason: orchestrator.waitReason })
const app = buildApp({ logger: false })
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Owner Example' })
await app.ready()
after(async () => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
  await app.close()
})

const ownerHeaders = { cookie: owner.cookie, 'x-human-key': owner.pin }
const ARCH = requiredStepIndex('Architecture review')
const REPO = 'Acme/not-dispatched'
const project = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Not dispatched', 1)").run().lastInsertRowid)
db.prepare("INSERT INTO project_repo (repo, prefix, project_id) VALUES (?, 'ND', ?)").run(REPO, project)
const TASK_KIND = 'task'
const FINAL_GATE = endIndex('change') - 1

const PLAN =
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands: ['scripts/a.sh'], budget_minutes: 20 }, null, 2) +
  '\n```'
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

// A Task at Execute whose run plan was approved at Approve the run, with no
// run yet — where MDI-115 sat.
function seedApprovedTask(id) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, approved_plan_hash, approved_runner) VALUES (?, ?, 'High', ?, ?, ?, ?, ?)",
  ).run(id, `Task ${id}`, EXECUTE_STEP_INDEX, TASK_KIND, project, sha256(PLAN), store.defaultRunnerFor(null))
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, 'Eng', 'done', 'ok', ?, datetime('now'))").run(
    id,
    RUN_PLAN_STEP_INDEX,
    PLAN,
  )
  assert.equal(store.approvedPlanCheck(id).ok, true)
}
const seedChange = (id, cursor) =>
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, ?, 'High', ?, ?)").run(id, `Change ${id}`, cursor, project)

// A blocking ask on `itemId` already filed as `filedId`, with its edge.
function seedFiledAsk(itemId, filedId, { title = 'Add FX feed' } = {}) {
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact) VALUES (?, ?, 1, 'Architect', 'done', 'x', 'x')")
    .run(itemId, ARCH).lastInsertRowid
  const askId = Number(
    db
      .prepare(
        "INSERT INTO ask (item_id, step_run_id, step_index, kind, status, draft_json, why, filed_item_id) VALUES (?, ?, ?, 'blocking', 'filed', ?, 'needed first', ?)",
      )
      .run(itemId, runId, ARCH, JSON.stringify({ title, repo: REPO }), filedId).lastInsertRowid,
  )
  assert.equal(store.addDependency(itemId, filedId).ok, true)
  return askId
}

const runsAt = (id, step) => db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ?').get(id, step).n
const activeRunsAt = (id, step) =>
  db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, step).n
const eventTexts = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
const listed = (id) => store.notDispatchedItems().find((n) => n.itemId === id)
const retry = (id) =>
  app.inject({
    method: 'POST',
    url: `/api/items/${id}/move`,
    headers: ownerHeaders,
    payload: { action: 'retry', from: stepKeyAt(EXECUTE_STEP_INDEX) },
  })
const release = (id, askId, { reason = 'MDI-122 was abandoned; proceed without it', headers = ownerHeaders } = {}) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/asks/${askId}/release`, headers, payload: { reason } })

// ---- metric 1 ----

test('metric 1: an approved Task given a dependency starts Execute when the dependency merges and closes, with no extra tick', () => {
  seedApprovedTask('ND-M1')
  seedChange('ND-M1-DEP', FINAL_GATE)
  assert.equal(store.addDependency('ND-M1', 'ND-M1-DEP').ok, true)
  orchestrator.kick('ND-M1')
  assert.equal(runsAt('ND-M1', EXECUTE_STEP_INDEX), 0, 'held while the dependency is open')
  assert.equal(store.itemViewById('ND-M1').notDispatched.kind, 'blocked_by')

  store.markMerged('ND-M1-DEP')
  assert.equal(store.approveGate('ND-M1-DEP', FINAL_GATE, '').closed, true)
  assert.equal(runsAt('ND-M1', EXECUTE_STEP_INDEX), 1, 'Execute starts on the close itself')
  assert.equal(Object.hasOwn(store.itemViewById('ND-M1'), 'notDispatched'), false)
})

test('metric 1: a plain dependency that is abandoned and removed lets Execute start, once', () => {
  seedApprovedTask('ND-M1-PLAIN')
  seedChange('ND-M1-PLAIN-DEP', 3)
  assert.equal(store.addDependency('ND-M1-PLAIN', 'ND-M1-PLAIN-DEP').ok, true)
  orchestrator.kick('ND-M1-PLAIN')
  assert.equal(runsAt('ND-M1-PLAIN', EXECUTE_STEP_INDEX), 0)

  const result = store.abandonItem('ND-M1-PLAIN-DEP', 'superseded', 'Owner', { removeDependentLinks: true })
  assert.deepEqual(result.removedLinks, ['ND-M1-PLAIN'])
  assert.equal(runsAt('ND-M1-PLAIN', EXECUTE_STEP_INDEX), 1)
})

test('metric 1: the item a blocking ask filed is abandoned and removed — the ask stops holding and Execute starts, once', () => {
  seedApprovedTask('ND-M1-ASK')
  seedChange('ND-M1-ASK-DEP', 3)
  seedFiledAsk('ND-M1-ASK', 'ND-M1-ASK-DEP')
  orchestrator.kick('ND-M1-ASK')
  assert.equal(runsAt('ND-M1-ASK', EXECUTE_STEP_INDEX), 0)

  store.abandonItem('ND-M1-ASK-DEP', 'not needed', 'Owner', { removeDependentLinks: true })
  assert.equal(runsAt('ND-M1-ASK', EXECUTE_STEP_INDEX), 1, 'MDI-115: the abandoned ask item holds nothing')
  assert.ok(eventTexts('ND-M1-ASK').includes('ask hold released: ND-M1-ASK-DEP was abandoned'))
  // A second clear is harmless: still one run.
  orchestrator.kick('ND-M1-ASK')
  assert.equal(runsAt('ND-M1-ASK', EXECUTE_STEP_INDEX), 1)
})

test('guardrail 2: the abandoned ask item still blocks while its dependency edge remains', () => {
  seedApprovedTask('ND-EDGE')
  seedChange('ND-EDGE-DEP', 3)
  seedFiledAsk('ND-EDGE', 'ND-EDGE-DEP')
  store.abandonItem('ND-EDGE-DEP', 'not needed', 'Owner')
  orchestrator.kick('ND-EDGE')
  assert.equal(runsAt('ND-EDGE', EXECUTE_STEP_INDEX), 0)
  const reason = store.itemViewById('ND-EDGE').notDispatched
  assert.equal(reason.kind, 'blocked_by')
  assert.equal(reason.itemId, 'ND-EDGE-DEP')
  assert.match(reason.message, /ND-EDGE-DEP .*abandoned/)
})

test('guardrail 2: repeated dependency clears create one step_run', () => {
  seedApprovedTask('ND-TWICE')
  seedChange('ND-TWICE-DEP', FINAL_GATE)
  store.addDependency('ND-TWICE', 'ND-TWICE-DEP')
  store.markMerged('ND-TWICE-DEP')
  store.approveGate('ND-TWICE-DEP', FINAL_GATE, '')
  orchestrator.kick('ND-TWICE')
  orchestrator.kick('ND-TWICE')
  assert.equal(runsAt('ND-TWICE', EXECUTE_STEP_INDEX), 1)
})

// ---- metric 2 ----

test('metric 2: replaying MDI-115, a retry of Execute creates exactly one step_run', async () => {
  seedApprovedTask('ND-MDI115')
  seedChange('ND-MDI122', 3)
  seedFiledAsk('ND-MDI115', 'ND-MDI122')
  store.abandonItem('ND-MDI122', 'abandoned', 'Owner', { removeDependentLinks: true })
  // The state MDI-115 was found in: the cursor at Execute, approved, no run.
  orchestrator.cancel('ND-MDI115')
  db.prepare("DELETE FROM step_run WHERE item_id = 'ND-MDI115' AND step_index = ?").run(EXECUTE_STEP_INDEX)

  const res = await retry('ND-MDI115')
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(runsAt('ND-MDI115', EXECUTE_STEP_INDEX), 1)
  assert.equal(activeRunsAt('ND-MDI115', EXECUTE_STEP_INDEX), 1)
})

test('guardrail 2: two retries leave one active run, the first superseded', async () => {
  seedApprovedTask('ND-PRESS')
  assert.equal((await retry('ND-PRESS')).statusCode, 200)
  assert.equal((await retry('ND-PRESS')).statusCode, 200)
  assert.equal(activeRunsAt('ND-PRESS', EXECUTE_STEP_INDEX), 1)
  const statuses = db.prepare('SELECT status FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id').all('ND-PRESS', EXECUTE_STEP_INDEX)
  assert.deepEqual(statuses.map((r) => r.status), ['superseded', 'active'])
})

// ---- metric 3 ----

test('metric 3: an idle item at an agent step names why, on the page and in Farm health; an active one is not reported', () => {
  // blocked_by
  seedApprovedTask('ND-WHY-BLOCKED')
  seedChange('ND-WHY-BLOCKER', 3)
  store.addDependency('ND-WHY-BLOCKED', 'ND-WHY-BLOCKER')
  // held_by_ask
  seedApprovedTask('ND-WHY-ASK')
  seedChange('ND-WHY-ASK-DEP', 3)
  seedFiledAsk('ND-WHY-ASK', 'ND-WHY-ASK-DEP')
  store.removeDependency('ND-WHY-ASK', 'ND-WHY-ASK-DEP', 'Owner')
  // needs_reapproval
  seedApprovedTask('ND-WHY-STALE')
  db.prepare("UPDATE work_item SET approved_plan_hash = 'stale' WHERE id = 'ND-WHY-STALE'").run()
  // waiting_for_slot: nothing holds it, it just has not been dispatched yet.
  seedApprovedTask('ND-WHY-SLOT')
  // An active run: not reported.
  seedApprovedTask('ND-WHY-RUNNING')
  orchestrator.kick('ND-WHY-RUNNING')

  const cases = [
    ['ND-WHY-BLOCKED', 'blocked_by', /ND-WHY-BLOCKER/],
    ['ND-WHY-ASK', 'held_by_ask', /^Held by ask: Add FX feed → ND-WHY-ASK-DEP, open$/],
    ['ND-WHY-STALE', 'needs_reapproval', /re-approval/],
    ['ND-WHY-SLOT', 'waiting_for_slot', /slot/],
  ]
  for (const [id, kind, message] of cases) {
    const view = store.itemViewById(id).notDispatched
    assert.equal(view.kind, kind, id)
    assert.match(view.message, message, id)
    const row = listed(id)
    assert.ok(row, `${id} is listed for Farm health`)
    assert.equal(row.kind, kind)
    assert.equal(row.message, view.message)
    assert.equal(row.step, STEPS[EXECUTE_STEP_INDEX].label)
  }
  assert.equal(Object.hasOwn(store.itemViewById('ND-WHY-RUNNING'), 'notDispatched'), false)
  assert.equal(listed('ND-WHY-RUNNING'), undefined)
})

test('metric 3: an item at a gate, or abandoned, is not reported', () => {
  seedChange('ND-AT-GATE', 3)
  seedChange('ND-GONE', 11)
  store.abandonItem('ND-GONE', 'not needed', 'Owner')
  assert.equal(Object.hasOwn(store.itemViewById('ND-AT-GATE'), 'notDispatched'), false)
  assert.equal(listed('ND-AT-GATE'), undefined)
  assert.equal(listed('ND-GONE'), undefined)
})

// ---- metric 4 ----

test('metric 4: the last dependency clears on an unapproved gate — no step_run in any state, not paused', () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id) VALUES ('ND-GATE', 'Task at its gate', 'High', ?, ?, ?)").run(
    APPROVE_RUN_GATE_INDEX,
    TASK_KIND,
    project,
  )
  seedChange('ND-GATE-DEP', FINAL_GATE)
  store.addDependency('ND-GATE', 'ND-GATE-DEP')
  store.markMerged('ND-GATE-DEP')
  store.approveGate('ND-GATE-DEP', FINAL_GATE, '')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = 'ND-GATE'").get().n, 0)
  assert.equal(store.getItem('ND-GATE').paused, false)
  assert.equal(store.getItem('ND-GATE').cursor, APPROVE_RUN_GATE_INDEX)
})

test('metric 4: the last dependency clears with the plan approval invalidated — no step_run in any state, not paused', () => {
  seedApprovedTask('ND-STALE')
  // The Run plan re-ran since the approval: a new artifact, a new hash.
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES ('ND-STALE', ?, 2, 'Eng', 'done', 'ok', ?, datetime('now'))").run(
    RUN_PLAN_STEP_INDEX,
    PLAN.replace('scripts/a.sh', 'scripts/edited.sh'),
  )
  seedChange('ND-STALE-DEP', FINAL_GATE)
  store.addDependency('ND-STALE', 'ND-STALE-DEP')
  store.markMerged('ND-STALE-DEP')
  store.approveGate('ND-STALE-DEP', FINAL_GATE, '')
  assert.equal(runsAt('ND-STALE', EXECUTE_STEP_INDEX), 0)
  assert.equal(store.getItem('ND-STALE').paused, false)
  assert.equal(store.itemViewById('ND-STALE').notDispatched.kind, 'needs_reapproval')
})

// ---- guardrails 1 and 3 ----

test('guardrail 1: a paused item is not dispatched when its dependency clears', () => {
  seedApprovedTask('ND-PAUSED')
  db.prepare("UPDATE work_item SET paused = 1 WHERE id = 'ND-PAUSED'").run()
  seedChange('ND-PAUSED-DEP', FINAL_GATE)
  store.addDependency('ND-PAUSED', 'ND-PAUSED-DEP')
  store.markMerged('ND-PAUSED-DEP')
  store.approveGate('ND-PAUSED-DEP', FINAL_GATE, '')
  assert.equal(runsAt('ND-PAUSED', EXECUTE_STEP_INDEX), 0)
  assert.equal(store.itemViewById('ND-PAUSED').notDispatched.kind, 'paused')
})

test('guardrail 3: a clear during a self-deploy drain goes through the dispatcher — no run until it ends, then exactly one', () => {
  seedApprovedTask('ND-DRAIN')
  seedChange('ND-DRAIN-DEP', FINAL_GATE)
  store.addDependency('ND-DRAIN', 'ND-DRAIN-DEP')
  drain.beginDrain({ ttlS: 60 })
  try {
    store.markMerged('ND-DRAIN-DEP')
    store.approveGate('ND-DRAIN-DEP', FINAL_GATE, '')
    assert.equal(runsAt('ND-DRAIN', EXECUTE_STEP_INDEX), 0)
    assert.equal(store.itemViewById('ND-DRAIN').notDispatched.kind, 'deploy_drain')
  } finally {
    drain.endDrain()
  }
  orchestrator.kick('ND-DRAIN')
  orchestrator.kick('ND-DRAIN')
  assert.equal(runsAt('ND-DRAIN', EXECUTE_STEP_INDEX), 1)
})

// ---- the PIN release ----

test('Release: no PIN 401, empty reason 400, an open ask 409, a filed ask releases the hold and Execute starts once', async () => {
  seedApprovedTask('ND-REL')
  seedChange('ND-REL-DEP', 3)
  const askId = seedFiledAsk('ND-REL', 'ND-REL-DEP')
  store.removeDependency('ND-REL', 'ND-REL-DEP', 'Owner')
  orchestrator.kick('ND-REL')
  assert.equal(runsAt('ND-REL', EXECUTE_STEP_INDEX), 0)

  assert.equal((await release('ND-REL', askId, { headers: { cookie: owner.cookie } })).statusCode, 401)
  assert.equal((await release('ND-REL', askId, { headers: { cookie: owner.cookie, 'x-human-key': 'wrong-pin' } })).statusCode, 401)
  const empty = await release('ND-REL', askId, { reason: '   ' })
  assert.equal(empty.statusCode, 400)
  assert.equal(empty.json().error, 'reason_required')
  assert.equal((await release('ND-REL', 9999)).statusCode, 404)

  const runId = db.prepare("SELECT id FROM step_run WHERE item_id = 'ND-REL' AND step_index = ?").get(ARCH).id
  const openAskId = Number(
    db
      .prepare("INSERT INTO ask (item_id, step_run_id, step_index, kind, status, draft_json, why) VALUES ('ND-REL', ?, ?, 'soft', 'open', ?, 'later')")
      .run(runId, ARCH, JSON.stringify({ title: 'Soft one', repo: REPO })).lastInsertRowid,
  )
  const open = await release('ND-REL', openAskId)
  assert.equal(open.statusCode, 409)
  assert.equal(open.json().error, 'ask_not_filed')
  assert.equal(runsAt('ND-REL', EXECUTE_STEP_INDEX), 0)

  const ok = await release('ND-REL', askId)
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json().filedItemId, 'ND-REL-DEP')
  assert.equal(runsAt('ND-REL', EXECUTE_STEP_INDEX), 1, 'Execute starts on the release')
  assert.ok(eventTexts('ND-REL').some((t) => t.startsWith('released the ask “Add FX feed” (ND-REL-DEP): MDI-122 was abandoned')))
  assert.equal(Object.hasOwn(store.itemViewById('ND-REL'), 'startHold'), false)

  const again = await release('ND-REL', askId)
  assert.equal(again.statusCode, 200)
  assert.equal(again.json().alreadyReleased, true)
  assert.equal(runsAt('ND-REL', EXECUTE_STEP_INDEX), 1, 'a second Release starts nothing new')
})

test('Release leaves the dependency edge: an item still blocked by it stays not dispatched', async () => {
  seedApprovedTask('ND-REL-EDGE')
  seedChange('ND-REL-EDGE-DEP', 3)
  const askId = seedFiledAsk('ND-REL-EDGE', 'ND-REL-EDGE-DEP')
  assert.equal((await release('ND-REL-EDGE', askId)).statusCode, 200)
  assert.equal(runsAt('ND-REL-EDGE', EXECUTE_STEP_INDEX), 0)
  assert.equal(store.itemViewById('ND-REL-EDGE').notDispatched.kind, 'blocked_by')
})
