// HZ-920: Move to… → Close. A human moves an item straight on to its kind's
// final gate (a `skip` move, moveItem.js): no agent step runs for the steps
// it skips, any pause ends, the actor and note go in the item's events, and
// the gate still waits for the normal close approval — Close never approves
// it. It goes through the existing POST /api/items/:id/move, with the same
// session + gate PIN as every other move.
//
// The orchestrator is the real one; the farm and GitHub are a fetch stub that
// records every /steps/run, so "no agent step ran" is checked at the seam.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser, loginFixtureToken } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-move-to-close-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['FARM_HOME', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'FARM_STEP_INDEXES', 'WA_NOTIFY_ENABLED', 'WA_POLL_ENABLED']) {
  delete process.env[key]
}

const farmRuns = []
const ok = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) })
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.endsWith('/steps/run')) farmRuns.push(JSON.parse(opts.body))
  if (u.startsWith('https://api.github.com/')) return { ok: false, status: 500, headers: new Headers(), json: async () => ({}) }
  return ok({ ok: true })
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { CLOSE_TARGET_LABEL, ROUTE_MOVE_ACTIONS, moveTargets, movesView, planMove } = await import('../src/moveItem.js')
const { ITEM_KINDS, LANES, endIndex, isClosed, stepIndexOf, stepKeyAt, stepsFor } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
const app = buildApp({ logger: false })
await app.ready()
const { user, pin, cookie } = loginFixtureUser(auth, config)
const tokenOnly = loginFixtureToken(auth, user).headers

after(async () => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
  await app.close()
})

const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Close project', 1)").run().lastInsertRowid)
const autopilotProjectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Close autopilot project', 1)").run().lastInsertRowid)
db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(autopilotProjectId)

const FINAL_GATE = { change: 'change.review-close', task: 'task.review-close', plan: 'plan.review-close' }

const at = (key) => stepIndexOf(key)
function seed(id, kind, key, { paused = 0, project = projectId } = {}) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind, project_id, paused) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    `Item ${id}`,
    'Medium',
    at(key),
    kind,
    project,
    paused,
  )
  return id
}
const rowOf = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
const count = (table, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE item_id = ?`).get(id).n
const movesOf = (id) => db.prepare('SELECT who, from_key, to_key, action, note FROM item_move WHERE item_id = ? ORDER BY id').all(id)
const eventsOf = (id) => db.prepare('SELECT who, text FROM event WHERE item_id = ? ORDER BY id').all(id)
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
const move = (id, body, headers = { cookie, 'x-human-key': pin }) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/move`, payload: body, headers })

// ---- metric 2: today's targets, plus one Close per kind ----

// Today's earlier-step targets from one early step of each kind, written out.
const TODAY = {
  change: {
    from: 'change.define-success',
    targets: [
      ['retry', 'change.define-success'],
      ['return', 'change.define-outcome'],
    ],
  },
  task: {
    from: 'task.run-plan',
    targets: [
      ['retry', 'task.run-plan'],
      ['return', 'task.define-outcome'],
      ['return', 'task.verify-plan'],
      ['return', 'task.guardrails'],
      ['return', 'task.approve-prioritize'],
      ['return', 'task.assess'],
    ],
  },
  plan: {
    from: 'plan.draft-items',
    targets: [
      ['retry', 'plan.draft-items'],
      ['return', 'plan.define-question'],
      ['return', 'plan.set-guardrails'],
      ['return', 'plan.approve-prioritize'],
      ['return', 'plan.inventory'],
      ['return', 'plan.design-options'],
      ['return', 'plan.approve-design'],
    ],
  },
}

