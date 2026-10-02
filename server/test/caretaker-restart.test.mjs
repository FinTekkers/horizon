// HZ-270 metric 2 / guardrail: "once per arrival" survives a real restart.
// Each boot is its own node process on the same database FILE, running the
// production entry point caretaker.init() — no module cache or in-memory state
// can carry over, so only the persisted caretaker_eval row stops a second event.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const CARETAKER = fileURLToPath(new URL('../src/caretaker.js', import.meta.url))
const DB_MODULE = fileURLToPath(new URL('../src/db.js', import.meta.url))
const path = join(mkdtempSync(join(tmpdir(), 'horizon-caretaker-restart-')), 'test.db')

function boot(module, body = '') {
  const env = { ...process.env, HORIZON_DB: path }
  for (const key of ['FARM_HOME', 'FARM_URL', 'HORIZON_REPO', 'GITHUB_TOKEN']) delete env[key]
  const script = `const m = await import(${JSON.stringify(module)}); ${body}`
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] })
}

const caretakerEvents = () => {
  const db = new Database(path, { readonly: true })
  try {
    return db.prepare("SELECT text FROM event WHERE item_id = 'RS-5' AND who = 'Caretaker'").all()
  } finally {
    db.close()
  }
}

test('two boots in two processes record one event for one arrival', () => {
  boot(DB_MODULE)
  const db = new Database(path)
  const pid = db.prepare("INSERT INTO project (name, enabled, autopilot) VALUES ('Restarted', 1, 'shadow')").run().lastInsertRowid
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES ('RS-5', 'fixture', 'High', 5, ?)").run(pid)
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, agent, status, artifact) VALUES ('RS-5', 4, 'Ensemble', 'done', '## Recommendation\n**Choose B.**\n')",
  ).run()
  db.close()

  boot(CARETAKER, 'm.init({ warn() {}, error() {} })')
  assert.deepEqual(caretakerEvents(), [{ text: 'caretaker would approve — recommended option B' }])

  boot(CARETAKER, 'm.init({ warn() {}, error() {} })')
  assert.equal(caretakerEvents().length, 1, 'the second boot re-judged an arrival it had already recorded')
})
