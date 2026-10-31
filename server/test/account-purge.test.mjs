// HZ-641: the purge of a cancelled customer's data 30 days after their access
// ended. Every test seeds its own users, projects and items; the fixture puts
// one row in every table a foreign key (or accountPurge.SOFT_REFERENCES) can
// reach from a project or user, generically, so a table added later is
// covered with no change here. CHECK constraints are switched off while
// seeding only, because the generic filler values ignore them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FAKE_STRIPE_ENV, setFakeStripeEnv } from './helpers/fakeStripe.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-account-purge-')), 'test.db')
process.env.ADMIN_EMAIL = 'admin@example.com'
process.env.ADMIN_PASSWORD = 'super-secret'
process.env.ALLOWED_LOGIN_EMAILS = 'invited@example.com'
process.env.OWNER_NOTIFY_EMAIL = 'owner@example.com'
delete process.env.GMAIL_USER
delete process.env.GMAIL_APP_PASSWORD
delete process.env.ACCOUNT_PURGE
delete process.env.HORIZON_REPO
delete process.env.FARM_URL
setFakeStripeEnv()

const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const store = await import('../src/store.js')
const { db } = await import('../src/db.js')
const { sqlTime } = await import('../src/sqlTime.js')
const purge = await import('../src/accountPurge.js')

const SCRIPT = fileURLToPath(new URL('../scripts/purge-cancelled.mjs', import.meta.url))
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days, now = Date.now()) => sqlTime(now - days * DAY_MS)

function stubMailer() {
  const sent = []
  return { sent, sendMail: async (msg) => void sent.push(msg) }
}

function stubLog() {
  const lines = []
  const at = (level) => (fields, msg) => void lines.push({ level, fields, msg })
  return { lines, info: at('info'), warn: at('warn'), error: at('error') }
}

// ---- generic fixture ----

const quote = (name) => `"${name.replace(/"/g, '""')}"`
const tables = () =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
const columnsOf = (table) => db.pragma(`table_info(${quote(table)})`)
const pkOf = (table) =>
  columnsOf(table)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name)

