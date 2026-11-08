// HZ-712 metric 4 and guardrail 4: with /feedback's step re-run retired, a
// note for a running agent step goes through the move route's Retry. The note
// is saved word for word, and a fresh read of the board shows the item still
// on that step with a run going — the only move row is the retry itself, from
// the step to the same step, never a return.
//
// The farm is a fetch stub; the orchestrator is the real one.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-move-retry-note-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'FARM_STEP_INDEXES', 'WA_NOTIFY_ENABLED', 'WA_POLL_ENABLED']) delete process.env[key]

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
const { stepIndexOf } = await import('../../domain/js/lifecycle.js')
const { connectReadyRepo } = await import('./helpers/readyRepo.mjs')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
const app = buildApp({ logger: false })
await app.ready()
const { user, pin, cookie } = loginFixtureUser(auth, config)
const REPO = 'acme/retry-note'
connectReadyRepo(db, REPO, { noDeploy: true })
db.prepare("UPDATE project SET enabled = 1 WHERE name = 'Ready repos'").run()

after(async () => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
  await app.close()
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
const runningAt = (id, index) =>
  db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active' ORDER BY id").all(id, index)

test('a note sent to a running step through the move route’s Retry is saved, and the item stays on that step', async () => {
  const KEY = 'change.plan-options'
  const index = stepIndexOf(KEY)
  const id = 'RN-1'
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind, repo) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, 'Retry with a note', 'Medium', index, 'change', REPO,
  )
  // The step running, as the farm left it.
  db.prepare("INSERT INTO step_run (item_id, step_index, agent, status) VALUES (?, ?, 'Architect', 'active')").run(id, index)
  const [first] = runningAt(id, index)
  assert.ok(first, 'the agent step is running before the note')

  const NOTE = 'Compare against the cached option too.'
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/move`,
    payload: { action: 'retry', from: KEY, note: NOTE },
    headers: { cookie, 'x-human-key': pin },
  })
  assert.equal(res.statusCode, 200, res.body)
  await tick()
  assert.equal(farmRuns.length, 1, 'the retry dispatched one new run to the farm')

  // The note, word for word, for this step.
  assert.deepEqual(
    db.prepare('SELECT message, step_key FROM feedback WHERE item_id = ?').all(id).map((r) => ({ ...r })),
    [{ message: NOTE, step_key: KEY }],
  )

  // A fresh read, not the move's own answer.
  const board = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  assert.equal(board.statusCode, 200, board.body)
  const items = board.json().items ?? board.json()
  const item = items.find((it) => it.id === id)
  assert.ok(item, 'the item is on the board')
  assert.equal(item.cursor, index)
  assert.equal(item.currentStepKey, KEY)
  assert.ok(item.activeRun, 'the step is still running')
  assert.equal(item.activeRun.step_index, index)
  assert.notEqual(item.activeRun.id, first.id, 'the step re-runs as a new attempt')

  // One retry row, on the same step — no return.
  assert.deepEqual(
    db.prepare('SELECT who, from_key, to_key, action, note FROM item_move WHERE item_id = ? ORDER BY id').all(id).map((r) => ({ ...r })),
    [{ who: user.name, from_key: KEY, to_key: KEY, action: 'retry', note: NOTE }],
  )
})