for (const [kind, { from, targets }] of Object.entries(TODAY)) {
  test(`metric 2: a ${kind} at ${from} lists today's targets, then one Close to ${FINAL_GATE[kind]}`, () => {
    const item = { id: `K-${kind}`, kind, cursor: at(from) }
    const listed = moveTargets(item)
    const close = listed.filter((t) => t.action === 'skip')
    assert.deepEqual(
      listed.filter((t) => t.action !== 'skip').map((t) => [t.action, t.stepKey]),
      targets,
    )
    assert.equal(close.length, 1)
    assert.equal(listed.at(-1), close[0], 'Close is listed last')
    assert.equal(close[0].stepKey, FINAL_GATE[kind])
    assert.equal(close[0].toIndex, endIndex(kind) - 1)
    assert.deepEqual(close[0].reapprovals, [])
    assert.equal(close[0].isDefault, false)
    assert.match(close[0].redo, /^Skips \d+ steps? and waits at “.+” for approval/)
    const view = movesView(item, listed)
    assert.equal(view.labels[FINAL_GATE[kind]], CLOSE_TARGET_LABEL)
    assert.equal(view.actions[FINAL_GATE[kind]], 'skip')
  })

  test(`metric 2: a ${kind} already at ${FINAL_GATE[kind]} offers no Close`, () => {
    const item = { id: `G-${kind}`, kind, cursor: at(FINAL_GATE[kind]) }
    const listed = moveTargets(item)
    assert.ok(listed.length > 0)
    assert.equal(listed.filter((t) => t.action === 'skip').length, 0)
    assert.notEqual(movesView(item, listed).labels[FINAL_GATE[kind]], CLOSE_TARGET_LABEL)
  })
}

test('metric 2: the Close on a Change says its PR stays unmerged; a Task and a Plan say nothing of a PR', () => {
  const redo = (kind, key) => moveTargets({ id: 'R', kind, cursor: at(key) }).find((t) => t.action === 'skip').redo
  assert.match(redo('change', 'change.implement'), /any open PR stays unmerged$/)
  assert.doesNotMatch(redo('task', 'task.run-plan'), /PR/)
  assert.equal(redo('task', 'task.verify-report'), 'Skips 1 step and waits at “Review & close” for approval')
})

test('dedupe guard: in every kind, lane and step, the final gate is a target at most once', () => {
  for (const kind of ITEM_KINDS) {
    for (const lane of [null, ...LANES]) {
      for (const step of stepsFor(kind)) {
        const item = { id: 'D', kind, lane, cursor: step.index }
        const keys = moveTargets(item).map((t) => t.stepKey)
        assert.equal(new Set(keys).size, keys.length, `${kind}/${lane}/${step.key}: ${keys}`)
        assert.ok(keys.filter((k) => k === FINAL_GATE[kind]).length <= 1, `${kind}/${lane}/${step.key}`)
      }
    }
  }
})

test('planMove skip: refusals, and it never reaches the route’s action form', () => {
  const task = (key, extra = {}) => ({ id: 'P', kind: 'task', cursor: at(key), ...extra })
  assert.deepEqual(planMove(task('task.run-plan'), { action: 'skip', toKey: 'task.execute' }), { error: 'bad_target_key' })
  assert.deepEqual(planMove(task('task.review-close'), { action: 'skip' }), { error: 'not_later' })
  assert.deepEqual(planMove({ id: 'P', kind: 'task', cursor: endIndex('task') }, { action: 'skip' }), { error: 'closed' })
  assert.deepEqual(planMove(task('task.run-plan', { abandoned_at: '2026-11-18 10:00:00' }), { action: 'skip' }), { error: 'abandoned' })
  const plan = planMove(task('task.run-plan'), { action: 'skip', toKey: 'task.review-close' })
  assert.equal(plan.ok, true)
  assert.equal(plan.toKey, 'task.review-close')
  assert.equal(plan.reset.releaseHolds, true)
  assert.equal(plan.needsHumanProof, false)
  assert.equal(ROUTE_MOVE_ACTIONS.includes('skip'), false)
  assert.equal(
    moveTargets({ id: 'P', kind: 'task', cursor: at('task.run-plan'), abandoned_at: '2026-11-18 10:00:00' }).length,
    0,
  )
})

// ---- metric 3: a paused Task at Run plan, moved to Close ----