let fill = 0
// Inserts one row into `table`: `values` as given, every other NOT NULL or
// key column without a default filled with a fresh value. Returns the row.
function seedRow(table, values = {}) {
  const pk = pkOf(table)
  const rowidAlias = pk.length === 1 && /^INTEGER$/i.test(columnsOf(table).find((c) => c.name === pk[0]).type)
  const row = { ...values }
  for (const c of columnsOf(table)) {
    if (c.name in row) continue
    const needed = (c.notnull && c.dflt_value == null) || (c.pk > 0 && !rowidAlias)
    if (!needed) continue
    fill += 1
    row[c.name] = /INT/i.test(c.type) ? 100000 + fill : /REAL/i.test(c.type) ? fill + 0.5 : `fx-${fill}`
  }
  const names = Object.keys(row)
  const info = db
    .prepare(`INSERT INTO ${quote(table)} (${names.map(quote).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...names.map((n) => row[n]))
  return db.prepare(`SELECT * FROM ${quote(table)} WHERE rowid = ?`).get(info.lastInsertRowid)
}

// One row in `table` with `values`, its other foreign keys pointing at the rows
// in `context`; a parent missing from the context is seeded the same way
// first, or left NULL when the column allows it. Adds the row to the context.
function seedLinked(table, context, values = {}) {
  const row = { ...values }
  for (const ref of purge.references()) {
    if (ref.table !== table || ref.from in row || purge.SOFT_REFERENCES.includes(ref)) continue
    if (!context[ref.parent] && !columnsOf(table).find((c) => c.name === ref.from).notnull) row[ref.from] = null
    else row[ref.from] = (context[ref.parent] ?? seedLinked(ref.parent, context))[ref.to]
  }
  context[table] = seedRow(table, row)
  return context[table]
}

// One row in every table that references `table` (recursively), each pointing
// at the rows in `context`.
function seedTree(table, context) {
  const refs = purge.references()
  const walk = (parent) => {
    for (const ref of refs) {
      if (ref.parent !== parent || context[ref.table]) continue
      if (purge.NULLIFIED_REFERENCES.some((n) => n.table === ref.table && n.from === ref.from)) continue
      seedLinked(ref.table, context, { [ref.from]: context[parent][ref.to] })
      walk(ref.table)
    }
  }
  walk(table)
  return context
}

let seq = 0
const tag = () => `${process.pid}_${++seq}`

function seedUser({ email, status = 'cancelled', endedDaysAgo = 31, role = 'member' } = {}) {
  const t = tag()
  const user = auth.createSignupUser({ email: email ?? `customer${t}@example.com`, name: `Name ${t}`, company: `Company ${t}` })
  db.prepare('UPDATE user SET role = ? WHERE id = ?').run(role, user.id)
  if (status !== 'pending_payment') auth.setAccountStatus(user.id, status, 'test')
  db.prepare('UPDATE user SET access_ended_at = ? WHERE id = ?').run(endedDaysAgo == null ? null : daysAgo(endedDaysAgo), user.id)
  return db.prepare('SELECT * FROM user WHERE id = ?').get(user.id)
}

// A project with `members`, a repo link and one item with a row in every table
// under it. Returns { project, item, context }.
function seedProject(members) {
  const t = tag()
  db.pragma('ignore_check_constraints = ON')
  try {
    const project = seedRow('project', { name: `Secret Project ${t}` })
    for (const user of members) db.prepare('INSERT INTO project_member (project_id, user_id) VALUES (?, ?)').run(project.id, user.id)
    const item = seedRow('work_item', { id: `PZ-${t}`, title: `Secret item title ${t}`, project_id: project.id, repo: `acme/repo-${t}` })
    // project_member is in the context so the walk adds no member of its own.
    const project_member = db.prepare('SELECT * FROM project_member WHERE project_id = ? AND user_id = ?').get(project.id, members.at(-1).id)
    const context = seedTree('project', { project, project_member, work_item: item })
    seedTree('work_item', context)
    return { project, item, context }
  } finally {
    db.pragma('ignore_check_constraints = OFF')
  }
}

function seedCredentials(user) {
  seedRow('session', { user_id: user.id })
  seedRow('api_token', { user_id: user.id })
}

// The test-1 fixture: cancelled user U with a sole project P1 and a project P2
// shared with V; U has sessions and tokens.
function seedCustomer(userOptions) {
  const u = seedUser(userOptions)
  const v = seedUser({ status: 'active', endedDaysAgo: null })
  seedCredentials(u)
  const p1 = seedProject([u])
  const p2 = seedProject([u, v])
  return { u, v, p1, p2 }
}

const rowKey = (table, row) => {
  const pk = pkOf(table)
  return JSON.stringify(pk.length === 1 ? row[pk[0]] : pk.map((c) => row[c]))
}
// Every row of every table, keyed by primary key.
function snapshot() {
  const snap = {}
  for (const table of tables()) snap[table] = new Map(db.prepare(`SELECT * FROM ${quote(table)}`).all().map((r) => [rowKey(table, r), r]))
  return snap
}
const counts = () => Object.fromEntries(tables().map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${quote(t)}`).get().n]))
// The rows present in `before` and gone from `after`, as sorted keys per table.
function removed(before, after) {
  const out = {}
  for (const table of Object.keys(before)) {
    const gone = [...before[table].keys()].filter((k) => !after[table]?.has(k)).sort()
    if (gone.length > 0) out[table] = gone
  }
  return out
}
const planKeys = (rows) => Object.fromEntries(Object.entries(rows).map(([t, keys]) => [t, keys.map((k) => JSON.stringify(k)).sort()]))

// Rows still holding `userId` in any TEXT column.
function rowsMentioning(userId) {
  const hits = []
  for (const table of tables()) {
    for (const c of columnsOf(table)) {
      const found = db.prepare(`SELECT * FROM ${quote(table)} WHERE instr(CAST(${quote(c.name)} AS TEXT), ?) > 0`).all(userId)
      for (const row of found) hits.push({ table, column: c.name, row })
    }
  }
  return hits
}

// Every row whose foreign keys point at the project or its item, per table.
function projectRows({ project, context }) {
  const out = {}
  for (const [table, row] of Object.entries(context)) out[table] = rowKey(table, row)
  out.project_member = db.prepare('SELECT user_id FROM project_member WHERE project_id = ? ORDER BY user_id').all(project.id)
  return out
}
function projectRowsPresent(p) {
  return Object.entries(p.context).every(
    ([table, row]) => db.prepare(`SELECT 1 FROM ${quote(table)} WHERE rowid = (SELECT rowid FROM ${quote(table)} WHERE ${pkOf(table).map((c) => `${quote(c)} IS ?`).join(' AND ')})`).get(...pkOf(table).map((c) => row[c])) !== undefined,
  )
}

