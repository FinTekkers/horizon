// HZ-547 metric line 2: the board snapshot's planProgress — one entry per
// Plan or Task that filed items (item_spawn `filed` rows), summing its
// children: done, in progress, stalled, and the parent's status. Plus the two
// guardrails: reading it never writes item_spawn, and the stream re-sends it
// only when it changed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-plan-progress-')), 'test.db')
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const app = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { diffSnapshot, makeBaseline } = await import('../src/streamDelta.js')
const { childBucket } = await import('../src/planProgress.js')
const { STEPS, endIndex, firstStepIndex, gateStepIndexes } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const server = app.buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)

const insertItem = db.prepare(
  'INSERT INTO work_item (id, title, priority, cursor, kind, paused, abandoned_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
)
const insertSpawn = db.prepare(
  "INSERT INTO item_spawn (parent_id, request_key, seq, kind, payload_json, child_id, status, created_by) VALUES (?, 'plan:file', ?, 'change', '{}', ?, ?, 'test')",
)
const working = firstStepIndex('change') + 1
const firstGate = gateStepIndexes(STEPS, 'change')[0]
const DONE = endIndex('change')

function item(id, { cursor = working, kind = 'change', paused = 0, abandoned = null } = {}) {
  insertItem.run(id, `${id} title`, 'Medium', cursor, kind, paused, abandoned)
}
let seq = 0
function file(parent, children, status = 'filed') {
  for (const child of children) insertSpawn.run(parent, ++seq, child, status)
}

// P-1: a closed Plan — 1 done, 1 working, 1 paused.
item('P-1', { kind: 'plan', cursor: endIndex('plan') })
item('PA-1', { cursor: DONE })
item('PA-2')
item('PA-3', { paused: 1 })
file('P-1', ['PA-1', 'PA-2', 'PA-3'])
// P-2: 2 done and 1 abandoned.
item('P-2', { kind: 'plan', cursor: endIndex('plan') })
item('PB-1', { cursor: DONE })
item('PB-2', { cursor: DONE })
item('PB-3', { abandoned: '2026-10-20 10:00:00' })
file('P-2', ['PB-1', 'PB-2', 'PB-3'])
// P-3: a Plan whose only spawn row failed, so it filed nothing.
item('P-3', { kind: 'plan' })
item('PC-1')
file('P-3', ['PC-1'], 'failed')
// T-1: an open Task — 1 waiting at its first gate, 1 working.
item('T-1', { kind: 'task', cursor: firstStepIndex('task') })
item('TA-1', { cursor: firstGate })
item('TA-2')
file('T-1', ['TA-1', 'TA-2'])
// U-1: nothing filed it.
item('U-1')

const current = () => app.snapshot({ scope: 'enabled', stepOutputs: false })
const byId = (snap) => Object.fromEntries(snap.planProgress.map((p) => [p.id, p]))

test('a closed Plan with 1 done, 1 in progress and 1 paused child is 1 of 3 done and stalled', () => {
  const p = byId(current())['P-1']
  assert.equal(p.kind, 'plan')
  assert.equal(p.title, 'P-1 title')
  assert.equal(p.closed, true)
  assert.equal(p.done, 1)
  assert.equal(p.total, 3)
  assert.equal(p.inProgress, 1)
  assert.equal(p.stalled, 1)
  assert.equal(p.status, 'stalled')
})

test('a Plan whose children are all done or abandoned is complete, abandoned not counted as done', () => {
  const p = byId(current())['P-2']
  assert.equal(p.done, 2)
  assert.equal(p.abandoned, 1)
  assert.equal(p.total, 3)
  assert.equal(p.status, 'complete')
})

test('a Plan that filed nothing is absent, and only filing parents appear', () => {
  const snap = current()
  assert.deepEqual(
    snap.planProgress.map((p) => p.id),
    ['P-1', 'T-1', 'P-2'],
    'sorted Stalled, In progress, Complete',
  )
  const t = byId(snap)['T-1']
  assert.equal(t.kind, 'task')
  assert.equal(t.status, 'inProgress')
  assert.equal(t.waiting, 1)
  assert.deepEqual(t.waitingAtGate, [{ gate: 1, count: 1 }])
})

test('a rule-blocked child is stalled; changes requested is not', () => {
  assert.equal(childBucket({ cursor: working, ruleBlock: { rule: 'r', needs: 'n' } }), 'stalled')
  assert.equal(childBucket({ cursor: firstGate, rejected: true }), 'inProgress')
})

test('a child with two filed parents counts toward the first one filed only', () => {
  item('P-9', { kind: 'plan' })
  file('P-9', ['PA-2'])
  const progress = byId(current())
  assert.equal(progress['P-9'], undefined)
  assert.equal(progress['P-1'].total, 3)
  db.prepare("DELETE FROM item_spawn WHERE parent_id = 'P-9'").run()
})

test('reading the board writes nothing to item_spawn', async () => {
  const rows = () => db.prepare('SELECT * FROM item_spawn ORDER BY id').all()
  const before = rows()
  const res = await server.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().planProgress.length, 3)
  assert.deepEqual(rows(), before)
})

test('the stream re-sends planProgress only when it changed', () => {
  const baseline = makeBaseline(current())
  const same = diffSnapshot(baseline, current())
  assert.equal(same.delta?.top?.planProgress, undefined)

  db.prepare("UPDATE work_item SET paused = 1 WHERE id = 'TA-2'").run()
  const changed = diffSnapshot(same.baseline, current())
  assert.equal(changed.delta.top.planProgress.find((p) => p.id === 'T-1').stalled, 1)
  db.prepare("UPDATE work_item SET paused = 0 WHERE id = 'TA-2'").run()
})

test('the concierge farm snapshot leaves planProgress off', () => {
  assert.equal('planProgress' in app.snapshot({ scope: 'enabled', plans: false }), false)
})
