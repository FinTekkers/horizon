// HZ-711: what item.moves carries beside HZ-799's targets — each target's
// action, the labels it names, where the gate's Approve goes, whether the item
// can be abandoned and Amend the rule's target — so the item page, board cards
// and the Approvals drawer list the server's moves and work out no rule of
// their own. movesView is pure; the route cases check a stepKey return answers
// with the moved item and its restart, and an abandon through /move keeps the
// option its own route took.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-moves-view-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'FARM_STEP_INDEXES', 'WA_NOTIFY_ENABLED', 'WA_POLL_ENABLED']) delete process.env[key]

const ok = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) })
globalThis.fetch = async (url) => {
  if (String(url).startsWith('https://api.github.com/')) return { ok: false, status: 500, headers: new Headers(), json: async () => ({}) }
  return ok({ ok: true })
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { moveTargets, movesView } = await import('../src/moveItem.js')
const { stepIndexOf, stepKeyAt, STEPS } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
const app = buildApp({ logger: false })
await app.ready()
const { pin, cookie } = loginFixtureUser(auth, config)

after(async () => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
  await app.close()
})

const at = (key) => stepIndexOf(key)
const itemAt = (key, extra = {}) => ({ id: 'T', kind: key.split('.')[0], cursor: at(key), ...extra })
const label = (key) => STEPS[at(key)].label
const viewOf = (item, opts) => movesView(item, moveTargets(item, opts), opts)

test('at a gate: every target is named by its action and label, and Approve names the gate', () => {
  const item = itemAt('change.review-before-exec')
  const moves = viewOf(item)
  assert.deepEqual(moves.targets, moveTargets(item).map(({ action, toIndex, ...t }) => t), 'the targets are HZ-799’s, unchanged')
  assert.equal(moves.approveKey, 'change.review-before-exec')
  assert.equal(moves.labels['change.review-before-exec'], label('change.review-before-exec'))
  for (const t of moves.targets) {
    if (moves.actions[t.stepKey] === 'approve') continue
    assert.equal(moves.actions[t.stepKey], 'return')
    assert.equal(moves.labels[t.stepKey], label(t.stepKey))
    for (const key of t.reapprovals) assert.equal(moves.labels[key], label(key))
  }
  assert.equal(moves.canAbandon, true)
  assert.equal(moves.amendKey, null)
})

test('at an agent step: its retry is listed as one, and there is no Approve', () => {
  const moves = viewOf(itemAt('change.implement'), { running: true })
  assert.equal(moves.approveKey, null)
  assert.equal(moves.actions['change.implement'], 'retry')
  assert.equal(moves.labels['change.implement'], label('change.implement'))
})

test('a disabled project, a closed item and an abandoned one offer no Approve; only an open item can be abandoned', () => {
  assert.equal(viewOf(itemAt('change.review-before-exec'), { enabled: false }).approveKey, null)
  const abandoned = viewOf(itemAt('change.review-before-exec', { abandoned_at: '2026-11-01 00:00:00' }))
  assert.deepEqual([abandoned.approveKey, abandoned.canAbandon, abandoned.targets], [null, false, []])
  const closed = viewOf({ id: 'T', kind: 'change', cursor: at('change.review-close') + 1 })
  assert.deepEqual([closed.approveKey, closed.canAbandon, closed.targets], [null, false, []])
})

test('Amend the rule: back to implement when listed, else the retry, and only while a rule blocks', () => {
  const block = { rule_block_json: '{"rule":"r","needs":"n"}' }
  assert.equal(viewOf(itemAt('change.auto-review', block)).amendKey, 'change.implement')
  assert.equal(viewOf(itemAt('change.implement', block)).amendKey, 'change.implement')
  assert.equal(viewOf(itemAt('change.auto-review')).amendKey, null)
})

const insert = db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, ?, ?, ?)')
const post = (url, payload) => app.inject({ method: 'POST', url, payload, headers: { cookie, 'x-human-key': pin } })

test('a stepKey return through /move answers with the moved item and the attempt starting there', async () => {
  insert.run('MV-1', 'Moves view', 'Medium', at('change.review-before-exec'), 'change')
  const moves = store.itemViewById('MV-1').moves
  assert.equal(moves.actions['change.draft-plan'], 'return')

  const res = await post('/api/items/MV-1/move', { stepKey: 'change.draft-plan', from: 'change.review-before-exec', note: 'redo the plan' })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.move.toKey, 'change.draft-plan')
  assert.equal(body.item.currentStepKey, 'change.draft-plan')
  assert.equal(body.restart.stepKey, 'change.draft-plan')
  assert.equal(typeof body.restart.attempt, 'number')
})

test('an abandon through /move can drop the links where the item blocks others', async () => {
  insert.run('MV-2', 'Blocker', 'Medium', at('change.implement'), 'change')
  insert.run('MV-3', 'Blocked', 'Medium', at('change.define-outcome'), 'change')
  assert.equal(store.addDependency('MV-3', 'MV-2').ok, true)
  const res = await post('/api/items/MV-2/move', { action: 'abandon', from: stepKeyAt(at('change.implement')), note: 'not needed', removeDependentLinks: true })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_item_dependency WHERE depends_on_id = ?').get('MV-2').n, 0)
})
