// HZ-270 metric 1: each project's Autopilot setting, driven through the real
// Fastify app. The database is created in the pre-HZ-270 shape first, so the
// migration is exercised on real existing rows: they all come out 'off'.
//
// Changing it is gate-grade: a browser session plus the gate PIN. A missing or
// wrong PIN is 401 and changes nothing; a real change writes exactly one
// project_event with the old value, the new value and the project. The PIN
// never reaches the logs or the audit rows.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-autopilot-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const old = new Database(process.env.HORIZON_DB)
old.exec(`
  CREATE TABLE project (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 0);
  INSERT INTO project (name, enabled) VALUES ('Horizon', 1), ('FinTekkers', 0);
`)
old.close()

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')

const lines = []
const app = buildApp({ logger: { level: 'trace', stream: { write: (line) => lines.push(line) } } })
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
await app.ready()

const HORIZON = 1
const modeOf = (id) => db.prepare('SELECT autopilot FROM project WHERE id = ?').get(id).autopilot
const eventsOf = (id) => db.prepare('SELECT * FROM project_event WHERE project_id = ? ORDER BY id').all(id)
const post = (id, payload, headers = {}) =>
  app.inject({ method: 'POST', url: `/api/projects/${id}/autopilot`, payload, headers })
const asSession = (pin) => ({ cookie: alice.cookie, ...(pin === undefined ? {} : { 'x-human-key': pin }) })

test('existing projects migrate to off, and a new project starts off', () => {
  assert.deepEqual(db.prepare('SELECT name, autopilot FROM project ORDER BY id').all(), [
    { name: 'Horizon', autopilot: 'off' },
    { name: 'FinTekkers', autopilot: 'off' },
  ])
  const created = store.createProject('Brand New')
  assert.equal(modeOf(created.id), 'off')
  assert.equal(store.listProjects().find((p) => p.id === created.id).autopilot, 'off')
})

for (const [name, headers] of [
  ['a missing PIN', asSession()],
  ['a wrong PIN', asSession('0000-wrong')],
]) {
  test(`${name} is 401 and leaves the value and the audit trail unchanged`, async () => {
    const before = eventsOf(HORIZON).length
    const res = await post(HORIZON, { mode: 'shadow' }, headers)
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: 'human_gate_key_required' })
    assert.equal(modeOf(HORIZON), 'off')
    assert.equal(eventsOf(HORIZON).length, before)
  })
}

test('a mode outside off/shadow/on is 400 and records nothing', async () => {
  const before = eventsOf(HORIZON).length
  const res = await post(HORIZON, { mode: 'auto' }, asSession(alice.pin))
  assert.equal(res.statusCode, 400)
  assert.equal(modeOf(HORIZON), 'off')
  assert.equal(eventsOf(HORIZON).length, before)
})

test('the right PIN changes the mode and records one event with old, new and project', async () => {
  const before = eventsOf(HORIZON).length
  const res = await post(HORIZON, { mode: 'shadow' }, asSession(alice.pin))
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { ok: true, projectId: HORIZON, old: 'off', new: 'shadow' })
  assert.equal(modeOf(HORIZON), 'shadow')
  const events = eventsOf(HORIZON)
  assert.equal(events.length, before + 1)
  const [event] = events.slice(-1)
  assert.equal(event.project_id, HORIZON)
  assert.equal(event.kind, 'autopilot')
  assert.equal(event.old_value, 'off')
  assert.equal(event.new_value, 'shadow')
  assert.equal(event.who, 'Alice Example')
  // The other project is untouched.
  assert.equal(modeOf(2), 'off')
})

test('setting the same value again is ok, unchanged, and records no event', async () => {
  const before = eventsOf(HORIZON).length
  const res = await post(HORIZON, { mode: 'shadow' }, asSession(alice.pin))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, projectId: HORIZON, old: 'shadow', new: 'shadow', unchanged: true })
  assert.equal(eventsOf(HORIZON).length, before)
})

test('an unknown project is 404', async () => {
  const res = await post(999, { mode: 'on' }, asSession(alice.pin))
  assert.equal(res.statusCode, 404)
})

test('the snapshot carries autopilot and the latest changes for Admin', async () => {
  await post(HORIZON, { mode: 'on' }, asSession(alice.pin))
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: alice.cookie } })
  const project = res.json().projects.find((p) => p.id === HORIZON)
  assert.equal(project.autopilot, 'on')
  assert.deepEqual(
    project.autopilotEvents.map((e) => [e.old, e.new, e.who]),
    [
      ['shadow', 'on', 'Alice Example'],
      ['off', 'shadow', 'Alice Example'],
    ],
  )
})

test('the PIN never appears in the logs or in project_event rows, for a 401 or a 200', async () => {
  await post(HORIZON, { mode: 'off' }, asSession('9999-not-the-pin'))
  await post(HORIZON, { mode: 'off' }, asSession(alice.pin))
  assert.equal(modeOf(HORIZON), 'off')
  assert.ok(lines.length > 0, 'the capturing logger saw nothing — the check would be vacuous')
  const logged = lines.join('\n')
  assert.ok(!logged.includes(alice.pin), 'the gate PIN reached the logs')
  assert.ok(!logged.includes('9999-not-the-pin'), 'a wrong PIN reached the logs')
  const rows = JSON.stringify(db.prepare('SELECT * FROM project_event').all())
  assert.ok(!rows.includes(alice.pin))
  assert.ok(!rows.includes('9999-not-the-pin'))
})
