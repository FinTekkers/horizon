// HZ-327: flaky checks — the records, the owner's ping, and Admin's list.
//
// A flake is a test that failed and then passed on the same tree. The farm
// finds most of them itself: farm/checks.py reruns a failing check once, and
// a pass on rerun comes back as a `flakes` entry on the step result, the
// resolver reply or the pre-merge JSON line. testResults.js finds the rest in
// the test history (a pass and a fail in two runs of one tree).
//
// Recording is best-effort and never changes what the step result does:
// nothing here throws to its caller. The repo is always the item row's, never
// the payload's. Every text field is cut here again, after farm-side caps,
// so an oversize entry is stored shorter rather than refused.
//
// The ping goes to the owner only (waApprovers.ownerJid), through waSend.js —
// the existing notification path. One per (repo, test) per rolling 7 days,
// claimed in a transaction before it is sent, and never retried, so a 4th
// flake in the window can never send a second one.

import { db } from './db.js'
import { WA_NOTIFY_ENABLED } from './config.js'
import { redact } from './caretakerRules.js'
import { ownerJid } from './waApprovers.js'
import { sendWhatsApp } from './waSend.js'

export const FLAKE_PING_THRESHOLD = 3
export const FLAKE_WINDOW_MS = 7 * 24 * 3600 * 1000
export const FLAKE_SOURCES = ['implement', 'conflict_resolver', 'premerge']
export const FLAKES_MAX = 20
// Admin shows the most recent tests per repo, not every test ever seen.
export const FLAKE_LIST_MAX_PER_REPO = 50
export const FLAKE_LIMITS = { test: 300, suite: 500, file: 500, command: 500, output: 8000, id: 80 }

const SHA_RE = /^[0-9a-f]{40,64}$/

function text(value, max) {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : null
}

function sha(value) {
  return typeof value === 'string' && SHA_RE.test(value) ? value : null
}

// The repo and item a step run belongs to, or null.
export function runOwner(runId) {
  return (
    db
      .prepare('SELECT w.id AS itemId, w.repo AS repo FROM step_run r JOIN work_item w ON w.id = r.item_id WHERE r.id = ?')
      .get(runId) ?? null
  )
}

export function itemRepo(itemId) {
  return db.prepare('SELECT repo FROM work_item WHERE id = ?').get(itemId)?.repo ?? null
}

const insertFlake = db.prepare(`
  INSERT INTO check_flake (repo, test, suite, file, command, item_id, run_id, source, detected_by, check_run,
                           commit_sha, tree_sha, first_output, rerun_output, created_at_ms)
  VALUES (@repo, @test, @suite, @file, @command, @itemId, @runId, @source, @detectedBy, @checkRun,
          @commitSha, @treeSha, @firstOutput, @rerunOutput, @createdAtMs)
`)

// Stores what it can of `flakes` and returns the new rows' ids with their
// tests. Entries without a test or a command are dropped; at most FLAKES_MAX.
// Synchronous, so a caller that does not await the ping still has the rows.
export function storeFlakes({ repo, itemId = null, runId = null, source, detectedBy = 'rerun', flakes, nowMs }) {
  if (!repo || !FLAKE_SOURCES.includes(source) || !Array.isArray(flakes)) return []
  const rows = []
  for (const flake of flakes.slice(0, FLAKES_MAX)) {
    if (flake === null || typeof flake !== 'object') continue
    const test = text(flake.test, FLAKE_LIMITS.test)
    const command = text(flake.command, FLAKE_LIMITS.command)
    if (!test || !command) continue
    rows.push({
      repo,
      test,
      suite: text(flake.suite, FLAKE_LIMITS.suite),
      file: text(flake.file, FLAKE_LIMITS.file),
      command,
      itemId,
      runId: Number.isInteger(runId) ? runId : null,
      source,
      detectedBy,
      checkRun: text(flake.check_run, FLAKE_LIMITS.id),
      commitSha: sha(flake.commit_sha),
      treeSha: sha(flake.tree_sha),
      // Redacted farm-side already; again here, in case a farm build ever forgot.
      firstOutput: redact(text(flake.first_output, FLAKE_LIMITS.output) ?? '', { oneLine: false }),
      rerunOutput: redact(text(flake.rerun_output, FLAKE_LIMITS.output) ?? '', { oneLine: false }),
      createdAtMs: nowMs,
    })
  }
  return db.transaction(() =>
    rows.map((row) => ({ id: Number(insertFlake.run(row).lastInsertRowid), test: row.test, command: row.command })),
  )()
}

