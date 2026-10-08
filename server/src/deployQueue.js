// HZ-333: the deploy queue. At step 14 an item joins its deploy target's queue
// instead of publishing a release of its own. When the target's window closes
// (HORIZON_DEPLOY_BATCH_S after the first join) and nothing deploys there, one
// release of main's head is published for the whole batch; the release
// webhook deploys it exactly as before. Once last-good-tag names the batch's
// tag, every queued item whose merge commit is an ancestor of the deployed
// commit is released to its farm smoke check against that release.
//
// All state is in deploy_batch / deploy_queue_entry, so a restart (a Horizon
// batch restarts this very server) resumes wherever tick() left off. A batch's
// tag is saved before any GitHub call and looked up first on resume, so one
// batch is one release, never a `-2`. A batch stays 'verifying' until its
// released items' smoke checks end, so the next batch can't move
// last-good-tag under them.
//
// The queue decides when to publish and with which tag — never what a deploy
// does: the scripts, sudoers and webhook are untouched. Library targets
// (registry-publish) keep the per-item path. Code-only targets (deploy-log,
// HZ-353) restart nothing but still deploy a checkout, so they queue.

import { db } from './db.js'
import { DEPLOY_BATCH_S, DEPLOY_WAIT_MS, FARM_STEP_TIMEOUT_MS } from './config.js'
import { resolveTarget, deployOutcomeFor } from './deploy.js'
import { getBranchSha, isAncestor, getPrMergeSha, findReleaseByTag, createBatchRelease } from './github.js'
import { addEvent, notifyChange } from './store.js'
import { DEPLOY_STEP_INDEX } from '../../domain/js/lifecycle.js'

export const TICK_MS = 5000

// SQLite datetime('now') form: UTC, no zone.
export const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
export const msOf = (sql) => Date.parse(`${sql.replace(' ', 'T')}Z`)
const short = (sha) => String(sha || '').slice(0, 7)

// orchestrator.js supplies these, so this module never imports it.
let hooks = { kick: () => {}, fail: () => {} }
export function setDeployQueueHooks({ kick, fail }) {
  hooks = { kick, fail }
}

export function batchTag(target, id, startedMs) {
  return `deploy-${target}-${new Date(startedMs).toISOString().slice(0, 10).replace(/-/g, '')}-b${id}`
}

// The target an item's Deploy step queues on, or null for today's per-item
// path: no repo/issue/PR, no deploy target, or a library target.
export function queueTargetFor(item) {
  if (!item?.repo || item.issue == null || item.pr == null) return null
  const target = resolveTarget(item.repo)
  return target && target.healthCheckType !== 'registry-publish' ? target : null
}

const selectLiveEntry = db.prepare("SELECT id FROM deploy_queue_entry WHERE item_id = ? AND status IN ('queued','released')")
const selectReleased = db.prepare(`
  SELECT e.id, b.tag, b.release_url, b.started_at FROM deploy_queue_entry e JOIN deploy_batch b ON b.id = e.batch_id
   WHERE e.item_id = ? AND e.status = 'released'`)
const selectOpen = db.prepare("SELECT * FROM deploy_batch WHERE target = ? AND status = 'open'")
const selectRunning = db.prepare("SELECT * FROM deploy_batch WHERE target = ? AND status IN ('publishing','deploying','verifying')")
const selectBatch = db.prepare('SELECT * FROM deploy_batch WHERE id = ?')
const insertBatch = db.prepare('INSERT INTO deploy_batch (target, repo, window_closes_at, created_at) VALUES (?, ?, ?, ?)')
const selectQueuedIn = db.prepare(`
  SELECT e.*, w.pr FROM deploy_queue_entry e JOIN work_item w ON w.id = e.item_id
   WHERE e.batch_id = ? AND e.status = 'queued' ORDER BY e.id`)
const selectItemRow = db.prepare('SELECT cursor, paused, abandoned_at FROM work_item WHERE id = ?')
const updateEntry = db.prepare("UPDATE deploy_queue_entry SET status = ?, ended_at = datetime('now') WHERE id = ?")

// The item's entry in a batch that went live, with what its smoke check needs.
export function releasedEntryFor(itemId) {
  const row = selectReleased.get(itemId)
  return row ? { ...row, startedAtMs: msOf(row.started_at) } : null
}

// Ends the item's queued or released entry: 'passed' when step 14 passed,
// 'failed' when it paused. A resume then joins the queue afresh.
export function endDeployEntry(itemId, status) {
  db.prepare(
    "UPDATE deploy_queue_entry SET status = ?, ended_at = datetime('now') WHERE item_id = ? AND status IN ('queued','released')",
  ).run(status, itemId)
}

function openBatch(target, repo, closesMs, nowMs) {
  return selectOpen.get(target) ?? selectBatch.get(insertBatch.run(target, repo, sqlTime(closesMs), sqlTime(nowMs)).lastInsertRowid)
}