test('metric 3: a paused Task at Run plan moved to Close waits unpaused and unapproved at Review & close', async () => {
  const id = seed('C-TASK', 'task', 'task.run-plan', { paused: 1 })
  const runsBefore = count('step_run', id)
  const eventsBefore = eventsOf(id).length
  const farmBefore = farmRuns.length
  const note = 'SOMA load already run and proved outside the Task'

  const res = await move(id, { stepKey: 'task.review-close', from: 'task.run-plan', note })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.deepEqual(body.move, { id: body.move.id, itemId: id, who: user.name, fromKey: 'task.run-plan', toKey: 'task.review-close', action: 'skip', note })
  assert.equal(body.restart, undefined, 'nothing starts')
  await tick()

  const row = rowOf(id)
  assert.equal(stepKeyAt(row.cursor), 'task.review-close')
  assert.equal(row.paused, 0)
  assert.equal(isClosed(row), false)
  assert.equal(count('step_run', id), runsBefore, 'no step_run for the skipped steps')
  assert.equal(farmRuns.length, farmBefore, 'nothing was sent to the farm')
  assert.deepEqual(movesOf(id), [{ who: user.name, from_key: 'task.run-plan', to_key: 'task.review-close', action: 'skip', note }])
  const events = eventsOf(id)
  assert.equal(events.length, eventsBefore + 1)
  assert.deepEqual(events.at(-1), { who: user.name, text: `moved this item to “Review & close”: ${note}` })
  assert.equal(count('gate_decision', id), 0, 'the gate is not approved')
  assert.equal(count('gate_action', id), 0)
  assert.equal(count('feedback', id), 0, 'a gate takes no agent feedback')
  const moves = body.item.moves
  assert.equal(moves.approveKey, 'task.review-close', 'the gate still waits for the close approval')
  assert.equal(
    moves.targets.some((t) => moves.actions[t.stepKey] === 'skip'),
    false,
    'no Close at the gate itself',
  )
})

test('guardrail 1: on an Autopilot project, Close then a kick runs nothing and approves nothing', async () => {
  const id = seed('C-AUTO', 'task', 'task.run-plan', { project: autopilotProjectId })
  const runsBefore = count('step_run', id)
  const farmBefore = farmRuns.length
  const res = await move(id, { stepKey: 'task.review-close', from: 'task.run-plan', note: 'done by hand' })
  assert.equal(res.statusCode, 200, res.body)
  orchestrator.kick(id)
  await tick()
  orchestrator.kick(id)
  await tick()
  assert.equal(stepKeyAt(rowOf(id).cursor), 'task.review-close')
  assert.equal(count('step_run', id), runsBefore)
  assert.equal(farmRuns.length, farmBefore)
  assert.equal(count('gate_action', id), 0)
  assert.equal(count('gate_decision', id), 0)
  assert.equal(movesOf(id).length, 1)
})

// ---- metric 4: the same auth as every move ----

test('metric 4: a token-only Close is refused with human_gate_key_required; session + PIN moves it', async () => {
  const id = seed('C-AUTH', 'plan', 'plan.draft-items')
  const body = { stepKey: 'plan.review-close', from: 'plan.draft-items', note: 'filed by hand' }

  const token = await move(id, body, tokenOnly)
  assert.equal(token.statusCode, 401)
  assert.deepEqual(token.json(), { error: 'human_gate_key_required' })
  assert.equal(stepKeyAt(rowOf(id).cursor), 'plan.draft-items')
  assert.equal(movesOf(id).length, 0)

  const tokenWithPin = await move(id, body, { ...tokenOnly, 'x-human-key': pin })
  assert.equal(tokenWithPin.statusCode, 401)
  assert.equal(stepKeyAt(rowOf(id).cursor), 'plan.draft-items')

  const human = await move(id, body)
  assert.equal(human.statusCode, 200, human.body)
  assert.equal(stepKeyAt(rowOf(id).cursor), 'plan.review-close')
  assert.equal(movesOf(id).length, 1)
})

test('a Close the item no longer offers is invalid_target; the legacy action form refuses skip', async () => {
  const id = seed('C-GATE', 'change', 'change.review-close')
  const res = await move(id, { stepKey: 'change.review-close', from: 'change.review-close' })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.json(), { error: 'invalid_target' })
  const legacy = await move(id, { action: 'skip', from: 'change.review-close' })
  assert.equal(legacy.statusCode, 400)
  assert.equal(stepKeyAt(rowOf(id).cursor), 'change.review-close')
  assert.equal(movesOf(id).length, 0)
})

test('a Change moved to Close lands on Review the work & close, its merge untouched', async () => {
  const id = seed('C-CHANGE', 'change', 'change.implement')
  const res = await move(id, { stepKey: 'change.review-close', from: 'change.implement' })
  assert.equal(res.statusCode, 200, res.body)
  const row = rowOf(id)
  assert.equal(stepKeyAt(row.cursor), 'change.review-close')
  assert.equal(row.merged_at, null)
  assert.deepEqual(eventsOf(id).at(-1), { who: user.name, text: 'moved this item to “Review the work & close”' })
})