// Stripe signing for the webhook journey.
function sign(body) {
  const t = Math.floor(Date.now() / 1000)
  const v1 = crypto.createHmac('sha256', FAKE_STRIPE_ENV.STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}
async function sendEvent(app, event) {
  const payload = JSON.stringify(event)
  const res = await app.inject({
    method: 'POST',
    url: '/api/billing/stripe-webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
    payload,
  })
  assert.equal(res.statusCode, 200, res.body)
}

// ---- metric 1 ----

test('the webhook cancels and stores access_ended_at; 31 days on, one run deletes the sole project, account and every row under them', async () => {
  const app = buildApp({ logger: false, mailer: stubMailer() })
  const t = tag()
  const signup = auth.createSignupUser({ email: `webhook${t}@example.com`, name: 'Ada Webhook', company: 'Acme' })
  auth.setStripeCustomerId(signup.id, `cus_${t}`)
  await sendEvent(app, {
    id: `evt_co_${t}`,
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: signup.id, customer: `cus_${t}`, subscription: `sub_${t}`, customer_details: { email: signup.email } } },
  })
  const endedAt = Math.floor(Date.now() / 1000) - 60
  await sendEvent(app, {
    id: `evt_del_${t}`,
    type: 'customer.subscription.deleted',
    created: endedAt + 5,
    data: { object: { id: `sub_${t}`, customer: `cus_${t}`, status: 'canceled', ended_at: endedAt } },
  })
  const cancelled = db.prepare('SELECT account_status, access_ended_at FROM user WHERE id = ?').get(signup.id)
  assert.equal(cancelled.account_status, 'cancelled')
  assert.equal(cancelled.access_ended_at, sqlTime(endedAt * 1000))

  db.prepare('UPDATE user SET access_ended_at = ? WHERE id = ?').run(daysAgo(31), signup.id)
  const u = db.prepare('SELECT * FROM user WHERE id = ?').get(signup.id)
  seedCredentials(u)
  const p1 = seedProject([u])
  const before = snapshot()

  const mailer = stubMailer()
  const result = await purge.runPurge({ mailer })
  assert.deepEqual(result.failed, [])
  assert.deepEqual(result.purged.map((p) => p.userId), [u.id])

  const gone = removed(before, snapshot())
  for (const [table, row] of Object.entries(p1.context)) assert.ok(gone[table]?.includes(rowKey(table, row)), `${table} row deleted`)
  for (const table of ['session', 'api_token', 'user', 'project_member', 'project_repo', 'work_item']) assert.ok(gone[table], table)
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM session WHERE user_id = ?').get(u.id).n, 0)

  const left = rowsMentioning(u.id)
  assert.equal(left.length, 1, JSON.stringify(left.map((h) => h.table)))
  assert.equal(left[0].table, 'user_event')
  assert.equal(left[0].row.kind, purge.PURGE_KIND)
  assert.equal(left[0].row.who, purge.PURGE_WHO)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('the daily job: off by default; on, one tick purges, a second within 24h does nothing, one after 24h runs, and a restart keeps the clock', async () => {
  db.prepare("DELETE FROM sync_cursor WHERE key = 'account-purge'").run()
  let clock = Date.now()
  const timers = []
  const setTimer = (fn, ms) => {
    timers.push({ fn, ms })
    return { unref() {} }
  }
  const mailer = stubMailer()
  const exists = (id) => db.prepare('SELECT 1 FROM user WHERE id = ?').get(id) !== undefined

  const first = seedCustomer()
  const off = purge.init(null, { mailer, now: () => clock, setTimer })
  assert.equal(await off.boot, null)
  assert.ok(exists(first.u.id), 'ACCOUNT_PURGE unset: the boot tick deletes nothing')
  assert.equal(timers[0].ms, 60 * 60 * 1000)

  process.env.ACCOUNT_PURGE = 'on'
  try {
    const on = purge.init(null, { mailer, now: () => clock, setTimer })
    await on.boot
    assert.ok(!exists(first.u.id), 'the first tick purges')

    const second = seedCustomer()
    clock += 23 * 60 * 60 * 1000
    assert.equal(await on.tick(), null)
    assert.ok(exists(second.u.id), 'a tick within 24h does nothing')

    const restarted = purge.init(null, { mailer, now: () => clock, setTimer })
    assert.equal(await restarted.boot, null)
    assert.ok(exists(second.u.id), 'a restart does not reset the 24h clock')

    clock += 2 * 60 * 60 * 1000
    await restarted.tick()
    assert.ok(!exists(second.u.id), 'a tick after 24h runs again')
  } finally {
    delete process.env.ACCOUNT_PURGE
  }
})

test('store.finishedItems reports each purged item as abandoned, in any letter case', async () => {
  const { u, p1 } = seedCustomer()
  await purge.runPurge({ mailer: stubMailer() })
  assert.equal(db.prepare('SELECT 1 FROM user WHERE id = ?').get(u.id), undefined)
  const id = p1.item.id
  assert.deepEqual(store.finishedItems([id]), [{ id, state: 'abandoned' }])
  assert.deepEqual(store.finishedItems([id.toLowerCase()]), [{ id, state: 'abandoned' }])
})

test('schema coverage: the plan reaches every table that references a project, work item or user', () => {
  const { u, p1 } = seedCustomer()
  const plan = purge.planPurge(u.id)
  assert.equal(plan.eligible, true)
  const reachable = new Set(['project', 'user'])
  for (let grew = true; grew; ) {
    grew = false
    for (const ref of purge.references()) {
      if (reachable.has(ref.parent) && !reachable.has(ref.table)) {
        reachable.add(ref.table)
        grew = true
      }
    }
  }
  const missing = [...reachable].filter((table) => !plan.rows[table]?.length)
  assert.deepEqual(missing, [])
  for (const [table, row] of Object.entries(p1.context)) {
    assert.ok(planKeys(plan.rows)[table].includes(rowKey(table, row)), `${table} row planned`)
  }
  // Leave nothing eligible behind for later tests.
  purge.purgeUser(u.id)
})

// ---- metric 2 ----

test('a project shared with another member keeps every row; only the purged user’s membership goes', async () => {
  const { u, v, p2 } = seedCustomer()
  const before = projectRows(p2)
  await purge.runPurge({ mailer: stubMailer() })
  assert.equal(db.prepare('SELECT 1 FROM user WHERE id = ?').get(u.id), undefined)
  assert.ok(projectRowsPresent(p2), 'every row under the shared project is still there')
  const after = projectRows(p2)
  assert.deepEqual(after.project_member, before.project_member.filter((m) => m.user_id !== u.id))
  assert.deepEqual(after.project_member, [{ user_id: v.id }])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_item WHERE project_id = ?').get(p2.project.id).n, 1)
})

// ---- metric 3 ----

test('nothing is deleted for a cancelled user at 29 days, an active user, the owner or an allowlisted user', async () => {
  const fixtures = [
    seedCustomer({ endedDaysAgo: 29 }),
    seedCustomer({ status: 'active', endedDaysAgo: 31 }),
    seedCustomer({ email: 'owner@example.com', endedDaysAgo: 31 }),
    seedCustomer({ role: 'owner', endedDaysAgo: 31 }),
    seedCustomer({ email: 'invited@example.com', endedDaysAgo: 31 }),
  ]
  // The active user's date is set straight in the DB, so the status filter alone protects it.
  assert.notEqual(db.prepare('SELECT access_ended_at FROM user WHERE id = ?').get(fixtures[1].u.id).access_ended_at, null)
  const before = counts()
  const mailer = stubMailer()
  const result = await purge.runPurge({ mailer })
  assert.deepEqual(result, { purged: [], skipped: [], failed: [], plans: [] })
  assert.deepEqual(counts(), before)
  assert.equal(mailer.sent.length, 0)
  for (const { u } of fixtures) assert.equal(purge.planPurge(u.id).eligible, false)
})

test('reactivation clears access_ended_at, so a later run keeps the user', async () => {
  const { u } = seedCustomer()
  auth.setAccountStatus(u.id, 'active', 'test')
  assert.equal(db.prepare('SELECT access_ended_at FROM user WHERE id = ?').get(u.id).access_ended_at, null)
  const before = counts()
  await purge.runPurge({ mailer: stubMailer() })
  assert.deepEqual(counts(), before)
})

// ---- metric 4 and guardrails 2 and 4 ----

test('one audit event with the user id, date and counts only; one email to the owner; no content in any log or mail; no fetch', async () => {
  const { u, p1, p2 } = seedCustomer()
  const mailer = stubMailer()
  const log = stubLog()
  const realFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    throw new Error('no network in the purge')
  }
  const now = Date.now()
  try {
    await purge.runPurge({ mailer, log, now })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(fetches, 0)

  const audit = db.prepare('SELECT * FROM user_event WHERE user_id = ?').all(u.id)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].kind, purge.PURGE_KIND)
  assert.equal(audit[0].who, purge.PURGE_WHO)
  const body = JSON.parse(audit[0].new_value)
  assert.deepEqual(Object.keys(body).sort(), ['counts', 'date'])
  assert.equal(body.date, sqlTime(now).slice(0, 10))
  assert.equal(body.counts.user, 1)
  assert.equal(body.counts.project, 1)

  assert.equal(mailer.sent.length, 1)
  assert.equal(mailer.sent[0].to, 'owner@example.com')
  assert.ok(mailer.sent[0].subject.includes(u.id))

  const secrets = [u.email, u.name, u.company, p1.project.name, p1.item.title, p2.project.name, p2.item.title]
  const outputs = [audit[0].new_value, mailer.sent[0].subject, mailer.sent[0].text, ...log.lines.map((l) => JSON.stringify(l))]
  assert.ok(log.lines.length > 0)
  for (const output of outputs) for (const secret of secrets) assert.ok(!output.includes(secret), `${secret} leaked`)
})