const joining = new Set()

// Records the item's merge commit and puts it in its target's open batch,
// opening one if there is none. Publishes nothing. Idempotent: an item with a
// queued or released entry, or a join already awaiting GitHub, is left alone.
export async function join(item, now = Date.now()) {
  const target = queueTargetFor(item)
  if (!target || joining.has(item.id) || selectLiveEntry.get(item.id)) return null
  joining.add(item.id)
  let mergeSha
  try {
    mergeSha = await getPrMergeSha(item)
  } catch (err) {
    hooks.fail(item.id, `could not join the ${target.key} deploy queue: ${err.message}`)
    return null
  } finally {
    joining.delete(item.id)
  }
  const row = selectItemRow.get(item.id)
  if (!row || row.cursor !== DEPLOY_STEP_INDEX || row.abandoned_at || row.paused) return null
  const batch = db.transaction(() => {
    if (selectLiveEntry.get(item.id)) return null
    const open = openBatch(target.key, item.repo, now + DEPLOY_BATCH_S * 1000, now)
    db.prepare('INSERT INTO deploy_queue_entry (item_id, target, merge_sha, batch_id, joined_at) VALUES (?, ?, ?, ?, ?)').run(
      item.id,
      target.key,
      mergeSha,
      open.id,
      sqlTime(now),
    )
    return open
  })()
  if (!batch) return null
  addEvent(item.id, {
    who: 'Horizon',
    text: `merge ${short(mergeSha)} queued for the next ${target.key} deploy — the window closes ${batch.window_closes_at} UTC`,
    color: '#DFA200',
    initials: 'HZ',
  })
  notifyChange()
  return batch
}

// Entries whose item left step 14 (moved on, abandoned, closed, sent back).
function dropLeavers() {
  for (const e of db.prepare("SELECT id, item_id, status FROM deploy_queue_entry WHERE status IN ('queued','released')").all()) {
    const row = selectItemRow.get(e.item_id)
    if (row && !row.abandoned_at && row.cursor === DEPLOY_STEP_INDEX) continue
    updateEntry.run(e.status === 'released' && row && !row.abandoned_at && row.cursor > DEPLOY_STEP_INDEX ? 'passed' : 'left', e.id)
  }
}

let ticking = null

// One pass over every target with an unfinished batch. Called every TICK_MS
// and at boot; never runs twice at once.
export function tick(now = Date.now()) {
  ticking ??= tickTargets(now).finally(() => {
    ticking = null
  })
  return ticking
}

export const resumeOnBoot = (now = Date.now()) => tick(now)

async function tickTargets(now) {
  dropLeavers()
  const targets = db.prepare("SELECT DISTINCT target FROM deploy_batch WHERE status NOT IN ('done','failed')").all()
  for (const { target } of targets) {
    try {
      await tickTarget(target, now)
    } catch (err) {
      // GitHub unreachable or refusing: the batch keeps its state and the
      // next tick retries; a deploy that never goes live expires below.
      console.warn(`deploy queue: ${target}: ${err.message}`)
    }
  }
}

async function tickTarget(target, now) {
  const running = selectRunning.get(target)
  if (running) await advance(running, now)
  if (selectRunning.get(target)) return
  const open = selectOpen.get(target)
  if (open && now >= msOf(open.window_closes_at)) await start(open, now)
}

async function start(open, now) {
  if (selectQueuedIn.all(open.id).length === 0) {
    db.prepare("UPDATE deploy_batch SET status = 'done', ended_at = ? WHERE id = ?").run(sqlTime(now), open.id)
    return
  }
  // Fetched first: no await may sit inside the transaction below.
  const sha = await getBranchSha(open.repo, 'main')
  const started = db.transaction(() => {
    if (selectRunning.get(open.target)) return false
    return (
      db
        .prepare("UPDATE deploy_batch SET status = 'publishing', commit_sha = ?, tag = ?, started_at = ? WHERE id = ? AND status = 'open'")
        .run(sha, batchTag(open.target, open.id, now), sqlTime(now), open.id).changes === 1
    )
  })()
  if (started) await advance(selectBatch.get(open.id), now)
}

async function advance(batch, now) {
  if (batch.status === 'publishing') return publish(batch, now)
  if (batch.status === 'deploying') return watch(batch, now)
  return verify(batch, now)
}

const expired = (batch, now) => now - msOf(batch.started_at) > DEPLOY_WAIT_MS

