// HZ-271 guardrail: the hourly limit is counted from persisted actions, so a
// restart does not reset it. Each boot is its own node process on the same
// database FILE running the production boot step, failInterruptedActions(),
// then reading actionsInWindow — no in-memory state can carry over.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const ACTOR = fileURLToPath(new URL('../src/caretakerActor.js', import.meta.url))
const path = join(mkdtempSync(join(tmpdir(), 'horizon-caretaker-act-restart-')), 'test.db')
const NOW = Date.parse('2026-10-03T12:00:00Z')

function boot() {
  const env = { ...process.env, HORIZON_DB: path }
  for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_TOKEN']) delete env[key]
  const script = `const m = await import(${JSON.stringify(ACTOR)}); m.failInterruptedActions(); process.stdout.write(String(m.actionsInWindow(1, ${NOW})))`
  return Number(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString())
}

test('the hourly count survives two restarts, a mid-call action included', () => {
  assert.equal(boot(), 0) // creates the schema
  const db = new Database(path)
  db.prepare("INSERT INTO project (id, name, enabled, autopilot) VALUES (1, 'Restarted', 1, 'on')").run()
  const insertEval = db.prepare(
    "INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, reason) VALUES (?, 5, 0, 'on', 'approve', 'r')",
  )
  const insertAction = db.prepare(
    "INSERT INTO caretaker_action (eval_id, project_id, item_id, gate_index, action, outcome, acted_at_ms) VALUES (?, 1, ?, 5, 'approve', ?, ?)",
  )
  for (const [id, outcome, ago] of [['RA-1', 'ok', 10], ['RA-2', 'pending', 5], ['RA-3', 'dropped', 1], ['RA-4', 'ok', 61]]) {
    db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, 'fixture', 'High', 6, 1)").run(id)
    insertAction.run(insertEval.run(id).lastInsertRowid, id, outcome, NOW - ago * 60 * 1000)
  }
  db.close()

  assert.equal(boot(), 2, 'ok + interrupted count; dropped and out-of-window do not')
  assert.equal(boot(), 2)
  const check = new Database(path, { readonly: true })
  try {
    assert.equal(check.prepare("SELECT outcome FROM caretaker_action WHERE item_id = 'RA-2'").get().outcome, 'interrupted')
  } finally {
    check.close()
  }
})
