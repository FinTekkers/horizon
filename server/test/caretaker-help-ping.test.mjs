// HZ-274 metric 4: when the caretaker needs a human (a 'ping_human' decision
// at gates 5, 10 or 15 in an 'on' project), the owner gets one WhatsApp
// message naming the item and the gate — once per gate arrival. Repeat polls
// send nothing; leaving the gate and coming back sends exactly one more.
//
// Delivery is asserted on the mocked sender, not just outbox rows. The dedupe
// key lives in SQLite, so the restart case runs real node processes on one
// database file. The migration case rebuilds an HZ-272-era caretaker_ping.
// Numbers are fake; nothing is sent anywhere.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

globalThis.fetch = async () => {
  throw new Error('caretaker-help-ping test: no network')
}

const OWNER_NUMBER = '15550001111'
const ENV = {
  WA_NOTIFY_ENABLED: '1',
  // Two approvers; "the owner" is the first.
  WA_APPROVER_JIDS: `${OWNER_NUMBER},15550002222`,
  GITHUB_TOKEN: 'tok123secret',
}
const STRIP = ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'CARETAKER_HOURLY_LIMIT']

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-help-ping-')), 'test.db')
for (const key of STRIP) delete process.env[key]
Object.assign(process.env, ENV)

const { db } = await import('../src/db.js')
const actor = await import('../src/caretakerActor.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')

const OWNER = `${OWNER_NUMBER}@s.whatsapp.net`
const silent = { info() {}, warn() {}, error() {} }
const gateActions = {
  approve: async () => ({ ok: true }),
  sendBack: async () => ({ ok: true }),
}
let clock = Date.parse('2026-10-03T12:00:00Z')
const sent = []
const send = async (to, body) => {
  sent.push({ to, body })
}
const tick = () => actor.actOnDecisions({ gateActions, log: silent, now: () => clock, send })

let projectSeq = 0
const project = (autopilot = 'on') => {
  const id = Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, 1)').run(`Help ${++projectSeq}`).lastInsertRowid)
  db.prepare('UPDATE project SET autopilot = ? WHERE id = ?').run(autopilot, id)
  return id
}
const item = (id, projectId, gate) =>
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, ?, 'High', ?, ?)").run(id, `Fix ${id}`, gate - 1, projectId)
// What caretaker.js records for an arrival it cannot decide: a done run
// feeding the gate, the cursor on the gate, and a 'ping_human' eval.
const arriveNeedingHuman = (itemId, gate, { mode = 'on', reason = 'no rule matched; a human needs to look' } = {}) => {
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, ?, 'x', 'done', 'fixture')")
    .run(itemId, gate - 1).lastInsertRowid
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(gate, itemId)
  db.prepare(
    "INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, reason) VALUES (?, ?, ?, ?, 'ping_human', ?)",
  ).run(itemId, gate, runId, mode, reason)
}
const sentFor = (id) => sent.filter((s) => s.body.includes(` ${id} `))

test('one message to the owner per arrival, naming the item and the gate; repeat polls send nothing; a return sends exactly one more', async () => {
  const pid = project()
  item('HP-10', pid, 10)
  arriveNeedingHuman('HP-10', 10)
  await tick()
  assert.deepEqual(sentFor('HP-10'), [
    { to: OWNER, body: `Autopilot needs you: HP-10 "Fix HP-10" is waiting at step 10 (${STEPS[10].label}).` },
  ])

  for (let i = 0; i < 3; i++) await tick()
  assert.equal(sentFor('HP-10').length, 1, 'a repeat poll pinged again')

  // Sent back and re-arrived: a new done run, so a new arrival.
  db.prepare('UPDATE work_item SET cursor = 9 WHERE id = ?').run('HP-10')
  await tick()
  assert.equal(sentFor('HP-10').length, 1)
  arriveNeedingHuman('HP-10', 10)
  await tick()
  await tick()
  assert.equal(sentFor('HP-10').length, 2)
  assert.ok(sent.every((s) => s.to === OWNER), 'another approver was messaged')
})

test('a ping_human decision in a shadow or off project, or judged in shadow, sends nothing', async () => {
  for (const mode of ['shadow', 'off']) {
    const pid = project(mode)
    item(`HP-${mode}`, pid, 5)
    arriveNeedingHuman(`HP-${mode}`, 5, { mode: 'on' })
  }
  const pid = project('on')
  item('HP-shadow-era', pid, 5)
  arriveNeedingHuman('HP-shadow-era', 5, { mode: 'shadow' })
  await tick()
  for (const id of ['HP-shadow', 'HP-off', 'HP-shadow-era']) {
    assert.equal(sentFor(id).length, 0, id)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM caretaker_ping WHERE item_id = ? AND reason = 'needs_human'").get(id).n, 0, id)
  }
})

test('a help ping still waiting when Autopilot goes off is not sent', async () => {
  const pid = project()
  item('HP-late', pid, 15)
  arriveNeedingHuman('HP-late', 15)
  actor.queueHelpPings({ now: () => clock })
  db.prepare("UPDATE project SET autopilot = 'off' WHERE id = ?").run(pid)
  await tick()
  assert.equal(sentFor('HP-late').length, 0)
  assert.equal(db.prepare("SELECT status FROM caretaker_ping WHERE item_id = 'HP-late'").get().status, 'failed')
})

