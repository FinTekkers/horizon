// HZ-711: the item snapshot's `moves` — every move a person may make from
// where the item is, by step key — so the item page, board cards and the
// Approvals drawer list the server's targets and work out no rule of their
// own. moveOptions is pure; the route cases check the snapshot carries it and
// that POST /move answers with the item and, for an approve or an abandon,
// keeps the options their own routes took.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-move-options-')), 'test.db')
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
const { moveOptions } = await import('../src/moveOptions.js')
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
const keys = (options) => options.targets.map((t) => `${t.action}:${t.key}`)

test('at a gate: Approve names the gate, every earlier step is a return, and no retry', () => {
  const options = moveOptions(itemAt('change.review-before-exec'))
  assert.deepEqual(options.approve, { key: 'change.review-before-exec', label: label('change.review-before-exec') })
  assert.equal(options.canAbandon, true)
  assert.ok(options.targets.every((t) => t.action === 'return'), 'a gate has nothing to retry')
  assert.equal(options.targets[0].key, 'change.define-outcome')
  assert.equal(options.targets.at(-1).key, 'change.summarize-reviews')
})

test('the gate’s declared send-back target is the one default', () => {
  const options = moveOptions(itemAt('change.review-before-exec'))
  assert.deepEqual(
    options.targets.filter((t) => t.isDefault).map((t) => t.key),
    ['change.draft-plan'],
  )
})

test('a return lists what it redoes and the approvals given again; a running step stops', () => {
  const options = moveOptions(itemAt('change.accept-code'), { running: false })
  const target = options.targets.find((t) => t.key === 'change.review-before-exec')
  assert.equal(target.redo, `Redoes 4 steps, from “${label('change.review-before-exec')}” to “${label('change.accept-code')}”.`)
  assert.deepEqual(target.reapprovals, [label('change.review-before-exec')])
  assert.equal(target.stopsRunning, false)

  const early = moveOptions(itemAt('change.accept-code')).targets.find((t) => t.key === 'change.plan-options')
  assert.deepEqual(early.reapprovals, [label('change.approve-design'), label('change.review-before-exec')])
})

test('at a running agent step: Retry of that step, no Approve, and every move stops the run', () => {
  const options = moveOptions(itemAt('change.implement'), { running: true })
  assert.equal(options.approve, null)
  const retry = options.targets.at(-1)
  assert.deepEqual(
    { action: retry.action, key: retry.key, redo: retry.redo, reapprovals: retry.reapprovals },
    { action: 'retry', key: 'change.implement', redo: `Runs “${label('change.implement')}” again.`, reapprovals: [] },
  )
  assert.ok(options.targets.every((t) => t.stopsRunning))
  assert.equal(options.targets.filter((t) => t.isDefault).length, 1, 'Return to… still preselects one')
  assert.equal(options.targets.find((t) => t.isDefault).key, 'change.review-before-exec', 'the nearest return, when no gate declares one')
})

test('a merged item offers no return before Accept the code', () => {
  const options = moveOptions(itemAt('change.deploy', { merged_at: '2026-11-01 00:00:00' }))
  assert.deepEqual(keys(options), ['return:change.accept-code', 'retry:change.deploy'])
})

test('a lane-skipped row is never a target and is not counted as redone', () => {
  const skipped = ['change.plan-options', 'change.approve-design', 'change.arch-review', 'change.summarize-reviews']
  const options = moveOptions(itemAt('change.accept-code', { lane: 'trivial' }))
  assert.deepEqual(options.targets.map((t) => t.key).filter((key) => skipped.includes(key)), [])
  const first = options.targets.find((t) => t.key === 'change.define-outcome')
  assert.ok(!first.reapprovals.includes(label('change.approve-design')))
})

test('closed and abandoned items offer nothing', () => {
  const none = { approve: null, targets: [], canAbandon: false, amend: null }
  assert.deepEqual(moveOptions(itemAt('change.implement', { abandoned_at: '2026-11-01 00:00:00' })), none)
  assert.deepEqual(moveOptions({ id: 'T', kind: 'change', cursor: at('change.review-close') + 1 }), none)
})

test('Amend the rule: back to implement when allowed, else a retry of the blocked step, and only while blocked', () => {
  const block = { rule_block_json: '{"rule":"r","needs":"n"}' }
  assert.deepEqual(moveOptions(itemAt('change.auto-review', block)).amend, { action: 'return', key: 'change.implement' })
  assert.deepEqual(moveOptions(itemAt('change.implement', block)).amend, { action: 'retry', key: 'change.implement' })
  assert.equal(moveOptions(itemAt('change.auto-review')).amend, null)
})

const insert = db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, ?, ?, ?)')
const post = (url, payload) => app.inject({ method: 'POST', url, payload, headers: { cookie, 'x-human-key': pin } })

test('the item snapshot carries moves, and a return through /move answers with the moved item and its restart', async () => {
  insert.run('MO-1', 'Move options', 'Medium', at('change.review-before-exec'), 'change')
  const view = store.itemViewById('MO-1')
  assert.deepEqual(view.moves, moveOptions(db.prepare('SELECT * FROM work_item WHERE id = ?').get('MO-1'), { running: false }))

  const res = await post('/api/items/MO-1/move', { action: 'return', from: 'change.review-before-exec', to: 'change.draft-plan', note: 'redo the plan' })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.move.toKey, 'change.draft-plan')
  assert.equal(body.item.currentStepKey, 'change.draft-plan')
  assert.equal(body.restart.stepKey, 'change.draft-plan')
  assert.equal(typeof body.restart.attempt, 'number')
})

test('an abandon through /move can drop the links where the item blocks others', async () => {
  insert.run('MO-2', 'Blocker', 'Medium', at('change.implement'), 'change')
  insert.run('MO-3', 'Blocked', 'Medium', at('change.define-outcome'), 'change')
  assert.equal(store.addDependency('MO-3', 'MO-2').ok, true)
  const res = await post('/api/items/MO-2/move', { action: 'abandon', from: stepKeyAt(at('change.implement')), note: 'not needed', removeDependentLinks: true })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_item_dependency WHERE depends_on_id = ?').get('MO-2').n, 0)
})
