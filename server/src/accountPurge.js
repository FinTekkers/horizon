// Deletes a cancelled customer's data 30 days after their access ended
// (HZ-641, Terms §11). The webhook stores user.access_ended_at when Stripe
// cancels the subscription (auth.setAccountStatus); a daily sweep here then
// deletes, per user and in one transaction:
//   - the projects where the user is the only member, with every row under
//     them (work items, runs, test results, artifacts, screenshots, repo links…);
//   - the user's membership rows in shared projects, and nothing else of those;
//   - the user's sessions, API tokens, earlier user_event rows and user row.
// One user_event row (kind account_purged, who PURGE_WHO) records the user id,
// the date and per-table counts, and the owner gets a one-line email. Neither
// carries a name, email, title or any other content; nor do the log lines.
//
// What "every row under them" means is read from the schema, not a hand list:
// planPurge walks PRAGMA foreign_key_list recursively from the user and the
// sole projects, plus the references SOFT_REFERENCES names (columns without a
// declared FK). account-purge.test.mjs seeds a row in every table the walk can
// reach, so a future table is covered without touching this file.
//
// Never deleted: the owner, an allowlisted user (ALLOWED_LOGIN_EMAILS), anyone
// not 'cancelled' with access_ended_at at least PURGE_AFTER_DAYS ago, a
// project with another member, and the `Unlinked items` project. All of it is
// re-checked inside each user's transaction. The server deletes no files:
// purged item ids go to purged_item, store.finishedItems reports them as
// abandoned, and farmd's reaper removes their worktrees. Nothing here calls
// GitHub or Stripe.
//
// The timer is off unless ACCOUNT_PURGE=on (config.js): the owner turns it on
// once the nightly database backup (HZ-650) runs and a --dry-run of
// server/scripts/purge-cancelled.mjs has been checked.

import { db } from './db.js'
import { accountPurgeEnabled, ADMIN_EMAIL, ADMIN_EMAILS, ownerMailConfig } from './config.js'
import { isAllowedEmail } from './loginAllowlist.js'
import { unlinkedProjectId } from './membership.js'
import { gmailMailer, sendPurgeEmail } from './ownerMail.js'
import { msOf, sqlTime } from './sqlTime.js'

export const PURGE_AFTER_DAYS = 30
// user_event.who and .kind of the audit row.
export const PURGE_WHO = 'account-purge'
export const PURGE_KIND = 'account_purged'
// The sweep runs at most once per PURGE_INTERVAL_MS, remembered in
// sync_cursor so a restart doesn't reset the clock; the timer checks hourly.
export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000
const TICK_MS = 60 * 60 * 1000
const PURGE_CURSOR_KEY = 'account-purge'
const DAY_MS = 24 * 60 * 60 * 1000

