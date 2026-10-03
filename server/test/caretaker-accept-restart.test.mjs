// HZ-272 guardrails across real restarts. Each boot is its own node process on
// the same database FILE, running the production boot (caretakerActor.init,
// which sweeps interrupted claims, then runs a pass) with gateActions stubs
// that never finish — so nothing in memory can carry over between boots.
//
// Also the caretaker_ping rebuild: a DB whose table predates the gate-13 stop
// reasons keeps every row and accepts the new ones.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const ACTOR = fileURLToPath(new URL('../src/caretakerActor.js', import.meta.url))
const DB = fileURLToPath(new URL('../src/db.js', import.meta.url))
const NOW = Date.parse('2026-10-03T12:00:00Z')

function run(path, script, { notify = true } = {}) {
  const env = { ...process.env, HORIZON_DB: path, WA_APPROVER_JIDS: '15550001111' }
  for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_TOKEN', 'CARETAKER_HOURLY_LIMIT', 'WA_NOTIFY_ENABLED']) delete env[key]
  if (notify) env.WA_NOTIFY_ENABLED = '1'
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
}

// One production boot: init, let its first passes run, report what it did.
function boot(path, opts) {
  const script = `
    const actor = await import(${JSON.stringify(ACTOR)})
    const calls = []
    const never = () => new Promise(() => {})
    const gateActions = {
      approve: (...args) => { calls.push(['approve', ...args]); return never() },
      sendBack: (...args) => { calls.push(['sendBack', ...args]); return never() },
      resolveConflicts: (...args) => { calls.push(['resolveConflicts', ...args]); return never() },
    }
    const sent = []
    const silent = { info() {}, warn() {}, error() {} }
    const handle = actor.init(silent, { gateActions, now: () => ${NOW}, send: async (to, body) => { sent.push(body) } })
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve))
    handle.stop()
    process.stdout.write(JSON.stringify({ calls, sent }))
    process.exit(0)`
  return JSON.parse(run(path, script, opts))
}

test('a restart never repeats an Accept, a Resolve-conflicts run or an owner ping', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-caretaker-accept-restart-')), 'test.db')
  run(path, `await import(${JSON.stringify(DB)})`) // creates the schema
  const db = new Database(path)
  db.prepare("INSERT INTO project (id, name, enabled, autopilot) VALUES (1, 'Restarted', 1, 'on')").run()
  const item = db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, project_id, repo, pr, pr_mergeable) VALUES (?, 'fixture', 'High', 13, 1, 'Acme/r', ?, ?)",
  )
  const review = db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES (?, 12, 'review', 'done', 'passed')")
  item.run('RS-acc', 1, 1) // clean: Accept
  review.run('RS-acc')
  item.run('RS-res', 2, 0) // conflicted: Resolve conflicts
  review.run('RS-res')
  item.run('RS-blk', 3, 1) // pre-merge already blocked for this review: stop
  const arrival = review.run('RS-blk').lastInsertRowid
  db.prepare(
    `INSERT INTO gate_action (item_id, kind, state, run_token, epoch, started_at, deadline_at, finished_at, started_by)
     VALUES ('RS-blk', 'premerge', 'blocked', 't', ?, '2026-10-03T11:00:00Z', '2026-10-03T11:30:00Z', '2026-10-03T11:10:00Z', 'human')`,
  ).run(`0:${arrival}`)
  db.close()

  // Boot 1: the notifier is off, so its ping waits; both calls never return.
  const first = boot(path, { notify: false })
  assert.deepEqual(first.calls.map((c) => [c[0], c[1]]).sort(), [['approve', 'RS-acc'], ['resolveConflicts', 'RS-res']])
  assert.deepEqual(first.sent, [])

  // Boot 2: both mid-call claims are interrupted, never retried; each item is
  // pinged once, and boot 1's waiting ping goes out once.
  const second = boot(path)
  assert.deepEqual(second.calls, [])
  assert.equal(second.sent.length, 3)
  for (const id of ['RS-acc', 'RS-res', 'RS-blk']) assert.equal(second.sent.filter((b) => b.includes(` on ${id} `)).length, 1, id)

  const third = boot(path)
  assert.deepEqual(third, { calls: [], sent: [] })

  const check = new Database(path, { readonly: true })
  try {
    assert.deepEqual(
      check.prepare('SELECT item_id, action, outcome FROM caretaker_accept_action ORDER BY item_id').all(),
      [
        { item_id: 'RS-acc', action: 'accept', outcome: 'interrupted' },
        { item_id: 'RS-res', action: 'resolve', outcome: 'interrupted' },
      ],
    )
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM event WHERE who = 'Caretaker' AND text LIKE 'caretaker stopped%'").get().n, 3)
  } finally {
    check.close()
  }
})

test('migration: an old caretaker_ping keeps its rows column by column and accepts the gate-13 reasons; a second boot changes nothing', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-caretaker-ping-migrate-')), 'test.db')
  run(path, `await import(${JSON.stringify(DB)})`)
  const db = new Database(path)
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'caretaker_ping'").get().sql, /premerge_blocked/, 'a fresh DB has the wide CHECK')
  // Put back the table as HZ-271 created it.
  db.exec(`
    DROP TABLE caretaker_ping;
    CREATE TABLE caretaker_ping (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id         INTEGER NOT NULL REFERENCES project(id),
      item_id            TEXT REFERENCES work_item(id) ON DELETE CASCADE,
      reason             TEXT NOT NULL CHECK (reason IN ('hourly_limit','review_cycle_cap','step_failed_twice')),
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
    INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES ('OLD-1', 'fixture', 'High', 10, 1);
  `)
  db.prepare(
    `INSERT INTO caretaker_ping (id, project_id, item_id, reason, dedupe_key, recipient, body, status, attempts, last_error, created_at_ms, next_attempt_at_ms, sent_at)
     VALUES (7, 1, 'OLD-1', 'review_cycle_cap', 'stall:OLD-1', 'a@s', 'body one', 'sent', 1, NULL, 111, 0, '2026-10-02 10:00:00'),
            (9, 1, NULL, 'hourly_limit', 'limit:1:222', 'a@s', 'body two', 'failed', 3, 'gave up', 222, 999, NULL)`,
  ).run()
  const before = db.prepare('SELECT * FROM caretaker_ping ORDER BY id').all()
  db.close()

  run(path, `await import(${JSON.stringify(DB)})`)
  const after = new Database(path)
  const schema = () => after.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'caretaker_ping' ORDER BY name").all()
  try {
    assert.deepEqual(after.prepare('SELECT * FROM caretaker_ping ORDER BY id').all(), before)
    after
      .prepare(
        "INSERT INTO caretaker_ping (project_id, item_id, reason, dedupe_key, recipient, body, created_at_ms) VALUES (1, 'OLD-1', 'premerge_blocked', 'g13:x', 'a@s', 'b', 1)",
      )
      .run()
    assert.ok(schema().some((row) => row.name === 'idx_caretaker_ping_project'))
    const migrated = schema()
    after.close()
    run(path, `await import(${JSON.stringify(DB)})`)
    const again = new Database(path, { readonly: true })
    try {
      assert.deepEqual(again.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'caretaker_ping' ORDER BY name").all(), migrated)
      assert.equal(again.prepare('SELECT COUNT(*) AS n FROM caretaker_ping').get().n, 3)
    } finally {
      again.close()
    }
  } finally {
    if (after.open) after.close()
  }
})
