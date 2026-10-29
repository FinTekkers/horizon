// HZ-632: setAccountStatus is the one writer of user.account_status. A valid
// change updates the row and writes exactly one user_event audit row; anything
// outside the five statuses is rejected with the row and the audit trail untouched.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-account-status-store-')), 'test.db')
delete process.env.HORIZON_REPO

const auth = await import('../src/auth.js')
const { db } = await import('../src/db.js')

let seq = 0
function activeUser() {
  seq += 1
  const { user } = auth.createUser({ email: `status-${seq}@example.com`, name: `Status ${seq}`, authMethod: 'password' })
  // Arrange an existing, migrated user directly: setAccountStatus is under test here.
  db.prepare('UPDATE user SET account_status = ? WHERE id = ?').run('active', user.id)
  return user
}

const statusOf = (id) => db.prepare('SELECT account_status FROM user WHERE id = ?').get(id).account_status
const auditRows = (id) => db.prepare('SELECT user_id, kind, old_value, new_value, who FROM user_event WHERE user_id = ?').all(id)

test('a new user defaults to pending_payment', () => {
  const { user } = auth.createUser({ email: 'fresh@example.com', name: 'Fresh User', authMethod: 'password' })
  assert.equal(user.account_status, 'pending_payment')
  assert.equal(statusOf(user.id), 'pending_payment')
})

test('a status change updates the row and writes exactly one audit row with the old and new values', () => {
  const user = activeUser()
  assert.deepEqual(auth.setAccountStatus(user.id, 'past_due', 'test'), { ok: true, from: 'active', to: 'past_due' })
  assert.equal(statusOf(user.id), 'past_due')
  assert.deepEqual(auditRows(user.id), [
    { user_id: user.id, kind: 'account_status', old_value: 'active', new_value: 'past_due', who: 'test' },
  ])
})

test('a same-value write is a no-op: unchanged, and no audit row', () => {
  const user = activeUser()
  assert.deepEqual(auth.setAccountStatus(user.id, 'active', 'test'), { ok: true, from: 'active', to: 'active', unchanged: true })
  assert.equal(statusOf(user.id), 'active')
  assert.deepEqual(auditRows(user.id), [])
})

for (const bad of ['paid', '', null, undefined, 'Active', 1]) {
  test(`${JSON.stringify(bad) ?? 'undefined'} is rejected: status unchanged, no audit row`, () => {
    const user = activeUser()
    assert.deepEqual(auth.setAccountStatus(user.id, bad, 'test'), { error: 'invalid_status' })
    assert.equal(statusOf(user.id), 'active')
    assert.deepEqual(auditRows(user.id), [])
  })
}

test('a missing or empty who is rejected before any write', () => {
  const user = activeUser()
  for (const who of [undefined, '', '   ']) {
    assert.deepEqual(auth.setAccountStatus(user.id, 'past_due', who), { error: 'invalid_who' })
  }
  assert.equal(statusOf(user.id), 'active')
  assert.deepEqual(auditRows(user.id), [])
})

test('an unknown user is not_found and writes no audit row', () => {
  assert.deepEqual(auth.setAccountStatus('no-such-user', 'active', 'test'), { error: 'not_found' })
  assert.deepEqual(auditRows('no-such-user'), [])
})

test('ACCOUNT_STATUSES matches the CHECK on user.account_status', () => {
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user'").get().sql
  const check = ddl.match(/account_status IN \(([^)]*)\)/)
  assert.ok(check, 'user DDL has the account_status CHECK')
  const values = check[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''))
  assert.deepEqual(values, [...auth.ACCOUNT_STATUSES])
})

test('the DB CHECK rejects a value even if a write bypassed the function', () => {
  const user = activeUser()
  assert.throws(() => db.prepare('UPDATE user SET account_status = ? WHERE id = ?').run('paid', user.id), /CHECK constraint failed/)
  assert.equal(statusOf(user.id), 'active')
})
