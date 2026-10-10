// HZ-313: a plan can split an item — file the upstream part of the fix on
// another repo connected to the same project, and make the item wait for it.
//
// Two moments, two callers:
//   - proposeSplit: orchestrator.completeFarmRun, when "Plan options &
//     trade-offs" finishes. It validates the Ensemble's `split` field, records
//     one 'proposed' item_split row and shows the split (or the reason it was
//     refused, as a `## Blockers` bullet) in the artifact gate 5 reads. It
//     never calls GitHub.
//   - fileApprovedSplit: app.js's performGateApproval, BEFORE approveGate at
//     "Approve the high-level design" — the close-issue pattern: no filing, no
//     gate. It files the issue, syncs it in as an item, adds the dependency
//     with store.addDependency (the existing blocking path) and narrows the
//     source item's scope. It never retries: a failure marks the row 'failed'
//     and only a re-run plan makes it claimable again.
//
// item_split's UNIQUE(source_item_id, target_repo) is the idempotency key, so
// it holds across restarts. Nothing here edits, closes or relabels an
// existing upstream issue; the only write upstream is the one create.

import { db } from './db.js'
import * as store from './store.js'
import * as github from './github.js'
import { UI_URL } from './config.js'
import { redact } from './caretakerRules.js'
import { isAbandoned, isClosed, requiredStepIndex } from '../../domain/js/lifecycle.js'
import { fieldByName } from '../../domain/js/fields.js'

// Resolved here so a renamed step throws at boot instead of turning this off.
export const OPTIONS_STEP_INDEX = requiredStepIndex('Plan options & trade-offs (pros / cons)')
export const DESIGN_GATE_INDEX = requiredStepIndex('Approve the high-level design')

// The split's text fields and the work-item limit each is held to.
const FIELD_CAPS = {
  title: fieldByName('title').maxLength,
  description: fieldByName('outcome').maxLength,
  metric: fieldByName('metric').maxLength,
  guardrails: fieldByName('guardrails').maxLength,
  remaining_description: fieldByName('outcome').maxLength,
  remaining_metric: fieldByName('metric').maxLength,
}
const REQUIRED = ['repo', 'title', 'description', 'metric']

const selectRows = db.prepare('SELECT * FROM item_split WHERE source_item_id = ? ORDER BY id')
const selectRow = db.prepare('SELECT * FROM item_split WHERE id = ?')
const selectLatestPlanRun = db.prepare(
  "SELECT MAX(id) AS id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'done'",
)

// Rows a 'filing' call in THIS process holds. A 'filing' row not in here was
// left by a restart, and the next approval may take it over.
const inflight = new Set()

// Upstream issue bodies carry plan text only: secrets and host paths go.
export const HOST_PATH = /(?:\/home|\/Users|\/root)\/[^\s`'")\]]*/g
function clean(text, cap) {
  return redact(String(text), { oneLine: false }).replace(HOST_PATH, '[host path removed]').trim().slice(0, cap)
}

// ---- plan time ----

// { split } for a usable split, { refused } (with the message gate 5 shows)
// for one that must not be filed, or null when the plan proposes none.
export function validateSplit(item, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const split = {}
  for (const [key, cap] of Object.entries(FIELD_CAPS)) {
    split[key] = Object.hasOwn(raw, key) && typeof raw[key] === 'string' ? clean(raw[key], cap) : ''
  }
  split.title = split.title.replace(/\s+/g, ' ')
  split.repo = Object.hasOwn(raw, 'repo') && typeof raw.repo === 'string' ? raw.repo.trim() : ''
  const missing = REQUIRED.filter((key) => !split[key])
  const named = split.repo ? `\`${split.repo}\`` : 'the proposed repo'
  if (missing.length > 0) {
    return { refused: `The proposed split to ${named} is missing ${missing.join(', ')} — nothing will be filed.` }
  }

  const sameRepo = (repo) => repo.toLowerCase() === split.repo.toLowerCase()
  if (item.repo && sameRepo(item.repo)) {
    return { refused: `${named} is this item’s own repo — a split must name another repo. Nothing will be filed.` }
  }
  const connected = store.listRepos().find((r) => sameRepo(r.repo) && item.project_id != null && r.project_id === item.project_id)
  if (!connected) {
    return { refused: `${named} is **not connected** to this item’s project — nothing will be filed.` }
  }
  split.repo = connected.repo

  const filed = selectRows.all(item.id).find((r) => r.target_repo === split.repo && r.status === 'filed')
  if (filed?.target_item_id && store.wouldCycleBetween(item.id, filed.target_item_id)) {
    return {
      refused: `${filed.target_item_id} on \`${split.repo}\` already depends on ${item.id} — depending on it would create a cycle. Nothing will be filed.`,
    }
  }
  return { split, filed: filed || null }
}