// References with no declared FK that the walk must still follow.
export const SOFT_REFERENCES = Object.freeze([
  { table: 'work_item', from: 'project_id', parent: 'project', to: 'id' },
  { table: 'user_event', from: 'user_id', parent: 'user', to: 'id' },
])
// References that point another row at a purged one without belonging to it:
// the column is cleared and the row kept (another user's active project).
export const NULLIFIED_REFERENCES = Object.freeze([{ table: 'user', from: 'active_project_id' }])

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`
const isNullified = (ref) => NULLIFIED_REFERENCES.some((n) => n.table === ref.table && n.from === ref.from)

function tableNames() {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name)
}

function primaryKey(table) {
  return db
    .pragma(`table_info(${quote(table)})`)
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name)
}

// Every reference in the schema, as { table, from, parent, to }: each declared
// FK plus SOFT_REFERENCES. Exported for the coverage test.
export function references() {
  const refs = []
  for (const table of tableNames()) {
    for (const fk of db.pragma(`foreign_key_list(${quote(table)})`)) {
      refs.push({ table, from: fk.from, parent: fk.table, to: fk.to ?? primaryKey(fk.table)[0] })
    }
  }
  return [...refs, ...SOFT_REFERENCES]
}

const IN_JSON = 'IN (SELECT value FROM json_each(?))'

function rowidsWhere(table, column, values) {
  return db
    .prepare(`SELECT rowid AS r FROM ${quote(table)} WHERE ${quote(column)} ${IN_JSON}`)
    .all(JSON.stringify(values))
    .map((row) => row.r)
}

// Walks down from the seed rows: every row that references a collected row is
// collected too, except NULLIFIED_REFERENCES, whose rows are only listed for
// clearing. Returns { remove: Map<table, Set<rowid>>, clear: [{ table, from, rowids }] }.
function collect(seeds, refs) {
  const remove = new Map()
  const clear = new Map()
  const queue = []
  const add = (table, rowids) => {
    if (!remove.has(table)) remove.set(table, new Set())
    const set = remove.get(table)
    const fresh = rowids.filter((rowid) => !set.has(rowid))
    for (const rowid of fresh) set.add(rowid)
    if (fresh.length > 0) queue.push([table, fresh])
  }
  for (const { table, column, values } of seeds) if (values.length > 0) add(table, rowidsWhere(table, column, values))
  while (queue.length > 0) {
    const [parent, rowids] = queue.shift()
    for (const ref of refs) {
      if (ref.parent !== parent) continue
      const values = db
        .prepare(`SELECT DISTINCT ${quote(ref.to)} AS v FROM ${quote(parent)} WHERE rowid ${IN_JSON}`)
        .all(JSON.stringify(rowids))
        .map((row) => row.v)
        .filter((value) => value != null)
      if (values.length === 0) continue
      const children = rowidsWhere(ref.table, ref.from, values)
      if (!isNullified(ref)) add(ref.table, children)
      else if (children.length > 0) {
        const key = `${ref.table}.${ref.from}`
        if (!clear.has(key)) clear.set(key, { table: ref.table, from: ref.from, rowids: new Set() })
        for (const rowid of children) clear.get(key).rowids.add(rowid)
      }
    }
  }
  // A row that is deleted anyway needs no clearing.
  const clears = [...clear.values()]
    .map(({ table, from, rowids }) => ({ table, from, rowids: [...rowids].filter((r) => !remove.get(table)?.has(r)) }))
    .filter((c) => c.rowids.length > 0)
  return { remove, clear: clears }
}

// Tables ordered so every table comes before the tables it references, so the
// deletes never trip a foreign key. Throws on a reference cycle.
function deleteOrder(tables, refs) {
  const pending = new Set(tables)
  const order = []
  while (pending.size > 0) {
    const ready = [...pending].filter(
      (t) => !refs.some((ref) => ref.parent === t && ref.table !== t && pending.has(ref.table)),
    )
    if (ready.length === 0) throw new Error('account purge: reference cycle between tables')
    for (const t of ready.sort()) {
      order.push(t)
      pending.delete(t)
    }
  }
  return order
}

// The protected set: the owner (role 'owner', ADMIN_EMAIL, ADMIN_EMAILS and
// the owner-mail recipient) and every allowlisted email.
export function isProtected(user) {
  if (user.role === 'owner') return true
  const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : ''
  const owners = [ADMIN_EMAIL, ...ADMIN_EMAILS, ownerMailConfig().to]
    .filter(Boolean)
    .map((e) => String(e).trim().toLowerCase())
  return owners.includes(email) || isAllowedEmail(email)
}

const cutoffFor = (now) => sqlTime(now - PURGE_AFTER_DAYS * DAY_MS)
const USER_COLUMNS = 'id, email, role, account_status, access_ended_at'

// Why this user must not be purged at `now`, or null when they may be.
function ineligibility(user, now) {
  if (!user) return 'not_found'
  if (user.account_status !== 'cancelled') return 'not_cancelled'
  if (!user.access_ended_at || !(msOf(user.access_ended_at) <= now - PURGE_AFTER_DAYS * DAY_MS)) return 'too_recent'
  if (isProtected(user)) return 'protected'
  return null
}

// Users the sweep would purge at `now`, as [{ id }], oldest id first.
export function eligibleUsers(now = Date.now()) {
  return db
    .prepare(
      `SELECT ${USER_COLUMNS} FROM user
        WHERE account_status = 'cancelled' AND access_ended_at IS NOT NULL AND access_ended_at <= ?
        ORDER BY id`,
    )
    .all(cutoffFor(now))
    .filter((user) => ineligibility(user, now) === null)
    .map((user) => ({ id: user.id }))
}

function primaryKeyValues(table, rowids) {
  const pk = primaryKey(table)
  const columns = pk.length > 0 ? pk : ['rowid']
  return db
    .prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(table)} WHERE rowid ${IN_JSON}`)
    .raw()
    .all(JSON.stringify(rowids))
    .map((values) => (values.length === 1 ? values[0] : values))
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
}

function buildPlan(userId, now) {
  const user = db.prepare(`SELECT ${USER_COLUMNS} FROM user WHERE id = ?`).get(userId)
  const reason = ineligibility(user, now)
  if (reason) return { userId, eligible: false, reason }
  const unlinked = unlinkedProjectId(db)
  const memberships = db
    .prepare(
      `SELECT m.project_id AS id,
              (SELECT COUNT(*) FROM project_member o WHERE o.project_id = m.project_id AND o.user_id <> m.user_id) AS others
         FROM project_member m WHERE m.user_id = ? ORDER BY m.project_id`,
    )
    .all(userId)
  const soleProjects = memberships.filter((m) => m.others === 0 && m.id !== unlinked).map((m) => m.id)
  const sharedProjects = memberships.filter((m) => !soleProjects.includes(m.id)).map((m) => m.id)
  const refs = references()
  const { remove, clear } = collect(
    [
      { table: 'project', column: 'id', values: soleProjects },
      { table: 'user', column: 'id', values: [userId] },
    ],
    refs,
  )
  const order = deleteOrder([...remove.keys()], refs)
  const rows = {}
  const counts = {}
  for (const table of [...remove.keys()].sort()) {
    rows[table] = primaryKeyValues(table, [...remove.get(table)])
    counts[table] = remove.get(table).size
  }
  return { userId, eligible: true, soleProjects, sharedProjects, rows, counts, order, remove, clear }
}

