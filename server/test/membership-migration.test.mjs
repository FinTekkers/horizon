// HZ-654: the membership migration on a database as the previous release left
// it. Every work_item ends on a project (its repo's, else an enabled
// `Unlinked items`), roles come from ADMIN_EMAIL / ADMIN_EMAILS, every user
// joins every project with the old global active project, and no table loses
// a row. It runs once, in one transaction: a second boot changes nothing, a
// failure leaves the database as it was, and later boots never re-add members
// or overwrite a user's active project.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const DB_MODULE = fileURLToPath(new URL('../src/db.js', import.meta.url))
const MEMBERSHIP_COLUMNS = ['role', 'active_project_id', 'disabled_at', 'credentials_valid_after']

// Each boot is its own process, the way the server opens the DB.
function boot(path, env = {}) {
  const base = { ...process.env, HORIZON_DB: path }
  for (const key of ['HORIZON_REPO', 'ADMIN_EMAIL', 'ADMIN_EMAILS', 'FARM_HOME']) delete base[key]
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(DB_MODULE)})`], {
    env: { ...base, ...env },
    stdio: 'pipe',
  })
}

const freshPath = () => join(mkdtempSync(join(tmpdir(), 'horizon-membership-')), 'test.db')

// A database as the previous release left it: no membership columns, table or
// settings, no `Unlinked items`, and these rows:
//   HZ-1  FinTekkers/horizon, already on Horizon
//   HZ-2  FinTekkers/horizon, NULL -> Horizon (from project_repo)
//   LS-1  FinTekkers/ledger, NULL -> Ledger (from project_repo, though Ledger is disabled)
//   OR-1  Other/orphan, a repo in no project, NULL -> Unlinked items
//   LOC-1 no repo, NULL -> Unlinked items
function oldDb({ active = 'Horizon', keepMemberTable = false } = {}) {
  const path = freshPath()
  boot(path)
  const db = new Database(path)
  db.exec(`
    DELETE FROM work_item WHERE id LIKE 'BF-%';
    DELETE FROM project WHERE id = (SELECT CAST(value AS INTEGER) FROM setting WHERE key = 'unlinked_project_id');
    DELETE FROM setting WHERE key IN ('unlinked_project_id', 'membership_v1');
    DROP TABLE project_member;
  `)
  for (const column of MEMBERSHIP_COLUMNS) db.exec(`ALTER TABLE user DROP COLUMN ${column}`)
  if (keepMemberTable) {
    db.exec(`CREATE TABLE project_member (
      project_id INTEGER NOT NULL REFERENCES project(id),
      user_id    TEXT    NOT NULL REFERENCES user(id),
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, user_id)
    )`)
  }
  const project = (name, enabled) => Number(db.prepare('INSERT INTO project (name, enabled) VALUES (?, ?)').run(name, enabled).lastInsertRowid)
  const horizon = project('Horizon', 1)
  const ledger = project('Ledger', 0)
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'FinTekkers/horizon', 'HZ')").run(horizon)
  db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'FinTekkers/ledger', 'LS')").run(ledger)
  if (active) {
    const id = active === 'Horizon' ? horizon : ledger
    db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES ('active_project_id', ?)").run(String(id))
  } else {
    db.exec("DELETE FROM setting WHERE key = 'active_project_id'")
  }
  const item = db.prepare("INSERT INTO work_item (id, title, priority, cursor, repo, project_id) VALUES (?, ?, 'Medium', 3, ?, ?)")
  item.run('HZ-1', 'Linked', 'FinTekkers/horizon', horizon)
  item.run('HZ-2', 'Repo in Horizon', 'FinTekkers/horizon', null)
  item.run('LS-1', 'Repo in Ledger', 'FinTekkers/ledger', null)
  item.run('OR-1', 'Repo in no project', 'Other/orphan', null)
  item.run('LOC-1', 'Local item', null, null)
  db.prepare("INSERT INTO event (item_id, who, text, color, initials) VALUES ('LOC-1', 'You', 'history', '#000', 'YO')").run()
  const user = db.prepare("INSERT INTO user (id, email, name, initials, auth_method, gate_pin_hash) VALUES (?, ?, ?, 'XX', 'password', 'salt:hash')")
  user.run('u-owner', 'Owner@Example.com', 'Owner')
  user.run('u-alice', 'alice@example.com', 'Alice')
  user.run('u-bob', 'bob@example.com', 'Bob')
  db.close()
  return { path, horizon, ledger }
}

function open(path, fn) {
  const db = new Database(path, { readonly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

const tableNames = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name)

function counts(path) {
  return open(path, (db) => Object.fromEntries(tableNames(db).map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n])))
}

// Every table's schema and rows, for "nothing changed".
function hashes(path) {
  return open(path, (db) =>
    Object.fromEntries(
      tableNames(db).map((t) => [
        t,
        JSON.stringify([db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(t).sql, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]),
      ]),
    ),
  )
}

const rows = (path, sql, ...args) => open(path, (db) => db.prepare(sql).all(...args))
const setting = (path, key) => rows(path, 'SELECT value FROM setting WHERE key = ?', key)[0]?.value ?? null

function assertNoCountDropped(before, after) {
  for (const [table, n] of Object.entries(before)) assert.ok(after[table] >= n, `${table}: ${n} -> ${after[table]}`)
}

// ---- metric 1 ----

test('every work_item gets a project: its repo’s, else an enabled `Unlinked items`; no table loses a row', () => {
  const { path, horizon, ledger } = oldDb()
  const before = counts(path)
  assert.equal(rows(path, 'SELECT id FROM work_item WHERE project_id IS NULL').length, 4, 'the fixture has NULL items')

  boot(path)

  assert.deepEqual(rows(path, 'SELECT id FROM work_item WHERE project_id IS NULL'), [])
  const unlinked = rows(path, "SELECT * FROM project WHERE name = 'Unlinked items'")
  assert.equal(unlinked.length, 1)
  assert.deepEqual(
    { enabled: unlinked[0].enabled, autopilot: unlinked[0].autopilot, definitions_enabled: unlinked[0].definitions_enabled },
    { enabled: 1, autopilot: 'off', definitions_enabled: 0 },
  )
  assert.equal(setting(path, 'unlinked_project_id'), String(unlinked[0].id))
  const projectOf = Object.fromEntries(rows(path, 'SELECT id, project_id FROM work_item').map((r) => [r.id, r.project_id]))
  assert.deepEqual(projectOf, { 'HZ-1': horizon, 'HZ-2': horizon, 'LS-1': ledger, 'OR-1': unlinked[0].id, 'LOC-1': unlinked[0].id })

  const after = counts(path)
  assertNoCountDropped(before, after)
  assert.equal(after.project, before.project + 1)
  assert.equal(after.work_item, before.work_item)
  assert.equal(after.event, before.event)
})

test('with no leftover items no `Unlinked items` project is created', () => {
  const { path } = oldDb()
  const db = new Database(path)
  db.exec("DELETE FROM event WHERE item_id IN ('OR-1', 'LOC-1'); DELETE FROM work_item WHERE id IN ('OR-1', 'LOC-1')")
  db.close()
  boot(path)
  assert.deepEqual(rows(path, "SELECT id FROM project WHERE name = 'Unlinked items'"), [])
  assert.deepEqual(rows(path, 'SELECT id FROM work_item WHERE project_id IS NULL'), [])
})

test('a fresh demo seed has no NULL project_id, and no active project is set', () => {
  const path = freshPath()
  boot(path)
  const items = rows(path, 'SELECT id, project_id FROM work_item')
  assert.ok(items.length > 0, 'the demo seed ran')
  const unlinked = Number(setting(path, 'unlinked_project_id'))
  assert.ok(items.every((it) => it.project_id === unlinked), JSON.stringify(items))
  assert.equal(setting(path, 'active_project_id'), null)
})

// ---- metric 2 ----

for (const [label, env, owners] of [
  ['ADMIN_EMAIL only, in another case', { ADMIN_EMAIL: 'OWNER@example.COM' }, ['u-owner']],
  ['ADMIN_EMAILS only, two addresses', { ADMIN_EMAILS: 'alice@example.com, BOB@example.com' }, ['u-alice', 'u-bob']],
  ['neither set', {}, []],
]) {
  test(`roles with ${label}: matching users are owners, the rest members; every user joins every project with the old active project`, () => {
    const { path, horizon } = oldDb()
    boot(path, env)
    const users = rows(path, 'SELECT id, role, active_project_id FROM user ORDER BY id')
    assert.deepEqual(
      users.filter((u) => u.role === 'owner').map((u) => u.id),
      [...owners].sort(),
    )
    assert.ok(users.every((u) => u.role === 'owner' || u.role === 'member'))
    assert.ok(users.every((u) => u.active_project_id === horizon), JSON.stringify(users))

    const projects = rows(path, 'SELECT id FROM project ORDER BY id').map((p) => p.id)
    assert.ok(projects.includes(Number(setting(path, 'unlinked_project_id'))), 'Unlinked items is counted')
    const members = rows(path, 'SELECT project_id, user_id FROM project_member ORDER BY project_id, user_id')
    const expected = projects.flatMap((p) => users.map((u) => ({ project_id: p, user_id: u.id })).sort((a, b) => (a.user_id < b.user_id ? -1 : 1)))
    assert.deepEqual(members, expected)
  })
}

test('with no global active project, every user’s active_project_id stays NULL', () => {
  const { path } = oldDb({ active: null })
  boot(path)
  assert.deepEqual(rows(path, 'SELECT DISTINCT active_project_id AS a FROM user'), [{ a: null }])
})

// ---- metric 4 and guardrail 2 ----

test('a second boot changes no row in any table', () => {
  const { path } = oldDb()
  boot(path)
  const first = hashes(path)
  boot(path)
  assert.deepEqual(hashes(path), first)
})

test('later boots never re-add a member or overwrite a user’s active project', () => {
  const { path, ledger } = oldDb()
  boot(path)
  const db = new Database(path)
  db.prepare("UPDATE user SET active_project_id = ? WHERE id = 'u-alice'").run(ledger)
  db.prepare("DELETE FROM project_member WHERE user_id = 'u-bob' AND project_id = ?").run(ledger)
  db.prepare("INSERT INTO user (id, email, name, initials, auth_method, gate_pin_hash) VALUES ('u-carol', 'carol@example.com', 'Carol', 'CA', 'password', 'salt:hash')").run()
  const gamma = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Gamma', 0)").run().lastInsertRowid)
  db.close()
  const before = hashes(path)

  boot(path)

  assert.deepEqual(hashes(path), before)
  assert.equal(rows(path, "SELECT active_project_id AS a FROM user WHERE id = 'u-alice'")[0].a, ledger)
  assert.deepEqual(rows(path, "SELECT * FROM project_member WHERE user_id = 'u-bob' AND project_id = ?", ledger), [])
  assert.deepEqual(rows(path, "SELECT * FROM project_member WHERE user_id = 'u-carol' OR project_id = ?", gamma), [])
})

test('one transaction: a failure part-way leaves every table as it was, and the next boot completes', () => {
  const { path } = oldDb({ keepMemberTable: true })
  let db = new Database(path)
  db.exec("CREATE TRIGGER fail_member BEFORE INSERT ON project_member BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
  db.close()
  const before = hashes(path)
  const columns = rows(path, 'PRAGMA table_info(user)').map((c) => c.name)

  assert.throws(() => boot(path), /injected failure/)

  assert.deepEqual(hashes(path), before)
  assert.deepEqual(rows(path, 'PRAGMA table_info(user)').map((c) => c.name), columns)
  assert.ok(!columns.includes('role'))
  assert.equal(setting(path, 'membership_v1'), null)
  assert.equal(setting(path, 'unlinked_project_id'), null)
  assert.deepEqual(rows(path, "SELECT id FROM project WHERE name = 'Unlinked items'"), [])

  db = new Database(path)
  db.exec('DROP TRIGGER fail_member')
  db.close()
  boot(path)
  assert.equal(setting(path, 'membership_v1'), 'done')
  assert.deepEqual(rows(path, 'SELECT id FROM work_item WHERE project_id IS NULL'), [])
  assert.ok(rows(path, 'SELECT COUNT(*) AS n FROM project_member')[0].n > 0)
})
