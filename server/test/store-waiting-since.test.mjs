// HZ-443: listItems' waiting_since — when an item started waiting on a human
// (at a gate, rule-blocked or paused), for the board's Waiting on me filter
// and sort — and paused_at, which every pause path writes once per pause.
// Its own process, so its own temp DB.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-waiting-since-')), 'test.db')
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { STEPS, IMPLEMENT_STEP_INDEX, ACCEPT_GATE_INDEX, EXECUTE_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const GATE_INDEX = IMPLEMENT_STEP_INDEX - 1
assert.equal(STEPS[GATE_INDEX].kind, 'gate')

const insertItem = db.prepare(
  "INSERT INTO work_item (id, title, priority, cursor, paused, paused_at, rule_block_json, created_at) VALUES (?, ?, 'Medium', ?, ?, ?, ?, ?)",
)
const insertRun = db.prepare(
  "INSERT INTO step_run (item_id, step_index, agent, status, started_at, ended_at) VALUES (?, ?, 'Eng', ?, ?, ?)",
)

const CREATED = '2026-10-01 12:00:00'
const GATE_REACHED = '2026-10-02 08:30:00'
const PAUSED_AT = '2026-10-02 07:15:00'
const BLOCKED_AT = '2026-10-02 06:45:00'
const utc = (sqliteTs) => Date.parse(`${sqliteTs.replace(' ', 'T')}Z`)
const ruleBlock = JSON.stringify({ rule: 'a rule', needs: 'a release', runId: 1, blockedAt: BLOCKED_AT })

insertItem.run('W-GATE', 'At a gate', GATE_INDEX, 0, null, null, CREATED)
insertRun.run('W-GATE', GATE_INDEX - 1, 'done', '2026-10-02 08:00:00', GATE_REACHED)
insertItem.run('W-RULE', 'Rule-blocked', IMPLEMENT_STEP_INDEX, 0, null, ruleBlock, CREATED)
insertItem.run('W-PAUSED', 'Paused', IMPLEMENT_STEP_INDEX, 1, PAUSED_AT, null, CREATED)
insertItem.run('W-RUNNING', 'Agent running', IMPLEMENT_STEP_INDEX, 0, null, null, CREATED)
insertRun.run('W-RUNNING', IMPLEMENT_STEP_INDEX, 'active', '2026-10-02 09:00:00', null)
insertItem.run('W-ACCEPT', 'Merge running at Accept', ACCEPT_GATE_INDEX, 0, null, null, CREATED)
insertRun.run('W-ACCEPT', ACCEPT_GATE_INDEX - 1, 'done', '2026-10-02 08:00:00', GATE_REACHED)
insertItem.run('W-CLOSED-PAUSED', 'Closed', STEPS.length, 1, PAUSED_AT, null, CREATED)
// A resumed item keeps a stale paused_at; it must never be read.
insertItem.run('W-RESUMED', 'Resumed', IMPLEMENT_STEP_INDEX, 0, PAUSED_AT, null, CREATED)

const byId = (id) => store.listItems().find((it) => it.id === id)
const pausedAtOf = (id) => db.prepare('SELECT paused_at FROM work_item WHERE id = ?').get(id).paused_at

test('a gate item waits from when it reached the gate', () => {
  assert.equal(Date.parse(byId('W-GATE').waiting_since), utc(GATE_REACHED))
})

test('a rule-blocked item waits from the block', () => {
  assert.equal(Date.parse(byId('W-RULE').waiting_since), utc(BLOCKED_AT))
})

test('a paused item waits from its pause, and carries paused_at', () => {
  const item = byId('W-PAUSED')
  assert.equal(Date.parse(item.waiting_since), utc(PAUSED_AT))
  assert.equal(item.paused_at, item.waiting_since)
})

test('a running agent, a closed item and a resumed item are not waiting', () => {
  assert.equal(byId('W-RUNNING').waiting_since, null)
  assert.equal(byId('W-CLOSED-PAUSED').waiting_since, null)
  assert.equal(byId('W-RESUMED').waiting_since, null)
  assert.equal(byId('W-RESUMED').paused_at, null)
})

test('a running gate action at Accept does not restart the wait, and state_since is unchanged', () => {
  assert.ok(store.claimGateAction('W-ACCEPT', 'premerge', { timeoutMs: 60_000 }))
  const item = byId('W-ACCEPT')
  assert.equal(Date.parse(item.waiting_since), utc(GATE_REACHED))
  assert.notEqual(Date.parse(item.state_since), utc(GATE_REACHED))
})

test('setPaused sets paused_at on a fresh pause, and a repeat pause keeps the first', () => {
  insertItem.run('W-SET', 'Pause me', IMPLEMENT_STEP_INDEX, 0, null, null, CREATED)
  const before = Date.now()
  assert.deepEqual(store.setPaused('W-SET', true), { ok: true, paused: true })
  const first = Date.parse(byId('W-SET').waiting_since)
  assert.ok(first >= before - 2000 && first <= Date.now() + 1000, 'paused_at is the moment of the pause')

  db.prepare('UPDATE work_item SET paused_at = ? WHERE id = ?').run(PAUSED_AT, 'W-SET')
  store.setPaused('W-SET', true)
  assert.equal(pausedAtOf('W-SET'), PAUSED_AT)
  assert.equal(Date.parse(byId('W-SET').waiting_since), utc(PAUSED_AT))

  // Resume then pause again: a new pause, a new time.
  store.setPaused('W-SET', false)
  store.setPaused('W-SET', true)
  assert.notEqual(pausedAtOf('W-SET'), PAUSED_AT)
})

test('stopJob (an orchestrator pause site) sets paused_at, and keeps the first on a repeat pause', async () => {
  const seed = (id, paused, pausedAt) => {
    db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, paused, paused_at) VALUES (?, ?, 'Medium', ?, 'task', ?, ?)").run(
      id,
      `Task ${id}`,
      EXECUTE_STEP_INDEX,
      paused,
      pausedAt,
    )
    db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')").run(
      id,
      EXECUTE_STEP_INDEX,
      STEPS[EXECUTE_STEP_INDEX].agent,
    )
  }
  seed('W-STOP', 0, null)
  assert.equal((await orchestrator.stopJob('W-STOP')).paused, true)
  assert.ok(pausedAtOf('W-STOP'), 'a stopped run pauses with a time')
  assert.ok(byId('W-STOP').waiting_since)

  seed('W-STOP-AGAIN', 1, PAUSED_AT)
  await orchestrator.stopJob('W-STOP-AGAIN')
  assert.equal(pausedAtOf('W-STOP-AGAIN'), PAUSED_AT)
})

