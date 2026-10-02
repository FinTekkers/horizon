// HZ-270 guardrail: a caretaker error never blocks, delays or changes the
// human gate flow. Here the role file is MISSING — HORIZON_FARM_DIR points at
// an empty directory — so every judgement fails. init() must not throw, each
// arrival records one 'wait' with the error, a warning is logged, and a human
// approving a gate through the real route still gets a 200 and moves on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const dir = mkdtempSync(join(tmpdir(), 'horizon-caretaker-errors-'))
process.env.HORIZON_DB = join(dir, 'test.db')
process.env.HORIZON_FARM_DIR = join(dir, 'empty-farm')
mkdirSync(process.env.HORIZON_FARM_DIR)
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const caretaker = await import('../src/caretaker.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
await app.ready()

const pid = Number(db.prepare("INSERT INTO project (name, enabled, autopilot) VALUES ('Broken policy', 1, 'shadow')").run().lastInsertRowid)
db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES ('BP-15', 'fixture', 'High', 15, ?)").run(pid)
db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, output) VALUES ('BP-15', 14, 'DevOps', 'done', 'deployed')").run()

const warnings = []
const log = { warn: (m) => warnings.push(m), error: (m) => warnings.push(m) }
const caretakerEvents = () => db.prepare("SELECT text FROM event WHERE item_id = 'BP-15' AND who = 'Caretaker'").all()

test('a missing role file: init() does not throw, logs, and records one wait with the error', () => {
  assert.doesNotThrow(() => caretaker.init(log))
  const events = caretakerEvents()
  assert.equal(events.length, 1)
  assert.match(events[0].text, /^caretaker would wait — caretaker error: policy unavailable: farm\/roles\/caretaker\.md is missing/)
  assert.ok(warnings.some((w) => /policy could not be loaded/.test(w)), warnings.join('\n'))
})

test('a human approving the gate while the caretaker fails still gets 200 and the cursor advances', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/items/BP-15/gates/15/approve',
    payload: {},
    headers: { cookie: alice.cookie, 'x-human-key': alice.pin },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'BP-15'").get().cursor, 16)
  assert.equal(caretakerEvents().length, 1, 'the approval must not add a caretaker event')
})

test('a bad caretaker-rules block is the same: one wait per arrival, no throw', () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES ('BP-5', 'fixture', 'High', 5, ?)").run(pid)
  const bad = () => {
    throw new SyntaxError('Unexpected token b in JSON')
  }
  assert.doesNotThrow(() => caretaker.sweepCaretaker({ log, policy: bad }))
  const rows = db.prepare("SELECT decision, reason FROM caretaker_eval WHERE item_id = 'BP-5'").all()
  assert.deepEqual(rows, [{ decision: 'wait', reason: 'caretaker error: policy unavailable: Unexpected token b in JSON' }])
})
