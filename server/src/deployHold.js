// HZ-408: a published release of a repo waits while a Task's Execute job runs
// in that repo, so Horizon's own deploy never cuts the job short. runDeploy()
// (deploy.js) asks holdIfBusy() before spawning; a held release is a
// deploy_hold row, and the deploy queue's tick (deployQueue.js releaseHolds)
// spawns it once no job runs there, or once its deadline passes — the jobs'
// budgets plus DEPLOY_HOLD_GRACE_MS, so a hung job can't block deploys
// forever. Holds of one repo release oldest first; a row is never deleted,
// merged or replaced, and every hold and release is an event on the job's
// item. A repo with no running job and nothing held deploys exactly as before.
//
// This module never imports deploy.js or deployQueue.js: both import it.

import { db } from './db.js'
import { DEPLOY_HOLD_GRACE_MS } from './config.js'
import { sqlTime, msOf } from './sqlTime.js'
import { addEvent, notifyChange, runningJobsIn } from './store.js'

const selectNewestHeld = db.prepare("SELECT * FROM deploy_hold WHERE repo = ? AND status = 'held' ORDER BY id DESC LIMIT 1")
const selectHeldTag = db.prepare("SELECT * FROM deploy_hold WHERE repo = ? AND tag = ? AND status = 'held'")
const selectHold = db.prepare('SELECT * FROM deploy_hold WHERE id = ?')
const insertHold = db.prepare(
  'INSERT INTO deploy_hold (target, repo, tag, job_run_id, held_at, deadline_at) VALUES (?, ?, ?, ?, ?, ?)',
)
const selectRunItem = db.prepare('SELECT item_id FROM step_run WHERE id = ?')

// When a job runs out of budget. A job with no readable budget counts from
// now, so a hold's deadline is always finite.
const budgetEndMs = (job, now) =>
  job.budgetMs != null && Number.isFinite(job.startedMs) ? Math.max(now, job.startedMs + job.budgetMs) : now

function event(itemId, text) {
  if (itemId) addEvent(itemId, { who: 'Horizon', text, color: '#DFA200', initials: 'HZ' })
}

export const jobBlocksDeploy = (repo) => runningJobsIn(repo).length > 0

// Holds the release when a job runs in `repo`, or when an earlier release of
// it is still held (so releases keep their order). Returns the held row, or
// null to deploy now. A redelivered webhook for a tag already held returns
// that row rather than holding it twice.
export function holdIfBusy(target, repo, tag, now = Date.now()) {
  const jobs = runningJobsIn(repo)
  const ahead = selectNewestHeld.get(repo)
  if (jobs.length === 0 && !ahead) return null
  const same = selectHeldTag.get(repo, tag)
  if (same) return same
  // The job that ends last owns the hold; with none, the release ahead's job.
  const last = jobs.reduce((a, b) => (budgetEndMs(b, now) > budgetEndMs(a, now) ? b : a), jobs[0])
  const deadlineMs = (last ? budgetEndMs(last, now) : now) + DEPLOY_HOLD_GRACE_MS
  const jobRunId = last ? last.runId : ahead.job_run_id
  const hold = selectHold.get(insertHold.run(target, repo, tag, jobRunId, sqlTime(now), sqlTime(deadlineMs)).lastInsertRowid)
  const until = `at latest ${hold.deadline_at} UTC`
  if (jobs.length > 0) {
    for (const j of jobs) event(j.itemId, `release ${tag} of ${repo} is held until this job ends (${until})`)
  } else {
    event(selectRunItem.get(jobRunId)?.item_id, `release ${tag} of ${repo} is held behind release ${ahead.tag} (${until})`)
  }
  notifyChange()
  return hold
}

// How long a release of `repo` with this tag has spent held, so a deploy
// queue batch's wait (DEPLOY_WAIT_MS) leaves that time out.
export function heldMsFor(repo, tag, now = Date.now()) {
  return db
    .prepare('SELECT held_at, released_at FROM deploy_hold WHERE repo = ? AND tag = ?')
    .all(repo, tag)
    .reduce((sum, row) => sum + Math.max(0, (row.released_at ? msOf(row.released_at) : now) - msOf(row.held_at)), 0)
}

// Each repo's oldest held release: the only one of that repo that may go next.
export function oldestHolds() {
  return db
    .prepare("SELECT * FROM deploy_hold WHERE id IN (SELECT MIN(id) FROM deploy_hold WHERE status = 'held' GROUP BY repo) ORDER BY id")
    .all()
}

export function lastReleasedHold(repo) {
  return db.prepare("SELECT * FROM deploy_hold WHERE repo = ? AND status = 'released' ORDER BY id DESC LIMIT 1").get(repo) ?? null
}

// Marks a held row released ('job_ended' or 'deadline') once its deploy was
// spawned, with an event on the job's item. False if it was already released.
export function releaseHold(hold, reason, now = Date.now()) {
  const moved = db
    .prepare("UPDATE deploy_hold SET status = 'released', release_reason = ?, released_at = ? WHERE id = ? AND status = 'held'")
    .run(reason, sqlTime(now), hold.id).changes === 1
  if (!moved) return false
  const itemId = selectRunItem.get(hold.job_run_id)?.item_id
  event(
    itemId,
    reason === 'deadline'
      ? `release ${hold.tag} of ${hold.repo} is deploying now — its hold reached its deadline (${hold.deadline_at} UTC) while the job still runs [${reason}]`
      : `release ${hold.tag} of ${hold.repo} is deploying now — the job it was held for ended [${reason}]`,
  )
  notifyChange()
  return true
}
