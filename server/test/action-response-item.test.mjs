// HZ-389: a successful pause, resume or send-back answers with the item's new
// state — the item as the v2 stream upserts it — so the page shows it without
// waiting for the stream. A send-back that restarts an agent step also names
// the attempt starting there, and that number is the one the orchestrator
// writes on the step_run row: both read store.nextStepAttempt. Errors keep
// their exact bodies, and the store's writes and the send-back's return to its
// other callers (the caretaker, the WhatsApp poll vote) are unchanged.
//
// Mock mode (no FARM_URL), with a mock latency long enough that no run started
// here ever finishes, so each one is still active when it is checked.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-action-item-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '600000'
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const { IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const store = await import('../src/store.js')
const deployDrain = await import('../src/deployDrain.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')

store.purgeDemoItems()
await orchestrator.init({ info: () => {}, warn: () => {}, error: () => {} })
const app = buildApp({ logger: false })
const { pin, cookie } = loginFixtureUser(auth, config)
const gated = (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie, 'x-human-key': pin } })
const inject = (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie } })
await app.ready()

after(() => {
  deployDrain.endDrain()
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

const runsOf = (id) => db.prepare('SELECT * FROM step_run WHERE item_id = ? ORDER BY id').all(id)
const activeRunOf = (id) => db.prepare("SELECT * FROM step_run WHERE item_id = ? AND status = 'active'").get(id)
const itemRow = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)

// A paused item whose implement step failed `attempts` times, as failFarmRun
// leaves it (a failed run is recorded as cancelled); `last` sets flags on the
// newest run.
function failedImplementItem(id, attempts, last = {}) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, paused) VALUES (?, ?, ?, ?, 1)').run(id, `Item ${id}`, 'Medium', IMPLEMENT_STEP_INDEX)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const flags = attempt === attempts ? last : {}
    db.prepare(
      `INSERT INTO step_run (item_id, step_index, attempt, agent, status, deploy_interrupted, rule_blocked, ended_at)
       VALUES (?, ?, ?, 'Eng', 'cancelled', ?, ?, datetime('now'))`,
    ).run(id, IMPLEMENT_STEP_INDEX, attempt, flags.deployInterrupted ? 1 : 0, flags.ruleBlocked ? 1 : 0)
  }
}

const sendNote = (id, feedback = 'try X') =>
  gated({ method: 'POST', url: `/api/items/${id}/reject`, payload: { target: 'Eng', feedback } })

test('a note on a paused, failed step answers with the item and the attempt the orchestrator wrote (MAX + 1)', async () => {
  failedImplementItem('AR-1', 2)
  const res = await sendNote('AR-1')
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.restart, { stepIndex: IMPLEMENT_STEP_INDEX, attempt: 3 })

  const run = activeRunOf('AR-1')
  assert.equal(run.attempt, body.restart.attempt, 'the answer names the attempt written on the run row')
  assert.equal(body.item.id, 'AR-1')
  assert.equal(body.item.paused, false)
  assert.equal(body.item.cursor, IMPLEMENT_STEP_INDEX)
  assert.equal(body.item.activeRun.id, run.id)
  assert.equal(body.item.activeRun.attempt, 3)
  assert.equal(body.item.stepOutputs, undefined, 'the item is the v2 stream shape, without stepOutputs')
  assert.match(body.item.events[0].text, /^requested changes on Eng: try X — sent back to the /)
})

for (const [label, flags] of [
  ['a rule-blocked run', { ruleBlocked: true }],
  ['a deploy-interrupted run', { deployInterrupted: true }],
]) {
  test(`after ${label} the answer keeps that run's attempt, as the orchestrator does`, async () => {
    const id = flags.ruleBlocked ? 'AR-RB' : 'AR-DI'
    failedImplementItem(id, 2, flags)
    const res = await sendNote(id)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().restart, { stepIndex: IMPLEMENT_STEP_INDEX, attempt: 2 })
    assert.equal(activeRunOf(id).attempt, 2)
  })
}

test('a dispatch held for a deploy has no run yet: the answer names the attempt its dispatch then writes', async () => {
  failedImplementItem('AR-H', 1)
  deployDrain.beginDrain({ ttlS: 600 })
  try {
    const res = await sendNote('AR-H')
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.item.activeRun, null, 'the dispatch was held')
    assert.deepEqual(body.restart, { stepIndex: IMPLEMENT_STEP_INDEX, attempt: 2 })

    // nextStepAttempt is a pure read: asking again changes no row.
    const before = { runs: runsOf('AR-H'), item: itemRow('AR-H') }
    assert.deepEqual(store.nextStepAttempt('AR-H', IMPLEMENT_STEP_INDEX), { attempt: 2, keepsAttempt: false, autoRetryCount: null })
    assert.deepEqual({ runs: runsOf('AR-H'), item: itemRow('AR-H') }, before)
  } finally {
    deployDrain.endDrain()
  }
  assert.equal(activeRunOf('AR-H')?.attempt, 2, 'the released dispatch wrote the attempt the answer named')
})

test('a send-back keeps its writes, and gateActions.sendBack still returns only { ok: true }', async () => {
  failedImplementItem('AR-G', 1)
  const result = app.gateActions.sendBack('AR-G', { target: 'Eng', feedback: 'from the caretaker' }, 'Caretaker')
  assert.deepEqual(result, { ok: true })
  const row = itemRow('AR-G')
  assert.equal(row.paused, 0)
  assert.equal(row.cursor, IMPLEMENT_STEP_INDEX)
  assert.equal(activeRunOf('AR-G')?.attempt, 2, 'the step was kicked')
  const event = db.prepare("SELECT text FROM event WHERE item_id = 'AR-G' ORDER BY id DESC LIMIT 1").get().text
  assert.equal(event, 'requested changes on Eng: from the caretaker — sent back to the specialist agent implements step')
})

test('a failed send-back keeps its exact error body, with no item', async () => {
  const missing = await sendNote('NOPE-389')
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missing.json(), { error: 'not_found' })

  db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('AR-C', 'Closed', 'Medium', 99)").run()
  const closed = await sendNote('AR-C')
  assert.equal(closed.statusCode, 409)
  assert.deepEqual(closed.json(), { error: 'closed' })
})

test('resume answers with the item and the run it just started', async () => {
  failedImplementItem('AR-P', 1)
  const res = await inject({ method: 'POST', url: '/api/items/AR-P/pause', payload: { paused: false } })
  assert.equal(res.statusCode, 200)
  const { ok, paused, item, restart } = res.json()
  assert.deepEqual({ ok, paused }, { ok: true, paused: false })
  assert.equal(restart, undefined, 'only a send-back names a restart')
  assert.equal(item.paused, false)
  assert.equal(item.activeRun.attempt, activeRunOf('AR-P').attempt)
})