// Leaves at most one 'proposed' row for the item: this plan's, or none.
// Rows for other repos that filed nothing are dropped; a 'failed' or orphaned
// 'filing' row is reset to 'proposed' — a re-run plan is the only retry. A
// 'filed' row is never touched. target_issue is kept, so a re-filing reuses
// an issue an earlier attempt already created.
export function recordProposedSplit(itemId, runId, split) {
  db.transaction(() => {
    for (const row of selectRows.all(itemId)) {
      if (row.status === 'filed' || inflight.has(row.id)) continue
      if (split && row.target_repo === split.repo) {
        db.prepare(
          "UPDATE item_split SET status = 'proposed', payload_json = ?, plan_run_id = ?, error = NULL, updated_at = datetime('now') WHERE id = ?",
        ).run(JSON.stringify(split), runId, row.id)
      } else if (row.target_issue == null && row.status !== 'filing') {
        db.prepare('DELETE FROM item_split WHERE id = ?').run(row.id)
      } else if (row.status !== 'failed') {
        db.prepare(
          "UPDATE item_split SET status = 'failed', error = 'superseded by a re-run plan', updated_at = datetime('now') WHERE id = ?",
        ).run(row.id)
      }
    }
    if (split && !selectRows.all(itemId).some((r) => r.target_repo === split.repo)) {
      db.prepare(
        "INSERT INTO item_split (source_item_id, target_repo, status, payload_json, plan_run_id) VALUES (?, ?, 'proposed', ?, ?)",
      ).run(itemId, split.repo, JSON.stringify(split), runId)
    }
  })()
}

const quote = (text) =>
  String(text)
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')

export function renderSplitSection(split, filed = null) {
  if (filed) {
    return [
      '## Proposed split',
      `**Already filed** as ${filed.target_item_id} (\`${filed.target_repo}#${filed.target_issue}\`). Nothing new will be filed.`,
    ].join('\n')
  }
  const lines = [
    '## Proposed split',
    `**Horizon files this on \`${split.repo}\` when gate 5 is approved.** This item then waits for that item to close.`,
    '',
    `- **Target repo:** \`${split.repo}\``,
    `- **Title:** ${split.title}`,
    '',
    '**Upstream description**',
    quote(split.description),
    '',
    '**Upstream success metric**',
    quote(split.metric),
  ]
  if (split.guardrails) lines.push('', '**Upstream guardrails**', quote(split.guardrails))
  if (split.remaining_description) lines.push('', '**This item’s remaining description**', quote(split.remaining_description))
  if (split.remaining_metric) lines.push('', '**This item’s remaining success metric**', quote(split.remaining_metric))
  return lines.join('\n')
}

// Puts the bullet first in the artifact's `## Blockers` section (dropping a
// bare "None."), or appends the section. Autopilot's g5.blocker rule reads
// the FIRST such section, so a second one would go unseen.
export function addBlocker(artifactMd, bullet) {
  const lines = String(artifactMd || '').split('\n')
  const start = lines.findIndex((l) => /^##\s+Blockers\s*$/.test(l.trim()))
  if (start === -1) return [artifactMd, `## Blockers\n- ${bullet}`].filter(Boolean).join('\n\n')
  let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l.trim()))
  if (end === -1) end = lines.length
  const body = lines.slice(start + 1, end).filter((l) => !/^(?:[-*]\s+)?none\.?$/i.test(l.trim()))
  return [...lines.slice(0, start + 1), `- ${bullet}`, ...body, ...lines.slice(end)].join('\n')
}

// The one plan-time entry point: validate, record, render. Returns the
// artifact gate 5 shows.
export function proposeSplit(item, runId, raw, artifactMd) {
  const result = validateSplit(item, raw)
  if (!result) {
    recordProposedSplit(item.id, runId, null)
    return artifactMd
  }
  if (result.refused) {
    recordProposedSplit(item.id, runId, null)
    return addBlocker(artifactMd, result.refused)
  }
  // A 'filed' row for this repo is left as it is; the call still drops
  // proposals for other repos.
  recordProposedSplit(item.id, runId, result.split)
  return [artifactMd, renderSplitSection(result.split, result.filed)].filter(Boolean).join('\n\n')
}

// ---- approval time ----

export const splitMarker = (sourceId) => `<!-- horizon-split-of: ${sourceId} -->`

// The new issue's body after its Outcome / Success metric / Guardrails: a
// back-link and the marker. Its own heading, so parseIssueBody keeps both out
// of the new item's guardrails.
function splitBodySuffix(item) {
  const issueRef = item.repo && item.issue != null ? ` · \`${item.repo}#${item.issue}\`` : ''
  return [
    '## Split from',
    `[${item.id}](${UI_URL}/${item.id.toLowerCase()})${issueRef} — that item waits for this one to close.`,
    '',
    splitMarker(item.id),
  ].join('\n')
}

// SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC) less an hour of clock-skew slack, as ISO.
function sinceIso(createdAt) {
  const ms = Date.parse(`${createdAt.replace(' ', 'T')}Z`)
  return new Date((Number.isNaN(ms) ? Date.now() : ms) - 60 * 60 * 1000).toISOString()
}

const finish = db.prepare(
  "UPDATE item_split SET status = ?, error = ?, target_item_id = COALESCE(?, target_item_id), updated_at = datetime('now') WHERE id = ? AND status = 'filing'",
)
const setTargetIssue = db.prepare("UPDATE item_split SET target_issue = ?, updated_at = datetime('now') WHERE id = ?")