// ---- metric 5 ----

test('--dry-run lists exactly the rows a real run deletes and changes nothing', async () => {
  const { u } = seedCustomer()
  const before = snapshot()
  const beforeCounts = counts()
  const env = { ...process.env }
  delete env.FARM_HOME
  delete env.NODE_TEST_CONTEXT
  const child = spawnSync(process.execPath, [SCRIPT, '--dry-run'], { env, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  // No audit row either: user_event's count is among these.
  assert.deepEqual(counts(), beforeCounts)

  const plans = child.stdout.trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(plans.map((p) => p.userId), [u.id])
  assert.equal(plans[0].eligible, true)

  const mailer = stubMailer()
  await purge.runPurge({ mailer })
  assert.equal(mailer.sent.length, 1)
  const deleted = removed(before, snapshot())
  assert.deepEqual(planKeys(plans[0].rows), deleted)
})

// ---- guardrails 1 and 3 ----

test('a user reactivated between selection and purge is skipped, with nothing deleted', () => {
  const { u } = seedCustomer()
  assert.ok(purge.eligibleUsers().some((e) => e.id === u.id))
  auth.setAccountStatus(u.id, 'active', 'test')
  const before = counts()
  assert.deepEqual(purge.purgeUser(u.id), { skipped: 'not_cancelled' })
  assert.deepEqual(counts(), before)
})

test('a failing user rolls back alone, is logged by id and error code, and is purged on the next run', async () => {
  const a = seedCustomer()
  const b = seedCustomer()
  db.exec(`CREATE TEMP TRIGGER purge_fault BEFORE DELETE ON session WHEN OLD.user_id = '${a.u.id}'
           BEGIN SELECT RAISE(ABORT, 'injected'); END`)
  const log = stubLog()
  const sessionsOf = (id) => db.prepare('SELECT COUNT(*) AS n FROM session WHERE user_id = ?').get(id).n
  try {
    const result = await purge.runPurge({ mailer: stubMailer(), log })
    assert.deepEqual(result.failed, [a.u.id])
    assert.deepEqual(result.purged.map((p) => p.userId), [b.u.id])
  } finally {
    db.exec('DROP TRIGGER IF EXISTS purge_fault')
  }
  assert.ok(db.prepare('SELECT 1 FROM user WHERE id = ?').get(a.u.id))
  assert.equal(sessionsOf(a.u.id), 1)
  assert.ok(projectRowsPresent(a.p1), "A's sole project is intact")
  assert.equal(db.prepare('SELECT 1 FROM user WHERE id = ?').get(b.u.id), undefined)

  const failure = log.lines.filter((l) => l.level === 'error')
  assert.equal(failure.length, 1)
  assert.deepEqual(Object.keys(failure[0].fields).sort(), ['errorCode', 'userId'])
  assert.equal(failure[0].fields.userId, a.u.id)
  assert.match(failure[0].fields.errorCode, /^SQLITE_/)

  const retry = await purge.runPurge({ mailer: stubMailer() })
  assert.deepEqual(retry.purged.map((p) => p.userId), [a.u.id])
  assert.equal(db.prepare('SELECT 1 FROM user WHERE id = ?').get(a.u.id), undefined)
})
