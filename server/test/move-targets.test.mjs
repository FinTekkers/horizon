// HZ-799: item.moves.targets — every step the item may be moved to now, by
// HZ-709 step key — and POST /api/items/:id/move { stepKey, from, note },
// which takes the item to one of them. The server owns the list: a key it
// lists works, any other key is invalid_target, and nothing moves without the
// gate PIN the other gate actions take.
//
// The agent runner is a no-op spy, so nothing a move kicks can move the item
// again before it is read. Runs over a real socket for the v2 stream.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-move-targets-')), 'test.db')
for (const key of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'FARM_URL', 'HORIZON_REPO', 'WA_NOTIFY_ENABLED', 'WA_POLL_ENABLED']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const appModule = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { CLOSED_KEY, moveKeyOf } = await import('../src/moveItem.js')
const { IMPLEMENT_STEP_INDEX, ITEM_KINDS, LANES, endIndex, laneOf, stepIndexOf, stepKeyAt, stepsFor } = await import(
  '../../domain/js/lifecycle.js'
)
const { decodeMoveKey } = await import('../../domain/js/substeps.js')

store.purgeDemoItems()
const kicks = []
const cancels = []
let onCancel = () => {}
store.registerAgentRunner({
  kick: (id) => kicks.push(id),
  cancel: (id) => {
    cancels.push(id)
    onCancel(id)
  },
})
const app = appModule.buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)
let base
before(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${app.server.address().port}`
})
after(() => app.close())

const SUBSTEPS = JSON.stringify([
  { id: 'impl-audit', label: 'Audit the change', kind: 'audit', anchor: IMPLEMENT_STEP_INDEX, persona: null, output: 'findings', applies: { labels: [], repos: [], paths: [] } },
])

let seq = 0
const insert = db.prepare(
  'INSERT INTO work_item (id, title, priority, cursor, kind, lane, substeps_json, substep_cursor, project_id, abandoned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
)
function seed(cursor, { kind = 'change', lane = null, substeps = null, substepCursor = null, project = null, abandoned = null } = {}) {
  const id = `MT-${++seq}`
  insert.run(id, `Item ${id}`, 'Medium', cursor, kind, lane, substeps, substepCursor, project, abandoned)
  return id
}
const row = (id) => db.prepare('SELECT cursor, kind, lane, substep_cursor, abandoned_at, merged_at FROM work_item WHERE id = ?').get(id)
const moveCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM item_move WHERE item_id = ?').get(id).n
const targetsOf = (id) => store.itemViewById(id).moves.targets
const move = (id, body, headers = { cookie, 'x-human-key': pin }) => app.inject({ method: 'POST', url: `/api/items/${id}/move`, payload: body, headers })
const fromOf = (id) => moveKeyOf(row(id))
const list = async () => (await app.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie } })).json().items

// Each variant is walked at every row of its kind, plus closed and abandoned.
const VARIANTS = [
  ...ITEM_KINDS.map((kind) => ({ name: kind, kind })),
  ...LANES.flatMap((lane) => ITEM_KINDS.filter((kind) => laneOf({ kind, lane })).map((kind) => ({ name: `${kind} lane ${lane}`, kind, lane }))),
  { name: 'change with sub-steps', kind: 'change', substeps: SUBSTEPS },
]

function assertTargetShape(targets, where) {
  assert.ok(Array.isArray(targets), `${where}: targets is not an array`)
  for (const t of targets) {
    assert.deepEqual(Object.keys(t).sort(), ['isDefault', 'reapprovals', 'redo', 'stepKey', 'stopsRunning'], `${where}: ${JSON.stringify(t)}`)
    assert.equal(typeof t.stepKey, 'string')
    assert.doesNotMatch(t.stepKey, /^\d+$/, `${where}: a numeric stepKey`)
    const { stepKey } = decodeMoveKey(t.stepKey)
    assert.ok(stepKey === CLOSED_KEY || stepIndexOf(stepKey) !== null, `${where}: ${t.stepKey} is no step key`)
    assert.equal(typeof t.isDefault, 'boolean')
    assert.equal(typeof t.stopsRunning, 'boolean')
    assert.equal(typeof t.redo, 'string')
    assert.ok(t.redo.trim().length > 0 && !t.redo.includes('\n'), `${where}: redo ${JSON.stringify(t.redo)}`)
    assert.ok(Array.isArray(t.reapprovals) && t.reapprovals.every((k) => typeof k === 'string' && stepIndexOf(k) !== null))
  }
  assert.ok(targets.filter((t) => t.isDefault).length <= 1, `${where}: more than one default`)
  assert.equal(new Set(targets.map((t) => t.stepKey)).size, targets.length, `${where}: a stepKey listed twice`)
}

test('metric 1 and 4: at every step of every kind, each listed stepKey moves a fresh item there with one item_move row', async () => {
  let walked = 0
  for (const variant of VARIANTS) {
    const { name, ...opts } = variant
    for (const step of stepsFor(variant.kind)) {
      const probe = seed(step.index, opts)
      const targets = targetsOf(probe)
      assertTargetShape(targets, `${name} at ${step.key}`)
      for (const target of targets) {
        const id = seed(step.index, opts)
        const res = await move(id, { stepKey: target.stepKey, from: step.key, note: `to ${target.stepKey}` })
        assert.equal(res.statusCode, 200, `${name}: ${step.key} → ${target.stepKey}: ${res.body}`)
        const { stepKey, substepId } = decodeMoveKey(target.stepKey)
        assert.equal(moveKeyOf(row(id)), stepKey, `${name}: ${step.key} → ${target.stepKey}`)
        if (substepId) assert.equal(row(id).substep_cursor, substepId)
        assert.equal(moveCount(id), 1, `${name}: ${step.key} → ${target.stepKey} wrote ${moveCount(id)} rows`)
        assert.equal(res.json().item.cursor, row(id).cursor, 'the answer carries the moved item')
        walked++
      }
    }
    assert.deepEqual(targetsOf(seed(endIndex(variant.kind), opts)), [], `${name}: a closed item lists targets`)
    assert.deepEqual(targetsOf(seed(stepsFor(variant.kind)[2].index, { ...opts, abandoned: '2026-11-01 00:00:00' })), [], `${name}: abandoned`)
  }
  assert.ok(walked > 100, `only ${walked} moves walked`)
})

test('metric 1: an item in a disabled project lists nothing; Approve the run with no run plan lists no approve', async () => {
  const on = store.createProject('Moves on').id
  const off = store.createProject('Moves off').id
  store.setProjectEnabled(on, true)
  store.setProjectEnabled(off, false)
  for (const key of ['change.approve-design', 'change.draft-plan']) {
    const id = seed(stepIndexOf(key), { project: off })
    assert.deepEqual(targetsOf(id), [], `${key} in a disabled project`)
    const refused = await move(id, { stepKey: stepKeyAt(stepIndexOf(key) - 1), from: key })
    assert.equal(refused.statusCode, 400)
    assert.equal(moveCount(id), 0)
  }
  const gate = stepIndexOf('task.approve-run')
  const id = seed(gate, { kind: 'task' })
  const targets = targetsOf(id)
  assert.ok(targets.length > 0)
  assert.ok(!targets.some((t) => stepIndexOf(t.stepKey) > gate), 'approve listed with no run plan')
  for (const t of targets) {
    const fresh = seed(gate, { kind: 'task' })
    assert.equal((await move(fresh, { stepKey: t.stepKey, from: 'task.approve-run' })).statusCode, 200, t.stepKey)
  }
})

test('metric 2: a key the item does not list is 400 invalid_target and moves nothing', async () => {
  const gateKey = 'change.accept-code'
  const gate = seed(stepIndexOf(gateKey), { substeps: SUBSTEPS })
  const plain = seed(stepIndexOf('change.draft-plan'))
  const abandoned = seed(stepIndexOf('change.draft-plan'), { abandoned: '2026-11-01 00:00:00' })
  const cases = [
    [gate, gateKey, 'change.review-close'],
    [gate, gateKey, 'task.define-outcome'],
    [gate, gateKey, '5'],
    [gate, gateKey, String(IMPLEMENT_STEP_INDEX)],
    [gate, gateKey, 'change.implement#no-such-substep'],
    [plain, 'change.draft-plan', 'change.plan-options#x'],
    [plain, 'change.draft-plan', 'change.implement'],
    [abandoned, 'change.draft-plan', 'change.draft-plan'],
    [abandoned, 'change.draft-plan', 'change.plan-options'],
  ]
  for (const [id, from, stepKey] of cases) {
    const before = row(id)
    const res = await move(id, { stepKey, from })
    assert.equal(res.statusCode, 400, `${stepKey}: ${res.body}`)
    assert.deepEqual(res.json(), { error: 'invalid_target' })
    assert.deepEqual(row(id), before)
    assert.equal(moveCount(id), 0)
  }
  const both = await move(plain, { action: 'retry', stepKey: 'change.draft-plan', from: 'change.draft-plan' })
  assert.equal(both.statusCode, 400)
  assert.deepEqual(both.json(), { error: 'bad_action' })
  assert.equal(moveCount(plain), 0)
})

test('metric 3: no PIN or a wrong PIN is 401, a stale or repeated move is 409 stale_step — none moves', async () => {
  const key = 'change.approve-design'
  const id = seed(stepIndexOf(key))
  const target = targetsOf(id).find((t) => t.isDefault).stepKey
  const noPin = await move(id, { stepKey: target, from: key }, { cookie })
  assert.equal(noPin.statusCode, 401)
  assert.deepEqual(noPin.json(), { error: 'human_gate_key_required' })
  // A wrong PIN locks its session, so each try gets its own.
  for (const stepKey of [target, 'change.deploy']) {
    const other = loginFixtureUser(auth, config, { email: `wrong-${stepKey}@example.com` })
    const wrong = await move(id, { stepKey, from: key }, { cookie: other.cookie, 'x-human-key': '000000' === other.pin ? '111111' : '000000' })
    assert.equal(wrong.statusCode, 401, `${stepKey}: auth is checked before the target`)
    assert.deepEqual(wrong.json(), { error: 'human_gate_key_required' })
  }
  const stale = await move(id, { stepKey: target, from: 'change.plan-options' })
  assert.equal(stale.statusCode, 409)
  assert.deepEqual(stale.json(), { error: 'stale_step' })
  assert.equal(fromOf(id), key)
  assert.equal(moveCount(id), 0)

  assert.equal((await move(id, { stepKey: target, from: key })).statusCode, 200)
  const again = await move(id, { stepKey: target, from: key })
  assert.equal(again.statusCode, 409)
  assert.deepEqual(again.json(), { error: 'stale_step' })
  assert.equal(moveCount(id), 1)
})

test('guardrail 3: the stepKey form refuses exactly what the action form refuses', async () => {
  const member = loginFixtureUser(auth, config, { email: 'outsider@example.com', role: 'member' })
  const project = store.createProject('Moves members').id
  store.setProjectEnabled(project, true)
  const key = 'change.draft-plan'
  const id = seed(stepIndexOf(key), { project })
  const sessions = [
    ['no PIN', () => ({ cookie })],
    ['wrong PIN', () => ({ cookie: loginFixtureUser(auth, config, { email: `parity-${++seq}@example.com` }).cookie, 'x-human-key': 'not-a-pin' })],
    ['non-member', () => ({ cookie: member.cookie, 'x-human-key': member.pin })],
  ]
  for (const [name, headers] of sessions) {
    const byAction = await move(id, { action: 'retry', from: key }, headers())
    const byKey = await move(id, { stepKey: key, from: key }, headers())
    assert.ok(byAction.statusCode >= 400, `${name}: the action form let it through`)
    assert.equal(byKey.statusCode, byAction.statusCode, `${name}: ${byKey.body} vs ${byAction.body}`)
    assert.deepEqual(byKey.json(), byAction.json())
  }
  assert.equal(moveCount(id), 0)
})

test('metric 5: a gate lists its anchor’s sub-steps, and a move there lands on the sub-step', async () => {
  const key = 'change.accept-code'
  const id = seed(stepIndexOf(key), { substeps: SUBSTEPS })
  const subKey = 'change.implement#impl-audit'
  const target = targetsOf(id).find((t) => t.stepKey === subKey)
  assert.ok(target, `${subKey} not listed`)
  assert.match(target.redo, /Audit the change/)
  const res = await move(id, { stepKey: subKey, from: key, note: 'audit again' })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual([row(id).cursor, row(id).substep_cursor], [IMPLEMENT_STEP_INDEX, 'impl-audit'])
  assert.equal(moveCount(id), 1)
  assert.equal(res.json().item.substep_cursor, 'impl-audit')
})

test('metric 5: an item on a sub-step lists it by key, and a move there keeps it on the sub-step', async () => {
  const id = seed(IMPLEMENT_STEP_INDEX, { substeps: SUBSTEPS, substepCursor: 'impl-audit' })
  const targets = targetsOf(id)
  const subKey = 'change.implement#impl-audit'
  const retry = targets.find((t) => t.stepKey === subKey)
  assert.ok(retry, `${subKey} not listed: ${JSON.stringify(targets.map((t) => t.stepKey))}`)
  assert.equal(retry.isDefault, true)
  assert.ok(!targets.some((t) => t.stepKey === 'change.implement'), 'the global step is listed as well as the sub-step')
  const res = await move(id, { stepKey: subKey, from: 'change.implement' })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual([row(id).cursor, row(id).substep_cursor], [IMPLEMENT_STEP_INDEX, 'impl-audit'])
  assert.equal(moveCount(id), 1)
})

test('metric 4 and guardrail 2: the move answer, the list and the v2 stream carry the same moves, with no server-only field', async () => {
  // Seeded before the stream opens, so its snapshot frame carries the item.
  const key = 'change.approve-design'
  const id = seed(stepIndexOf(key))
  const controller = new AbortController()
  const res = await fetch(`${base}/api/stream?v=2`, { headers: { cookie }, signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const frames = (event) =>
    // Complete frames only: none until the first one has fully arrived.
    text
      .slice(0, Math.max(0, text.lastIndexOf('\n\n')))
      .split('\n\n')
      .filter((block) => block.startsWith(`event: ${event}\n`))
      .map((block) => JSON.parse(block.slice(block.indexOf('data: ') + 6)))
  // One reader loop: a read dropped by a race would lose its chunk.
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      // aborted below
    }
  })()
  const readUntil = async (done) => {
    for (let i = 0; i < 500 && !done(); i++) await sleep(10)
    return done()
  }
  try {
    assert.ok(await readUntil(() => frames('snapshot').length > 0))
    const snap = frames('snapshot')[0]
    assert.ok(snap.items.some((item) => item.id === id), 'the snapshot frame misses the seeded item')
    for (const item of snap.items) assertTargetShape(item.moves.targets, `stream snapshot ${item.id}`)

    const target = targetsOf(id).find((t) => t.isDefault).stepKey
    const moved = await move(id, { stepKey: target, from: key })
    assert.equal(moved.statusCode, 200, moved.body)
    const answered = moved.json().item.moves
    assertTargetShape(answered.targets, 'move answer')
    assert.notDeepEqual(answered.targets, [])

    const listed = (await list()).find((item) => item.id === id).moves
    assert.deepEqual(listed, answered)
    for (const item of await list()) assertTargetShape(item.moves.targets, `list ${item.id}`)

    appModule.flushStream()
    const upserted = () => frames('delta').flatMap((d) => d.upserts ?? []).find((item) => item.id === id && item.currentStepKey === target)
    assert.ok(await readUntil(() => upserted()), 'no upsert of the moved item')
    assert.deepEqual(upserted().moves, answered)
  } finally {
    controller.abort()
  }
})

test('guardrail 4: a refusal inside the move transaction leaves the step and writes no row', async () => {
  const key = 'change.draft-plan'
  const id = seed(stepIndexOf(key))
  const target = targetsOf(id).find((t) => t.stepKey === 'change.plan-options')
  assert.ok(target)
  // The item is abandoned in between the route's check and the move — the
  // move's own transaction re-plans and refuses.
  onCancel = (cancelled) => {
    if (cancelled === id) db.prepare("UPDATE work_item SET abandoned_at = '2026-11-01 00:00:00' WHERE id = ?").run(id)
  }
  try {
    const res = await move(id, { stepKey: target.stepKey, from: key })
    assert.equal(res.statusCode, 409, res.body)
    assert.deepEqual(res.json(), { error: 'abandoned' })
  } finally {
    onCancel = () => {}
  }
  assert.equal(fromOf(id), key)
  assert.equal(moveCount(id), 0)
})

test('guardrail 4: moving a running item stops its run through the runner’s cancel, once', async () => {
  const key = 'change.draft-plan'
  const id = seed(stepIndexOf(key))
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'Eng', 'active')").run(id, stepIndexOf(key))
  const targets = targetsOf(id)
  assert.ok(targets.length > 0 && targets.every((t) => t.stopsRunning === true), JSON.stringify(targets))
  const before = cancels.filter((c) => c === id).length
  const res = await move(id, { stepKey: 'change.plan-options', from: key })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(cancels.filter((c) => c === id).length - before, 1)
  assert.equal(moveCount(id), 1)

  const gate = seed(stepIndexOf('change.approve-design'))
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'Eng', 'active')").run(gate, stepIndexOf('change.plan-options'))
  const approve = targetsOf(gate).find((t) => t.stepKey === 'change.draft-plan')
  assert.equal(approve.stopsRunning, false, 'approving a gate stops nothing')
})
