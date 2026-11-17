// HO-875: the sl backend's Tracker port (backends/tracker.js) — each sl item is
// one Task, created, commented on, closed and read through farmd's
// /api/farm/tasks routes (farm/farmd.py, over farm/task_driver.py). forRepo(repo)
// hands these twelve methods out for an sl repo through backends/sl.js; they
// pass test/contracts/tracker.contract.mjs like GitHub's do.
//
// Results are issue-shaped, as the port's callers read them: a Task comes back
// as { number, html_url, title, body, labels: [{ name }], state }, where
// `number` is the Task's own number (stored as work_item.task_id) and html_url
// its link. An sl item's id is NOT <prefix>-<number>: the filing call sites
// record what createIssue returns through store.recordFiled, which gives an
// sl Task's item the next id from its prefix's own sequence.
//
// Guardrails, all held here:
//   - The only network call is fetch to FARM_URL's /api/farm/tasks routes.
//     Never GitHub, git, gh, delegate-to-agent or claim. With no farm
//     configured, nothing is sent: a write rejects and a poll records an error.
//   - farmd is asked with the existing x-farm-secret (FARM_SHARED_SECRET from
//     the host's server.env). No Task-service credential reaches this server,
//     and no error, log line or event this file writes carries the secret or
//     any farm response text beyond a short error code.
//   - A create that times out is retried once with the same idempotency key,
//     so farmd answers the first Task again rather than filing a second.

import { createHash, randomUUID } from 'node:crypto'
import { db } from '../db.js'
import * as store from '../store.js'
import { FARM_SHARED_SECRET, FARM_URL, POLL_INTERVAL_MS, UI_URL } from '../config.js'
import { HORIZON_FOOTER, composeIssueBody } from '../trackerText.js'
import { priorityLabelName } from '../priorityLabels.js'
import { kindLabelName } from '../kindLabels.js'
import { AUTOPILOT_OFF_LABEL } from '../autopilotOffLabel.js'

// Served by farmd, not by this server (see farm/farmd.py).
const TASKS_PATH = '/api/farm/tasks'
const FARM_TIMEOUT_MS = 15_000
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/