async function publish(batch, now) {
  if (expired(batch, now)) return failBatch(batch, `no release was published within ${DEPLOY_WAIT_MS / 1000}s of its start`)
  let release = await findReleaseByTag(batch.repo, batch.tag)
  if (release && release.target_commitish !== batch.commit_sha) {
    return failBatch(batch, `a release with that tag already exists on ${short(release.target_commitish)}, not ${short(batch.commit_sha)}`)
  }
  if (!release) {
    const items = selectQueuedIn.all(batch.id).map((e) => `- ${e.item_id}${e.pr != null ? ` (PR #${e.pr})` : ''}`)
    release = await createBatchRelease(batch.repo, {
      tag: batch.tag,
      sha: batch.commit_sha,
      name: `${batch.target} deploy b${batch.id}`,
      body: [
        `Horizon deploy queue: one release of main at ${batch.commit_sha} for every item below.`,
        '',
        ...items,
        '',
        '_Published by Horizon — the self-deploy webhook will pull this release._',
      ].join('\n'),
    })
  }
  db.prepare("UPDATE deploy_batch SET status = 'deploying', release_url = ? WHERE id = ?").run(release.html_url ?? null, batch.id)
}

async function watch(batch, now) {
  const target = resolveTarget(batch.repo)
  const outcome = target ? deployOutcomeFor(target, batch.tag) : 'pending'
  if (outcome === 'failed') return failBatch(batch, 'the deploy log records DEPLOY FAILED for it')
  if (outcome !== 'live') {
    if (expired(batch, now)) return failBatch(batch, `it was not live within ${DEPLOY_WAIT_MS / 1000}s of its start`)
    return
  }
  db.prepare("UPDATE deploy_batch SET status = 'verifying', live_at = ? WHERE id = ?").run(sqlTime(now), batch.id)
  return verify(selectBatch.get(batch.id), now)
}

// Live: release each queued entry whose merge commit the deploy contains; any
// other waits for the next batch. A comparison GitHub can't answer is retried
// next tick, never passed by default.
async function verify(batch, now) {
  for (const entry of selectQueuedIn.all(batch.id)) {
    let contained
    try {
      contained = await isAncestor(batch.repo, entry.merge_sha, batch.commit_sha)
    } catch (err) {
      console.warn(`deploy queue: ${entry.item_id}: ${err.message}`)
      continue
    }
    if (contained) releaseEntry(entry, batch)
    else deferEntry(entry, batch, now)
  }
  const waiting = db
    .prepare(
      `SELECT COUNT(*) AS n FROM deploy_queue_entry e JOIN work_item w ON w.id = e.item_id
        WHERE e.batch_id = ? AND (e.status = 'queued' OR (e.status = 'released' AND w.paused = 0))`,
    )
    .get(batch.id).n
  if (waiting === 0 || now - msOf(batch.live_at) > FARM_STEP_TIMEOUT_MS + DEPLOY_WAIT_MS) {
    db.prepare("UPDATE deploy_batch SET status = 'done', ended_at = ? WHERE id = ?").run(sqlTime(now), batch.id)
  }
}

function releaseEntry(entry, batch) {
  const row = selectItemRow.get(entry.item_id)
  if (!row || row.abandoned_at || row.cursor !== DEPLOY_STEP_INDEX) return updateEntry.run('left', entry.id)
  db.transaction(() => {
    db.prepare("UPDATE deploy_queue_entry SET status = 'released' WHERE id = ?").run(entry.id)
    db.prepare("UPDATE work_item SET release_tag = ?, release_url = ?, updated_at = datetime('now') WHERE id = ?").run(
      batch.tag,
      batch.release_url,
      entry.item_id,
    )
  })()
  addEvent(entry.item_id, {
    who: 'Horizon',
    text: `release ${batch.tag} (main at ${short(batch.commit_sha)}) is live and contains merge ${short(entry.merge_sha)} — running the smoke check`,
    color: '#4A6B5D',
    initials: 'HZ',
  })
  notifyChange()
  hooks.kick(entry.item_id)
}

// Merged after the batch read main: it rides the next batch, whose window
// counts from this item's own join.
function deferEntry(entry, batch, now) {
  const next = openBatch(batch.target, batch.repo, Math.max(now, msOf(entry.joined_at) + DEPLOY_BATCH_S * 1000), now)
  db.prepare('UPDATE deploy_queue_entry SET batch_id = ? WHERE id = ?').run(next.id, entry.id)
  addEvent(entry.item_id, {
    who: 'Horizon',
    text: `merge ${short(entry.merge_sha)} is not in ${batch.tag} (main at ${short(batch.commit_sha)}) — waiting for the next ${batch.target} deploy`,
    color: '#DFA200',
    initials: 'HZ',
  })
  notifyChange()
}

// No rollback and last-good-tag untouched, as today: step 14 fails for every
// item in the batch, naming the release and listing them. Built from ids and
// tags only — never a log body or an env value.
function failBatch(batch, why) {
  const entries = selectQueuedIn.all(batch.id)
  const message = `deploy ${batch.tag} failed (${why}) — batch: ${entries.map((e) => e.item_id).join(', ') || 'none'}`
  db.prepare("UPDATE deploy_batch SET status = 'failed', failure = ?, ended_at = datetime('now') WHERE id = ?").run(message, batch.id)
  console.warn(`deploy queue: ${message}`)
  for (const e of entries) hooks.fail(e.item_id, message)
}