// Claims the window's ping for (repo, test) when this flake makes it a repeat
// offender: FLAKE_PING_THRESHOLD records within FLAKE_WINDOW_MS and no ping in
// that window. One transaction, so two concurrent flakes cannot both claim it.
const claimPing = db.transaction(({ repo, test, flakeId, body, recipient, nowMs }) => {
  const since = nowMs - FLAKE_WINDOW_MS
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM check_flake WHERE repo = ? AND test = ? AND created_at_ms > ?')
    .get(repo, test, since)
  if (n < FLAKE_PING_THRESHOLD) return null
  const pinged = db
    .prepare('SELECT 1 FROM check_flake_ping WHERE repo = ? AND test = ? AND created_at_ms > ? LIMIT 1')
    .get(repo, test, since)
  if (pinged) return null
  const id = db
    .prepare(
      `INSERT INTO check_flake_ping (repo, test, flake_id, recipient, body, status, created_at_ms)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(repo, test, flakeId, recipient, body(n), nowMs).lastInsertRowid
  return Number(id)
})

export function pingBody({ repo, test, command, count, itemId }) {
  const unparsed = test === command ? ' (test name not parsed)' : ''
  const last = itemId ? ` (last on ${itemId})` : ''
  return `Flaky test in ${repo}: "${test}"${unparsed} — ${count} flakes in 7 days${last}. See Admin → Flaky tests.`
}

function setPing(id, status, error = null) {
  db.prepare('UPDATE check_flake_ping SET status = ?, last_error = ? WHERE id = ?').run(status, error, id)
}

// Pings the owner for every (repo, test) among `stored` that just became a
// repeat offender. Resolves to the number of messages sent; never rejects.
export async function pingRepeatOffenders({
  repo,
  itemId = null,
  stored,
  nowMs,
  send = sendWhatsApp,
  owner = ownerJid,
  notify = WA_NOTIFY_ENABLED,
  log = console,
}) {
  let sent = 0
  const seen = new Set()
  for (const { id, test, command } of stored) {
    if (seen.has(test)) continue
    seen.add(test)
    try {
      const recipient = owner()
      const pingId = claimPing({
        repo,
        test,
        flakeId: id,
        recipient,
        body: (count) => pingBody({ repo, test, command, count, itemId }),
        nowMs,
      })
      if (pingId === null) continue
      if (!notify) {
        setPing(pingId, 'skipped', 'WA_NOTIFY_ENABLED is off — not sent')
        continue
      }
      if (!recipient) {
        setPing(pingId, 'failed', 'no owner: WA_APPROVER_JIDS is empty')
        continue
      }
      const { body } = db.prepare('SELECT body FROM check_flake_ping WHERE id = ?').get(pingId)
      try {
        await send(recipient, body)
        setPing(pingId, 'sent')
        sent += 1
      } catch (err) {
        setPing(pingId, 'failed', redact(err?.message || String(err)))
      }
    } catch (err) {
      log.error?.(`[check_flake] ping for ${repo} "${test}" failed: ${redact(err?.message || String(err))}`)
    }
  }
  return sent
}

// Stores `flakes` for an item and pings for repeat offenders. The rows are in
// the database when this returns its promise; the promise (the sends) may be
// left unawaited. Never throws and never rejects.
export function recordFlakes({ itemId, runId = null, source, flakes, now = Date.now, log = console, ...ping }) {
  try {
    if (!Array.isArray(flakes) || flakes.length === 0) return Promise.resolve({ recorded: 0, pinged: 0 })
    const repo = itemRepo(itemId)
    const nowMs = now()
    const stored = storeFlakes({ repo, itemId, runId, source, flakes, nowMs })
    if (stored.length > 0) log.info?.(`[check_flake] ${stored.length} flaky test(s) recorded for ${itemId} (${repo})`)
    return pingRepeatOffenders({ repo, itemId, stored, nowMs, log, ...ping }).then((pinged) => ({
      recorded: stored.length,
      pinged,
    }))
  } catch (err) {
    log.error?.(`[check_flake] not recorded for ${itemId}: ${redact(err?.message || String(err))}`)
    return Promise.resolve({ recorded: 0, pinged: 0 })
  }
}

// A step run's flakes (the /complete and /fail routes): the item and repo come
// from the run's own row, so a stale or superseded run's flake still counts.
export function recordRunFlakes(runId, flakes, opts = {}) {
  const none = Promise.resolve({ recorded: 0, pinged: 0 })
  if (!Array.isArray(flakes) || flakes.length === 0) return none
  try {
    const owner = runOwner(runId)
    return owner ? recordFlakes({ itemId: owner.itemId, runId, source: 'implement', flakes, ...opts }) : none
  } catch (err) {
    const log = opts.log ?? console
    log.error?.(`[check_flake] not recorded for run ${runId}: ${redact(err?.message || String(err))}`)
    return none
  }
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString())

// Admin → Flaky tests: per repo, each test with its flake counts, newest
// `last_seen` first (repos too, by their newest test).
export function listFlakes({ now = Date.now } = {}) {
  const since = now() - FLAKE_WINDOW_MS
  // One row per (repo, test): its newest record, with the group's counts.
  const groups = db
    .prepare(
      `SELECT repo, test, count, count_7d, created_at_ms AS last_seen_ms, item_id, command, detected_by
         FROM (SELECT *, COUNT(*) OVER w AS count, SUM(created_at_ms > ?) OVER w AS count_7d,
                      ROW_NUMBER() OVER (PARTITION BY repo, test ORDER BY created_at_ms DESC, id DESC) AS newest
                 FROM check_flake WINDOW w AS (PARTITION BY repo, test))
        WHERE newest = 1
        ORDER BY created_at_ms DESC, id DESC`,
    )
    .all(since)
  const pings = new Map(
    db
      .prepare(
        `SELECT repo, test, status, created_at_ms FROM check_flake_ping
          WHERE id IN (SELECT MAX(id) FROM check_flake_ping GROUP BY repo, test)`,
      )
      .all()
      .map((p) => [`${p.repo}\u0000${p.test}`, p]),
  )
  const repos = new Map()
  for (const g of groups) {
    if (!repos.has(g.repo)) repos.set(g.repo, { repo: g.repo, tests: [] })
    const tests = repos.get(g.repo).tests
    if (tests.length >= FLAKE_LIST_MAX_PER_REPO) continue
    const ping = pings.get(`${g.repo}\u0000${g.test}`)
    tests.push({
      test: g.test,
      count: g.count,
      count_7d: g.count_7d,
      last_seen: iso(g.last_seen_ms),
      last_item_id: g.item_id,
      last_command: g.command,
      name_parsed: g.test !== g.command,
      detected_by: g.detected_by,
      ping_status: ping?.status ?? null,
      pinged_at: iso(ping?.created_at_ms),
    })
  }
  return { repos: [...repos.values()] }
}