// One request to farmd's Task routes. Rejects with `<action> failed: <why>`,
// where <why> is farmd's error code or a fixed phrase — never response text.
async function farmTasks(action, method, path, body) {
  if (!FARM_URL) throw new Error(`${action} failed: no farm is configured`)
  let res
  try {
    res = await fetch(`${FARM_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-farm-secret': FARM_SHARED_SECRET },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(FARM_TIMEOUT_MS),
    })
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    throw Object.assign(new Error(`${action} failed: ${timedOut ? 'the farm timed out' : 'the farm is unreachable'}`), { timedOut })
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const code = typeof data?.error === 'string' && ERROR_CODE.test(data.error) ? data.error : `farm returned ${res.status}`
    throw Object.assign(new Error(`${action} failed: ${code}`), { status: res.status })
  }
  return data ?? {}
}

// A farmd Task as the port's issue shape, or null when it has no Task number.
function asIssue(task) {
  if (!task || !Number.isSafeInteger(task.number) || task.number <= 0) return null
  return {
    number: task.number,
    html_url: typeof task.url === 'string' ? task.url : (task.html_url ?? null),
    title: typeof task.title === 'string' ? task.title : '',
    body: typeof task.body === 'string' ? task.body : '',
    labels: (Array.isArray(task.labels) ? task.labels : []).map((label) => (typeof label === 'string' ? { name: label } : label)),
    state: task.state === 'closed' ? 'closed' : 'open',
  }
}

function taskNumberOf(item) {
  const n = Number(item?.task_id)
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${item?.id ?? 'the item'} has no Task`)
  return n
}

const itemLink = (item) => `[open in Horizon](${UI_URL}/${item.id.toLowerCase()})`
const repoQuery = (repo, extra = '') => `${TASKS_PATH}?repo=${encodeURIComponent(repo)}${extra}`

// ---- create, comment, close ----

// Files one Task for a new item and records the item. The labels carry what
// GitHub's do (priority, kind, lane, autopilot-off), so the item reads back
// the same. The idempotency key is the body's hash when a caller's marker
// makes the body unique (spawn and split children), else a fresh one.
export async function createIssue(
  repo,
  { title, outcome, metric, guardrails, priority, kind = 'change', lane = null, bodySuffix = '', autopilotOff = false },
) {
  const body = composeIssueBody({ outcome, metric, guardrails }) + (bodySuffix ? `\n\n${bodySuffix}` : '')
  // The kind's label always rides along (a change's is ignored on the way back).
  const labels = [priorityLabelName(priority), kindLabelName(kind), lane || null, autopilotOff ? AUTOPILOT_OFF_LABEL : null]
  const request = {
    repo,
    title,
    body,
    labels: labels.filter(Boolean),
    idempotency_key: bodySuffix ? `body:${createHash('sha256').update(`${repo}\n${body}`).digest('hex')}` : `item:${randomUUID()}`,
  }
  let task
  try {
    task = await farmTasks('Task create', 'POST', TASKS_PATH, request)
  } catch (err) {
    if (!err.timedOut) throw err
    task = await farmTasks('Task create', 'POST', TASKS_PATH, request)
  }
  const issue = asIssue(task)
  if (!issue) throw new Error('Task create failed: the farm returned no Task number')
  return issue
}

export async function postIssueComment(item, body) {
  await farmTasks('Task comment', 'POST', `${TASKS_PATH}/${taskNumberOf(item)}/comments`, { repo: item.repo, body })
}

// Approving the final gate closes the item's Task as completed, with a summary.
export async function closeIssueWithSummary(item) {
  const summary = [
    '✅ Closed via Horizon after the final review gate.',
    '',
    `- Code: ${item.pr != null ? `PR #${item.pr}` : '—'}`,
    `- Deploy: ${item.release_tag ? `release \`${item.release_tag}\`` : '—'}`,
    `- Success metric: ${item.metric || '—'}`,
    '',
    `_${itemLink(item)} · ${HORIZON_FOOTER}`,
  ].join('\n')
  await farmTasks('Task close', 'POST', `${TASKS_PATH}/${taskNumberOf(item)}/close`, { repo: item.repo, summary, reason: 'completed' })
}

// Abandoning closes the Task as not planned. Called after the item is marked
// abandoned, so the poll that sees the closed Task leaves the item alone.
export async function closeIssueAsAbandoned(item, reason) {
  const summary = ['🚫 Abandoned via Horizon — this work will not proceed.', '', `- Reason: ${reason}`, '', `_${itemLink(item)} · ${HORIZON_FOOTER}`].join('\n')
  await farmTasks('Task close', 'POST', `${TASKS_PATH}/${taskNumberOf(item)}/close`, { repo: item.repo, summary, reason: 'not_planned' })
}

// The Task a split or spawn already filed on `repo`, found by the marker in its
// body, or null — the crash window between farmd's create and the item's
// record. `since` is GitHub's paging bound; farmd lists the repo's Tasks
// whole, so it is unused here.
export async function findSplitIssue(repo, marker, since) {
  const { tasks } = await farmTasks('Task list', 'GET', repoQuery(repo))
  return (Array.isArray(tasks) ? tasks : []).map(asIssue).find((task) => task && task.body.includes(marker)) ?? null
}

// ---- inbound sync: farmd → items ----

const getCursor = db.prepare('SELECT etag FROM sync_cursor WHERE key = ?')
const setCursor = db.prepare(`
  INSERT INTO sync_cursor (key, etag, last_synced_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, last_synced_at = excluded.last_synced_at
`)

// Last poll outcome per repo, for getSyncState.
const lastByRepo = {}

// One Task's state onto the item it backs. Only a Task Horizon filed has an
// item; any other Task, and any repo that is not a connected sl repo, is a no-op.
export function ingestIssue(task, repoFullName) {
  return store.syncTaskState(task, repoFullName)
}

// One Task comment as feedback on the item its Task backs. Horizon's own
// comments (the footer marker) and bot accounts are skipped. Returns true for
// a new feedback row.
export function ingestComment(repoFullName, taskNumber, comment, log) {
  if (!comment?.body || taskNumber == null) return false
  if (comment.user?.type === 'Bot' || String(comment.body).includes(HORIZON_FOOTER)) return false
  const item = store.findItemByTask(repoFullName, taskNumber)
  if (!item) return false
  const commentId = Number.isSafeInteger(comment.id) ? comment.id : null
  const result = store.addFeedback(item.id, { message: String(comment.body).slice(0, 2000), source: 'sl', taskCommentId: commentId })
  if (result.error) {
    if (result.error !== 'closed') log?.warn(`comment on ${repoFullName} Task ${taskNumber} not ingested: ${result.error}`)
    return false
  }
  return !result.duplicate
}

// Every Task on `repo`: each one's state onto its item.
export async function pollRepo(repo, log) {
  const at = () => new Date().toISOString()
  let tasks
  try {
    tasks = (await farmTasks('Task poll', 'GET', repoQuery(repo))).tasks
  } catch (err) {
    log?.warn(`sl Task poll failed for ${repo}: ${err.message}`)
    lastByRepo[repo] = { at: at(), status: err.status ?? null, changed: 0, error: err.message }
    return lastByRepo[repo]
  }
  let changed = 0
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (ingestIssue(task, repo)) changed++
  }
  lastByRepo[repo] = { at: at(), status: 200, changed, error: null }
  return lastByRepo[repo]
}

// The comments on `repo`'s Tasks since the last one read. Every sl item is a
// Task Horizon filed, so there is no history to skip: the cursor starts at 0,
// and moves only after the page is ingested.
export async function pollComments(repo, log) {
  const key = `sl-comments:${repo}`
  const after = Number(getCursor.get(key)?.etag) || 0
  let comments
  try {
    comments = (await farmTasks('Task poll', 'GET', repoQuery(repo, `&after_comment=${after}`))).comments
  } catch (err) {
    log?.warn(`sl Task comment poll failed for ${repo}: ${err.message}`)
    return { changed: 0, error: err.message }
  }
  let changed = 0
  let latest = after
  for (const comment of Array.isArray(comments) ? comments : []) {
    if (!Number.isSafeInteger(comment?.id) || comment.id <= after) continue
    if (ingestComment(repo, comment.task, comment, log)) changed++
    latest = Math.max(latest, comment.id)
  }
  if (latest !== after) setCursor.run(key, String(latest))
  return { changed }
}

const slRepos = () => store.listRepos({ backend: 'sl' })

export async function pollOnce(log) {
  let changed = 0
  if (!FARM_URL) return { changed }
  for (const { repo } of slRepos()) {
    changed += (await pollRepo(repo, log)).changed
    changed += (await pollComments(repo, log)).changed
  }
  return { changed }
}

export function startPolling(log) {
  let inFlight = false
  let warned = false
  const tick = async () => {
    if (inFlight || slRepos().length === 0) return
    if (!FARM_URL) {
      if (!warned) log.warn('sl Task sync needs a farm (FARM_URL) — sl items are not synced')
      warned = true
      return
    }
    inFlight = true
    try {
      const result = await pollOnce(log)
      if (result.changed > 0) log.info(`sl Task poll: ${result.changed} item(s) updated`)
    } catch (err) {
      log.warn(`sl Task poll failed: ${err.message}`)
    } finally {
      inFlight = false
    }
  }
  tick()
  setInterval(tick, POLL_INTERVAL_MS).unref()
}

export function getSyncState() {
  return {
    farmConfigured: !!FARM_URL,
    repos: slRepos().map((r) => ({ ...r, last: lastByRepo[r.repo] || null })),
  }
}