// What purging this user at `now` would delete: { userId, eligible: false,
// reason } or { userId, eligible: true, soleProjects, sharedProjects, rows,
// counts }, where rows maps each table to the primary keys of its doomed rows
// (an array for a composite key). Read-only; --dry-run prints this.
export function planPurge(userId, { now = Date.now() } = {}) {
  const { order, remove, clear, ...plan } = buildPlan(userId, now)
  return plan
}

// Purges one user in one immediate transaction, re-checking eligibility
// inside it. Returns { ok: true, userId, date, counts } or { skipped: reason }.
// A throw rolls the whole user back.
export function purgeUser(userId, { now = Date.now() } = {}) {
  return db
    .transaction(() => {
      const plan = buildPlan(userId, now)
      if (!plan.eligible) return { skipped: plan.reason }
      for (const { table, from, rowids } of plan.clear) {
        db.prepare(`UPDATE ${quote(table)} SET ${quote(from)} = NULL WHERE rowid ${IN_JSON}`).run(JSON.stringify(rowids))
      }
      for (const table of plan.order) {
        const rowids = [...plan.remove.get(table)]
        const deleted = db.prepare(`DELETE FROM ${quote(table)} WHERE rowid ${IN_JSON}`).run(JSON.stringify(rowids)).changes
        if (deleted !== rowids.length) throw new Error(`account purge: ${table} deleted ${deleted} of ${rowids.length}`)
      }
      const recordItem = db.prepare('INSERT OR IGNORE INTO purged_item (id) VALUES (?)')
      for (const itemId of plan.rows.work_item ?? []) recordItem.run(itemId)
      const date = sqlTime(now).slice(0, 10)
      db.prepare('INSERT INTO user_event (user_id, kind, new_value, who) VALUES (?, ?, ?, ?)').run(
        userId,
        PURGE_KIND,
        JSON.stringify({ date, counts: plan.counts }),
        PURGE_WHO,
      )
      return { ok: true, userId, date, counts: plan.counts }
    })
    .immediate()
}

const errorCodeOf = (err) => (typeof err?.code === 'string' ? err.code : 'error')

// One pass over every eligible user. A user whose transaction throws is rolled
// back, logged by id and error code, and left for the next run. dryRun only
// plans. Returns { purged: [{ userId, counts }], skipped: [{ userId, reason }],
// failed: [userId], plans: [plan] }.
export async function runPurge({ dryRun = false, now = Date.now(), mailer = null, log = null } = {}) {
  const result = { purged: [], skipped: [], failed: [], plans: [] }
  for (const { id } of eligibleUsers(now)) {
    if (dryRun) {
      result.plans.push(planPurge(id, { now }))
      continue
    }
    let outcome
    try {
      outcome = purgeUser(id, { now })
    } catch (err) {
      result.failed.push(id)
      log?.error({ userId: id, errorCode: errorCodeOf(err) }, 'account purge failed; retried on the next run')
      continue
    }
    if (outcome.skipped) {
      result.skipped.push({ userId: id, reason: outcome.skipped })
      log?.info({ userId: id, reason: outcome.skipped }, 'account purge skipped')
      continue
    }
    result.purged.push({ userId: id, counts: outcome.counts })
    log?.info({ userId: id, date: outcome.date, counts: outcome.counts }, 'account purged')
    try {
      await sendPurgeEmail(mailer ?? gmailMailer(), { userId: id, date: outcome.date, counts: outcome.counts })
    } catch (err) {
      log?.warn({ userId: id, errorCode: errorCodeOf(err) }, 'account purge email failed')
    }
  }
  return result
}

const getCursorSyncedAt = db.prepare('SELECT last_synced_at FROM sync_cursor WHERE key = ?')
const setCursor = db.prepare(
  `INSERT INTO sync_cursor (key, etag, last_synced_at) VALUES (?, NULL, ?)
   ON CONFLICT(key) DO UPDATE SET last_synced_at = excluded.last_synced_at`,
)

// The daily job: runs runPurge when ACCOUNT_PURGE=on and PURGE_INTERVAL_MS has
// passed since the last run, else resolves null. The run is claimed before it
// starts, so an overlapping tick does nothing.
export async function runDaily(log, { mailer = null, now = Date.now() } = {}) {
  if (!accountPurgeEnabled()) return null
  const last = getCursorSyncedAt.get(PURGE_CURSOR_KEY)?.last_synced_at
  if (last && now - msOf(last) < PURGE_INTERVAL_MS) return null
  setCursor.run(PURGE_CURSOR_KEY, sqlTime(now))
  return runPurge({ now, mailer, log })
}

// Arms the hourly check, plus one at boot. Production passes no mailer and
// gets ownerMail.gmailMailer() per send; tests pass a stub, their own clock and
// timer. Returns { tick, boot }.
export function init(log, { mailer = null, now = Date.now, setTimer = setInterval } = {}) {
  const tick = () =>
    runDaily(log, { mailer, now: now() }).catch((err) => {
      log?.error({ errorCode: errorCodeOf(err) }, 'account purge run failed')
      return null
    })
  setTimer(tick, TICK_MS)?.unref?.()
  const boot = tick()
  return { tick, boot }
}
