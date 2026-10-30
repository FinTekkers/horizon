// HZ-632: the account-status migration on a database from before it existed.
// Additive and once-only: every existing user ends 'active' with no Stripe ids,
// a user created afterwards defaults to 'pending_payment' and keeps it across a
// re-boot, and the event table is left exactly as it was.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const DB_MODULE = fileURLToPath(new URL('../src/db.js', import.meta.url))
const AUTH_MODULE = fileURLToPath(new URL('../src/auth.js', import.meta.url))

function env(path) {
  const out = { ...process.env, HORIZON_DB: path }
  delete out.HORIZON_REPO
  return out
}

// Each boot is its own process, the way the server opens the DB.
function boot(path) {
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(DB_MODULE)})`], {
    env: env(path),
    timeout: 60_000,
  })
}

// Creates a user through auth.createUser, the path sign-in takes, in its own process.
function createUserVia(path, email) {
  const script = `const auth = await import(${JSON.stringify(AUTH_MODULE)});
    auth.createUser({ email: ${JSON.stringify(email)}, name: 'Later User', authMethod: 'password' })`
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: env(path), timeout: 60_000 })
}

// The user table exactly as the previous release created it.
const OLD_USER_DDL = `
  CREATE TABLE user (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    initials      TEXT NOT NULL,
    auth_method   TEXT NOT NULL CHECK (auth_method IN ('password','google')),
    google_sub    TEXT,
    gate_pin_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );
`
const OLD_USER_COLUMNS = ['id', 'email', 'name', 'initials', 'auth_method', 'google_sub', 'gate_pin_hash', 'created_at', 'last_login_at']
const SEEDED = ['u-1', 'u-2', 'u-3']

// A database as the previous release left it: old user DDL, three users, one item with one event.
function oldSchemaDb() {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-account-status-migration-')), 'test.db')
  const db = new Database(path)
  db.exec(OLD_USER_DDL)
  const insert = db.prepare(
    "INSERT INTO user (id, email, name, initials, auth_method, gate_pin_hash) VALUES (?, ?, ?, 'XX', 'password', 'salt:hash')",
  )
  for (const id of SEEDED) insert.run(id, `${id}@example.com`, `User ${id}`)
  db.close()
  // Full schema around the old user table (CREATE TABLE IF NOT EXISTS keeps it),
  // then strip what this item adds so the rest of the fixture is the old release.
  boot(path)
  const full = new Database(path)
  full.exec('DROP TABLE user_event')
  full.exec('ALTER TABLE user DROP COLUMN account_status')
  full.exec('ALTER TABLE user DROP COLUMN stripe_customer_id')
  full.exec('ALTER TABLE user DROP COLUMN stripe_subscription_id')
  // HZ-633's sign-up column, also absent from the old release.
  full.exec('ALTER TABLE user DROP COLUMN company')
  // HZ-634's owner-email marker, likewise.
  full.exec('ALTER TABLE user DROP COLUMN owner_notified_at')
  full.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES ('HZ-1', 'An item', 'Medium', 3)").run()
  full.prepare("INSERT INTO event (item_id, who, text, color, initials) VALUES ('HZ-1', 'You', 'history', '#000', 'YO')").run()
  full.close()
  return path
}

function snapshot(path) {
  const db = new Database(path, { readonly: true })
  try {
    return {
      columns: db.prepare('PRAGMA table_info(user)').all().map((c) => c.name),
      users: db.prepare('SELECT * FROM user ORDER BY id').all(),
      eventDdl: db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event'").get().sql,
      events: JSON.stringify(db.prepare('SELECT * FROM event ORDER BY id').all()),
    }
  } finally {
    db.close()
  }
}

test('seeded users end active with NULL Stripe ids; the user schema only grows; event is byte-identical', () => {
  const path = oldSchemaDb()
  const before = snapshot(path)
  assert.deepEqual(before.columns, OLD_USER_COLUMNS, 'the fixture really is the old schema')

  boot(path)
  const after = snapshot(path)
  for (const column of OLD_USER_COLUMNS) assert.ok(after.columns.includes(column), `column ${column} was kept`)
  for (const column of ['account_status', 'stripe_customer_id', 'stripe_subscription_id']) {
    assert.ok(after.columns.includes(column), `column ${column} was added`)
  }
  assert.deepEqual(after.users.map((u) => u.id), SEEDED)
  for (const user of after.users) {
    assert.equal(user.account_status, 'active', `${user.id} is active`)
    assert.equal(user.stripe_customer_id, null)
    assert.equal(user.stripe_subscription_id, null)
    const old = before.users.find((u) => u.id === user.id)
    for (const column of OLD_USER_COLUMNS) assert.equal(user[column], old[column], `${user.id}.${column} unchanged`)
  }
  assert.equal(after.eventDdl, before.eventDdl)
  assert.equal(after.events, before.events)
})

test('a user created after the migration defaults to pending_payment and keeps it across a re-boot', () => {
  const path = oldSchemaDb()
  boot(path)
  createUserVia(path, 'later@example.com')
  const status = (users) => Object.fromEntries(users.map((u) => [u.email, u.account_status]))
  const afterCreate = snapshot(path)
  assert.equal(status(afterCreate.users)['later@example.com'], 'pending_payment')

  boot(path)
  const afterReboot = snapshot(path)
  assert.deepEqual(status(afterReboot.users), {
    'u-1@example.com': 'active',
    'u-2@example.com': 'active',
    'u-3@example.com': 'active',
    'later@example.com': 'pending_payment',
  })
  assert.deepEqual(afterReboot.users, afterCreate.users, 'a re-boot changes no user row')
  assert.equal(afterReboot.events, afterCreate.events)
})
