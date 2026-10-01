// HZ-141 success metric 2b: "a restart of the server while waiting does not
// [resend]."
//
// This has to be a REAL SECOND PROCESS. The obvious version — await import()ing
// db.js and gateNotifier.js again in the same test process — proves nothing: ESM
// caches modules, so the second import returns the same objects, and the test
// would pass with notified_step deleted from the schema entirely. So the sweep
// below runs in a child, against the same HORIZON_DB file, with a fresh module
// graph and a fresh better-sqlite3 handle — which is exactly what a systemctl
// restart gives you.
//
// spawnSync + --input-type=module follows check-required-input-gate.test.mjs.
//
// Guard against the opposite vacuity too: a child that crashes on import, or
// that silently swept nothing, would also report "no new rows". So the child
// prints what it did and the parent asserts it ran AND that a deliberately
// un-notified item in the same database DOES get picked up by that same child.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { REPO_ROOT } from './helpers/repoFiles.mjs'

const DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-gatenotify-restart-')), 'test.db')
const APPROVER = '15550001111@s.whatsapp.net'

process.env.HORIZON_DB = DB_PATH
process.env.WA_APPROVER_JIDS = APPROVER

const { db } = await import('../src/db.js')
const notifier = await import('../src/gateNotifier.js')
const { gateStepIndexes } = await import('../../domain/js/lifecycle.js')

const GATE = gateStepIndexes()[0]
const LATER_GATE = gateStepIndexes()[1]

// Sweeps in a child process, reporting the counts it observed. Deliberately
// imports through the real db.js, so the child sees whatever schema and
// migrations the server itself creates.
function sweepInChild() {
  const script = `
    const { sweepGates } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/src/gateNotifier.js'))})
    const { db } = await import(${JSON.stringify(path.join(REPO_ROOT, 'server/src/db.js'))})
    const result = sweepGates()
    const total = db.prepare('SELECT COUNT(*) AS n FROM gate_notice').get().n
    console.log(JSON.stringify({ ...result, total }))
  `
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, HORIZON_DB: DB_PATH, WA_APPROVER_JIDS: APPROVER },
  })
  assert.equal(res.status, 0, `child sweep failed:\n${res.stdout}${res.stderr}`)
  return JSON.parse(res.stdout.trim().split('\n').at(-1))
}

const noticeCount = () => db.prepare('SELECT COUNT(*) AS n FROM gate_notice').get().n

test('a restart while an item is parked at a gate re-sends nothing', () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
    'T-PARKED',
    'Parked at a gate across a restart',
    'High',
    GATE,
  )
  notifier.sweepGates()
  assert.equal(noticeCount(), 1, 'the first arrival must have queued exactly one notification')
  assert.equal(db.prepare("SELECT notified_step FROM work_item WHERE id = 'T-PARKED'").get().notified_step, GATE)

  // Three restarts, not one: a bug that re-notifies would do it every boot, and
  // a bug that notifies on the SECOND boot only would survive a single check.
  for (let boot = 1; boot <= 3; boot++) {
    const child = sweepInChild()
    assert.equal(child.enqueued, 0, `boot ${boot} re-notified a gate it was already parked at`)
    assert.equal(child.total, 1, `boot ${boot} changed the outbox`)
  }
  assert.equal(noticeCount(), 1)
})

test('the same child sweep DOES notify an item that has not been notified — the check above is not vacuous', () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor) VALUES (?, ?, ?, ?)').run(
    'T-FRESH',
    'Arrived while the server was down',
    'High',
    LATER_GATE,
  )
  const child = sweepInChild()
  assert.equal(child.enqueued, 1, 'the child sweep never enqueues anything — every assertion above is vacuous')
  assert.equal(child.total, 2)
  // And the parent, on its own handle, sees the row the child wrote.
  assert.equal(noticeCount(), 2)
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM gate_notice WHERE item_id = ?').get('T-FRESH').n,
    1,
  )
})

test('rows left mid-send by a crash are failed on the next boot, not resent', () => {
  db.prepare("UPDATE gate_notice SET status = 'sending' WHERE item_id = 'T-PARKED'").run()
  const changed = notifier.failInterruptedSends()
  assert.equal(changed, 1)
  const row = db.prepare("SELECT * FROM gate_notice WHERE item_id = 'T-PARKED'").get()
  assert.equal(row.status, 'failed')
  assert.match(row.last_error, /interrupted/)
  // 'failed' is terminal: a drain must not pick it back up.
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gate_notice WHERE status = 'pending' AND item_id = 'T-PARKED'").get().n,
    0,
  )
})