test('the body holds only the id, title, step and gate: no reason text, no secret, no owner number', async () => {
  const pid = project()
  item('HP-leak', pid, 5)
  arriveNeedingHuman('HP-leak', 5, { reason: 'artifact quoted tok123secret and a private note' })
  await tick()
  const [{ body }] = sentFor('HP-leak')
  assert.equal(body, `Autopilot needs you: HP-leak "Fix HP-leak" is waiting at step 5 (${STEPS[5].label}).`)
  for (const banned of ['tok123secret', 'private note', OWNER_NUMBER]) assert.ok(!body.includes(banned), banned)
})

// ---- across real restarts ----

const ACTOR = fileURLToPath(new URL('../src/caretakerActor.js', import.meta.url))
const DB = fileURLToPath(new URL('../src/db.js', import.meta.url))

function run(path, script) {
  const env = { ...process.env, ...ENV, HORIZON_DB: path }
  for (const key of STRIP) delete env[key]
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
}
// One process: one caretaker poll with a mocked sender; prints what it sent.
const bootTick = (path) =>
  JSON.parse(
    run(
      path,
      `
      const actor = await import(${JSON.stringify(ACTOR)})
      const sent = []
      const gateActions = { approve: async () => ({ ok: true }), sendBack: async () => ({ ok: true }) }
      await actor.actOnDecisions({ gateActions, log: { info() {}, warn() {}, error() {} }, send: async (to, body) => { sent.push({ to, body }) } })
      process.stdout.write(JSON.stringify(sent))`,
    ),
  )

test('a restart never repeats a help ping', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-help-ping-restart-')), 'test.db')
  run(path, `await import(${JSON.stringify(DB)})`)
  const file = new Database(path)
  file.prepare("INSERT INTO project (id, name, enabled, autopilot) VALUES (1, 'Restarted', 1, 'on')").run()
  file.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES ('RS-help', 'Restart', 'High', 10, 1)").run()
  const runId = file.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES ('RS-help', 9, 'x', 'done', 'f')").run().lastInsertRowid
  file
    .prepare("INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, reason) VALUES ('RS-help', 10, ?, 'on', 'ping_human', 'x')")
    .run(runId)
  file.close()

  assert.equal(bootTick(path).length, 1)
  assert.deepEqual(bootTick(path), [])
  assert.deepEqual(bootTick(path), [])
  const check = new Database(path, { readonly: true })
  try {
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM caretaker_ping WHERE reason = 'needs_human'").get().n, 1)
  } finally {
    check.close()
  }
})

test('migration: an HZ-272 caretaker_ping keeps every row column by column and then accepts needs_human', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-help-ping-migrate-')), 'test.db')
  run(path, `await import(${JSON.stringify(DB)})`)
  const file = new Database(path)
  assert.match(file.prepare("SELECT sql FROM sqlite_master WHERE name = 'caretaker_ping'").get().sql, /needs_human/, 'a fresh DB has the wide CHECK')
  // Put back the table as HZ-272 left it: gate-13 reasons, no needs_human.
  file.exec(`
    DROP TABLE caretaker_ping;
    CREATE TABLE caretaker_ping (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id         INTEGER NOT NULL REFERENCES project(id),
      item_id            TEXT REFERENCES work_item(id) ON DELETE CASCADE,
      reason             TEXT NOT NULL CHECK (reason IN ('hourly_limit','review_cycle_cap','step_failed_twice','premerge_blocked','premerge_failed','resolve_escalated','resolve_failed','accept_failed')),
      dedupe_key         TEXT NOT NULL UNIQUE,
      recipient          TEXT NOT NULL,
      body               TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
      attempts           INTEGER NOT NULL DEFAULT 0,
      last_error         TEXT,
      created_at_ms      INTEGER NOT NULL,
      next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
      sent_at            TEXT
    );
    CREATE INDEX idx_caretaker_ping_project ON caretaker_ping(project_id, reason, created_at_ms);
    INSERT INTO project (id, name) VALUES (1, 'Old');
    INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES ('OLD-1', 'fixture', 'High', 13, 1);
  `)
  assert.throws(() =>
    file
      .prepare("INSERT INTO caretaker_ping (project_id, item_id, reason, dedupe_key, recipient, body, created_at_ms) VALUES (1, 'OLD-1', 'needs_human', 'pre', 'a@s', 'b', 1)")
      .run(),
  )
  file
    .prepare(
      `INSERT INTO caretaker_ping (id, project_id, item_id, reason, dedupe_key, recipient, body, status, attempts, last_error, created_at_ms, next_attempt_at_ms, sent_at)
       VALUES (4, 1, 'OLD-1', 'premerge_blocked', 'g13:OLD-1:1:stop', 'a@s', 'body one', 'sent', 1, NULL, 111, 0, '2026-10-02 10:00:00'),
              (6, 1, NULL, 'hourly_limit', 'limit:1:222', 'a@s', 'body two', 'pending', 2, 'retry', 222, 999, NULL)`,
    )
    .run()
  const before = file.prepare('SELECT * FROM caretaker_ping ORDER BY id').all()
  file.close()

  run(path, `await import(${JSON.stringify(DB)})`)
  const after = new Database(path)
  try {
    assert.deepEqual(after.prepare('SELECT * FROM caretaker_ping ORDER BY id').all(), before)
    after
      .prepare("INSERT INTO caretaker_ping (project_id, item_id, reason, dedupe_key, recipient, body, created_at_ms) VALUES (1, 'OLD-1', 'needs_human', 'help:1', 'a@s', 'b', 1)")
      .run()
    assert.ok(after.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_caretaker_ping_project'").get())
  } finally {
    after.close()
  }
})