test('every pause path writes PAUSE_SET — no raw `paused = 1` is left in server/src', () => {
  const srcDir = new URL('../src/', import.meta.url)
  const sources = readdirSync(srcDir).filter((f) => f.endsWith('.js'))
  for (const file of sources) {
    const text = readFileSync(new URL(file, srcDir), 'utf8')
    assert.doesNotMatch(text, /SET\s+paused\s*=\s*1/i, `${file} pauses without PAUSE_SET`)
  }
  const orchestratorSrc = readFileSync(new URL('orchestrator.js', srcDir), 'utf8')
  // Lane plan-section check, deploy verification failed, retry budget
  // exhausted, stopJob, and a failed server step (HZ-446).
  assert.equal(orchestratorSrc.match(/SET \$\{PAUSE_SET\}/g)?.length, 5)
  const storeSrc = readFileSync(new URL('store.js', srcDir), 'utf8')
  assert.match(storeSrc, /const pausedSet = paused \? PAUSE_SET :/)
})

test('the one-time backfill gives an already-paused row its newest pause event, else updated_at', async () => {
  insertItem.run('W-LEGACY', 'Paused before paused_at', IMPLEMENT_STEP_INDEX, 1, null, null, CREATED)
  const addEvent = db.prepare("INSERT INTO event (item_id, who, text, color, initials, created_at) VALUES (?, 'Horizon', ?, '#000', 'HZ', ?)")
  addEvent.run('W-LEGACY', 'agent step failed: boom — item paused; resume to retry', '2026-10-02 05:00:00')
  addEvent.run('W-LEGACY', 'paused agent work on this item', '2026-10-02 05:30:00')
  addEvent.run('W-LEGACY', 'a comment', '2026-10-02 06:00:00')
  insertItem.run('W-LEGACY-NOEVENT', 'Paused, no event', IMPLEMENT_STEP_INDEX, 1, null, null, CREATED)
  db.prepare("UPDATE work_item SET updated_at = '2026-10-02 04:00:00' WHERE id = 'W-LEGACY-NOEVENT'").run()

  // A second load of db.js is a server restart: its migrations run again.
  await import('../src/db.js?restart')

  assert.equal(pausedAtOf('W-LEGACY'), '2026-10-02 05:30:00')
  assert.equal(pausedAtOf('W-LEGACY-NOEVENT'), '2026-10-02 04:00:00')
  assert.equal(pausedAtOf('W-PAUSED'), PAUSED_AT, 'a row that already has paused_at is untouched')
})