// The row this approval should file, or what to answer instead.
function claim(item) {
  const rows = selectRows.all(item.id)
  const busy = rows.find((r) => r.status === 'filing' && inflight.has(r.id))
  if (busy) return { error: `split filing is already in progress for ${item.id}`, status: 409 }
  const row = rows.find((r) => r.status === 'proposed') || rows.find((r) => r.status === 'filing')
  if (row) {
    // A 'filing' row here was left by a restart; it is taken over, and
    // findSplitIssue below keeps that from filing a second issue.
    const took = db
      .prepare("UPDATE item_split SET status = 'filing', updated_at = datetime('now') WHERE id = ? AND status IN ('proposed','filing')")
      .run(row.id).changes
    if (took === 0) return { skipped: true }
    inflight.add(row.id)
    return { row: selectRow.get(row.id) }
  }
  // This plan's split already failed: approving would let the item run
  // without its upstream part. Only a re-run plan retries.
  const latestPlan = selectLatestPlanRun.get(item.id, OPTIONS_STEP_INDEX).id
  const failed = rows.find((r) => r.status === 'failed' && r.plan_run_id === latestPlan)
  if (failed) {
    return {
      error: `split filing failed earlier (${failed.error}) — send the design back to re-run the plan, which is the only retry`,
      status: 409,
    }
  }
  return { skipped: true }
}

// approveGate's own preconditions, checked before anything is filed: if the
// gate cannot be approved, nothing is filed and approveGate says why.
function canApprove(item) {
  return (
    !isClosed(item) &&
    !isAbandoned(item) &&
    item.cursor === DESIGN_GATE_INDEX &&
    store.isProjectEnabled(item.project_id)
  )
}

// { ok, skipped } when there is nothing to file, { ok, target } once filed,
// or { error, status } — and then the gate must stay open.
export async function fileApprovedSplit(item, actor = 'You') {
  if (!item || !canApprove(item)) return { ok: true, skipped: true }
  const claimed = claim(item)
  if (claimed.error) return claimed
  if (claimed.skipped) return { ok: true, skipped: true }
  const row = claimed.row
  const split = JSON.parse(row.payload_json)
  let dependencyAdded = null
  try {
    const repoRow = store.findRepo(row.target_repo)
    if (!repoRow || repoRow.project_id !== item.project_id) {
      throw new Error(`${row.target_repo} is no longer connected to this item’s project`)
    }

    let ghIssue = await github.findSplitIssue(row.target_repo, splitMarker(item.id), sinceIso(row.created_at))
    if (!ghIssue) {
      ghIssue = await github.createIssue(row.target_repo, {
        title: split.title,
        outcome: split.description,
        metric: split.metric,
        guardrails: split.guardrails,
        priority: item.priority,
        bodySuffix: splitBodySuffix(item),
      })
    }
    setTargetIssue.run(ghIssue.number, row.id)

    // The webhook may have synced it already; either way the item is looked
    // up by repo and issue, never built from the prefix by hand.
    store.upsertFromGithub(ghIssue, row.target_repo)
    const target = store.findItemByIssue(row.target_repo, ghIssue.number)
    if (!target) throw new Error(`${row.target_repo}#${ghIssue.number} did not sync in as an item`)

    const dep = store.addDependency(item.id, target.id, 'Horizon')
    if (dep.error) throw new Error(dep.message || `could not add the dependency on ${target.id} (${dep.error})`)
    dependencyAdded = dep.unchanged ? null : target.id

    // GitHub first: upsertFromGithub reads desc from the issue body, so a
    // local-only rewrite would be reverted by the next sync.
    const desc = split.remaining_description || item.desc
    const metric = split.remaining_metric || item.metric
    if (split.remaining_description || split.remaining_metric) {
      if (item.repo && item.issue != null) await github.pushIssueScope(item, { desc, metric })
      store.applySplitScope(item.id, { desc, metric })
    }

    finish.run('filed', null, target.id, row.id)
    store.addEvent(item.id, {
      who: 'Horizon',
      text: `filed the upstream part of this plan as ${target.id} (\`${row.target_repo}#${ghIssue.number}\`) on ${actor}’s approval — this item waits for it to close`,
      color: '#0E6E74',
      initials: 'HZ',
    })
    store.notifyChange()
    return { ok: true, target: target.id }
  } catch (err) {
    // No half-made split: a dependency this attempt added is taken back.
    if (dependencyAdded) store.removeDependency(item.id, dependencyAdded, 'Horizon')
    const message = redact(err.message)
    finish.run('failed', message, null, row.id)
    store.addEvent(item.id, {
      who: 'Horizon',
      text: `could not file the split on ${row.target_repo}: ${message} — nothing is waiting on it and the gate stays open`,
      color: '#9C333E',
      initials: 'HZ',
    })
    store.notifyChange()
    return { error: `split filing failed: ${message}`, status: 502 }
  } finally {
    inflight.delete(row.id)
  }
}
