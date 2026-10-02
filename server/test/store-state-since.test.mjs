// HZ-228: listItems' state_since — when each item entered its current state,
// for the board's elapsed label. Its own process, so its own temp DB.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-state-since-')), 'test.db')

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

const GATE_INDEX = IMPLEMENT_STEP_INDEX - 1
assert.equal(STEPS[GATE_INDEX].kind, 'gate')
assert.equal(STEPS[GATE_INDEX - 1].kind, 'agent')

const insertItem = db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor, paused, abandoned_at, created_at) VALUES (?, ?, 'Medium', ?, ?, ?, ?)",
)
const insertRun = db.prepare(
  "INSERT INTO step_run (item_id, step_index, agent, status, started_at, ended_at) VALUES (?, ?, 'Eng', ?, ?, ?)",
)

// Seeded times are UTC in SQLite's own "YYYY-MM-DD HH:MM:SS" form.
const RUN_STARTED = '2026-10-02 09:14:03'
const GATE_REACHED = '2026-10-02 08:30:00'
const OLDER_RUN_ENDED = '2026-10-02 07:00:00'
const CREATED = '2026-10-01 12:00:00'
const utc = (sqliteTs) => Date.parse(`${sqliteTs.replace(' ', 'T')}Z`)

insertItem.run('S-RUN', 'Active run', IMPLEMENT_STEP_INDEX, 0, null, CREATED)
insertRun.run('S-RUN', IMPLEMENT_STEP_INDEX, 'active', RUN_STARTED, null)

insertItem.run('S-GATE', 'At a human gate', GATE_INDEX, 0, null, CREATED)
insertRun.run('S-GATE', GATE_INDEX - 2, 'done', '2026-10-02 06:00:00', OLDER_RUN_ENDED)
insertRun.run('S-GATE', GATE_INDEX - 1, 'done', '2026-10-02 08:00:00', GATE_REACHED)

insertItem.run('S-NORUNS', 'Created at a gate', GATE_INDEX, 0, null, CREATED)

insertItem.run('S-ACCEPT', 'Running pre-merge', ACCEPT_GATE_INDEX, 0, null, CREATED)
insertRun.run('S-ACCEPT', ACCEPT_GATE_INDEX - 1, 'done', '2026-10-02 08:00:00', GATE_REACHED)

insertItem.run('S-PAUSED', 'Paused mid-run', IMPLEMENT_STEP_INDEX, 1, null, CREATED)
insertRun.run('S-PAUSED', IMPLEMENT_STEP_INDEX, 'active', RUN_STARTED, null)

insertItem.run('S-CLOSED', 'Closed', STEPS.length, 0, null, CREATED)
insertRun.run('S-CLOSED', STEPS.length - 2, 'done', '2026-10-02 08:00:00', GATE_REACHED)

insertItem.run('S-ABANDONED', 'Abandoned at a gate', GATE_INDEX, 0, '2026-10-02 09:00:00', CREATED)
insertRun.run('S-ABANDONED', GATE_INDEX - 1, 'done', '2026-10-02 08:00:00', GATE_REACHED)

assert.ok(store.claimGateAction('S-ACCEPT', 'premerge', { timeoutMs: 60_000 }))
const actionStartedAt = db.prepare("SELECT started_at FROM gate_action WHERE item_id = 'S-ACCEPT'").get().started_at
assert.match(actionStartedAt, /Z$/)

const byId = (id) => store.listItems().find((it) => it.id === id)

test('an item with an active run reports the run start, as ISO UTC', () => {
  const since = byId('S-RUN').state_since
  assert.equal(since, '2026-10-02T09:14:03Z')
  assert.equal(Date.parse(since), utc(RUN_STARTED))
})

test('an item at a human gate reports the latest run end — when it reached the gate', () => {
  const since = byId('S-GATE').state_since
  assert.equal(Date.parse(since), utc(GATE_REACHED))
})

test('an item at a gate with no step runs falls back to created_at', () => {
  assert.equal(Date.parse(byId('S-NORUNS').state_since), utc(CREATED))
})

test('an item at Accept with a running gate action reports the action start, unchanged', () => {
  const item = byId('S-ACCEPT')
  assert.equal(item.gateAction.state, 'running')
  assert.equal(item.state_since, actionStartedAt)
  assert.ok(!item.state_since.endsWith('ZZ'))
})

test('paused, closed and abandoned items report null', () => {
  assert.equal(byId('S-PAUSED').state_since, null)
  assert.equal(byId('S-CLOSED').state_since, null)
  assert.equal(byId('S-ABANDONED').state_since, null)
})

test('deriving state_since writes nothing: no events, no updated_at change', () => {
  const snapshot = () => ({
    events: db.prepare('SELECT COUNT(*) AS n FROM event').get().n,
    items: db.prepare('SELECT id, updated_at, cursor, paused FROM work_item ORDER BY id').all(),
    runs: db.prepare('SELECT id, status, ended_at FROM step_run ORDER BY id').all(),
  })
  const before = snapshot()
  store.listItems()
  store.listItems({ scope: 'enabled' })
  assert.deepEqual(snapshot(), before)
})
