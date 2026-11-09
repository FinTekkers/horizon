// HZ-728: a step's follow-up and prerequisite work as data. A reply may carry
// an `asks` list next to its artifact; each ask is a complete draft item plus
// the one line that says why. This module validates each ask with the
// server's own context (the project's connected repos) and stores it in the
// `ask` table, linked to the item and the step run. A PM `split` is recorded
// here too, as an ask of kind 'split'.
//
// A refused ask is never fatal — the step's artifact and its valid asks are
// still stored, and the artifact's `## Asks` section names the field that
// failed.
//
// HZ-730: the owner acts on an open ask. fileAsk files its draft (the
// reviewer's amended one when there is one) through the injected spawnItems
// and, for a blocking ask, links it as a dependency through the injected
// linkSpawned. dismissAsk closes it with a reason, queued for the item's next
// agent step through the injected queueFeedbackOnce. Nothing here touches a
// gate.
//
// HZ-820: a soft ask never outlives its item. moveItem calls
// dismissSoftAsksForParent in the move's own transaction when the item closes
// or is abandoned: its open soft asks are dismissed by Horizon with the
// parent reason (db.js PARENT_REASONS), no feedback queued and no GitHub call.
// Blocking asks and splits are left alone. The item page lists those asks
// (parentClosedAsks) and File it still files one by hand.
//
// Depends on db.js and leaf modules only; callers pass in what it needs (the
// connected repos, the spawn and feedback calls) and write the events, so
// nothing here imports store.js or spawn.js.

import { PARENT_ABANDONED_REASON, PARENT_CLOSED_REASON, PARENT_REASONS, db } from './db.js'
import { redact } from './caretakerRules.js'
import { HOST_PATH, hasHostPath } from './planText.js'
import { STEPS } from '../../domain/js/lifecycle.js'
import { fieldByName } from '../../domain/js/fields.js'

// What an agent may send. 'split' is written by recordSplitAsk only. The
// status column has no CHECK, so later items can add their own; this module
// writes 'open', 'superseded', 'filed', 'dismissed' and 'released' (HZ-802).
export const ASK_KINDS = ['blocking', 'soft']
export const MAX_ASKS = 8
export const METRIC_MIN_LINES = 3
export const METRIC_MAX_LINES = 5
const WHY_MAX = 300

// Each draft field, the work-item limit it is held to, in report order.
const FIELD_CAPS = {
  title: fieldByName('title').maxLength,
  repo: fieldByName('repo').maxLength,
  outcome: fieldByName('outcome').maxLength,
  metric: fieldByName('metric').maxLength,
  guardrails: fieldByName('guardrails').maxLength,
  why: WHY_MAX,
}
const DRAFT_FIELDS = ['title', 'repo', 'outcome', 'metric', 'guardrails']

const insertAsk = db.prepare(
  "INSERT INTO ask (item_id, step_run_id, step_index, kind, status, draft_json, why, item_split_id) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)",
)
const supersedeStep = db.prepare(
  "UPDATE ask SET status = 'superseded', updated_at = datetime('now') WHERE item_id = ? AND step_index = ? AND step_run_id != ? AND status = 'open'",
)
// HZ-729: each open ask with its review (server/src/askReview.js), if any.
const WITH_REVIEW = `SELECT a.*, r.id AS review_id, r.status AS review_status, r.provider AS review_provider, r.verdict AS review_verdict,
          r.reasons_json AS review_reasons_json, r.amended_draft_json AS review_amended_draft_json,
          r.refers_to_json AS review_refers_to_json, r.wait_reason AS review_wait_reason,
          r.contradiction_json AS review_contradiction_json
     FROM ask a LEFT JOIN ask_review r ON r.ask_id = a.id`
const selectOpen = db.prepare(`${WITH_REVIEW} WHERE a.item_id = ? AND a.status = 'open' ORDER BY a.id DESC`)

// HZ-730: who resolved an ask, and how. 'filed' is set by id whatever the
// status, so an ask a step re-run superseded mid-filing still names its item.
const selectAsk = db.prepare('SELECT * FROM ask WHERE id = ? AND item_id = ?')
const selectReviewOf = db.prepare('SELECT status, verdict, amended_draft_json FROM ask_review WHERE ask_id = ?')
const markFiled = db.prepare(
  "UPDATE ask SET status = 'filed', filed_item_id = ?, resolved_by = ?, resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
)
const markDismissed = db.prepare(
  "UPDATE ask SET status = 'dismissed', dismiss_reason = ?, resolved_by = ?, resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'open'",
)
// HZ-802: the owner's override for a filed blocking ask that still holds the
// start step. Only a filed ask; an open one is dismissed instead.
const markReleased = db.prepare(
  "UPDATE ask SET status = 'released', dismiss_reason = ?, resolved_by = ?, resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'filed'",
)
export const DISMISS_REASON_MAX = 500

// ---- HZ-820: soft asks close with their item ----

export { PARENT_ABANDONED_REASON, PARENT_CLOSED_REASON, PARENT_REASONS }

const dismissParentSoft = db.prepare(
  `UPDATE ask SET status = 'dismissed', dismiss_reason = ?, resolved_by = 'Horizon', resolved_at = datetime('now'),
          updated_at = datetime('now')
    WHERE item_id = ? AND kind = 'soft' AND status = 'open'`,
)
// The SQL test for an ask Horizon dismissed because its item closed, over
// the `ask` row aliased `a` — askReview.js reviews these too.
export const PARENT_DISMISSED_SQL = `(a.kind = 'soft' AND a.status = 'dismissed' AND a.resolved_by = 'Horizon' AND a.dismiss_reason IN (${PARENT_REASONS.map((r) => `'${r}'`).join(', ')}))`
const selectParentDismissed = db.prepare(`${WITH_REVIEW} WHERE a.item_id = ? AND ${PARENT_DISMISSED_SQL} ORDER BY a.id DESC`)

// Both checks: dismissAsk's actor also defaults to 'Horizon', so resolved_by
// alone could match an owner's dismissal.
export const isParentDismissed = (row) =>
  row.kind === 'soft' && row.status === 'dismissed' && row.resolved_by === 'Horizon' && PARENT_REASONS.includes(row.dismiss_reason)

// Dismisses the item's open soft asks with `reason`. No feedback, no event,
// no GitHub call. Returns how many it closed.
export function dismissSoftAsksForParent(itemId, reason) {
  return dismissParentSoft.run(reason, itemId).changes
}

export const stepLabel = (stepIndex) => STEPS[stepIndex]?.label ?? 'an unknown step'

const nonBlankLines = (text) => text.split('\n').filter((l) => l.trim()).length

// { ask } for one that may be stored, or { refused: { field, message } }
// naming the first field that failed. `repos` lists the item's project's
// connected repos.
export function validateAsk(raw, { repos = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { refused: { field: 'ask', message: 'is not an object' } }
  }
  const kind = Object.hasOwn(raw, 'kind') ? raw.kind : undefined
  if (!ASK_KINDS.includes(kind)) {
    return { refused: { field: 'kind', message: `must be ${ASK_KINDS.join(' or ')}` } }
  }
  const ask = { kind }
  for (const [field, cap] of Object.entries(FIELD_CAPS)) {
    const value = Object.hasOwn(raw, field) && typeof raw[field] === 'string' ? raw[field].trim() : ''
    if (!value) return { refused: { field, message: 'is missing' } }
    if (value.length > cap) return { refused: { field, message: `is over ${cap} characters` } }
    // Refused, not scrubbed as a split is, so the reason can name the field.
    // oneLine: false — the default would collapse every multi-line field.
    if (redact(value, { oneLine: false }) !== value) return { refused: { field, message: 'holds a token or secret' } }
    if (hasHostPath(value)) return { refused: { field, message: 'holds a host path' } }
    ask[field] = value
  }
  ask.title = ask.title.replace(/\s+/g, ' ')
  const lines = nonBlankLines(ask.metric)
  if (lines < METRIC_MIN_LINES || lines > METRIC_MAX_LINES) {
    return { refused: { field: 'metric', message: `has ${lines} lines; ${METRIC_MIN_LINES}–${METRIC_MAX_LINES} required` } }
  }
  if (ask.why.includes('\n')) return { refused: { field: 'why', message: 'must be one line' } }
  const connected = repos.find((r) => r.toLowerCase() === ask.repo.toLowerCase())
  if (!connected) return { refused: { field: 'repo', message: `\`${ask.repo}\` is not connected to this item’s project` } }
  ask.repo = connected
  return { ask }
}

// How a refusal names the ask. The artifact is posted to the issue, so a
// refused title is echoed with its tokens and host paths taken out.
const titleOf = (raw, n) =>
  raw && typeof raw === 'object' && typeof raw.title === 'string' && raw.title.trim()
    ? `“${redact(raw.title).replace(HOST_PATH, '[host path removed]').slice(0, 80)}”`
    : `ask ${n}`

function countLine(stored) {
  const counts = ASK_KINDS.map((kind) => [kind, stored.filter((a) => a.kind === kind).length]).filter(([, n]) => n > 0)
  return counts.length > 0 ? counts.map(([kind, n]) => `${n} ${kind}`).join(', ') : 'none'
}

// Validates the reply's `asks`, supersedes this step's open asks from earlier
// runs, and stores the valid ones — one transaction, no awaits. Returns the
// artifact with a `## Asks` section appended when the reply sent any, and the
// refusals ({ ask, field, message, step }) for the caller's events.
export function ingestAsks(item, runId, stepIndex, rawAsks, artifactMd, { repos = [] } = {}) {
  const step = stepLabel(stepIndex)
  const stored = []
  const refused = []
  let ignored = false
  db.transaction(() => {
    supersedeStep.run(item.id, stepIndex, runId)
    if (rawAsks == null) return
    if (!Array.isArray(rawAsks)) {
      ignored = true
      return
    }
    rawAsks.forEach((raw, i) => {
      const name = titleOf(raw, i + 1)
      if (i >= MAX_ASKS) {
        refused.push({ ask: name, field: 'asks', message: `too many asks; at most ${MAX_ASKS} are stored`, step })
        return
      }
      const checked = validateAsk(raw, { repos })
      if (checked.refused) {
        refused.push({ ask: name, ...checked.refused, step })
        return
      }
      const { ask } = checked
      const draft = Object.fromEntries(DRAFT_FIELDS.map((f) => [f, ask[f]]))
      insertAsk.run(item.id, runId, stepIndex, ask.kind, JSON.stringify(draft), ask.why, null)
      stored.push(ask)
    })
  })()
  if (!ignored && stored.length === 0 && refused.length === 0) return { artifactMd, stored, refused }
  const lines = ['## Asks']
  if (ignored) lines.push(`- **Not stored:** “${step}” sent \`asks\` that is not a list.`)
  else lines.push(`- **Stored:** ${countLine(stored)}.`)
  for (const r of refused) lines.push(`- **Not stored:** ${r.ask} from “${r.step}” — \`${r.field}\` ${r.message}.`)
  return { artifactMd: [artifactMd, lines.join('\n')].filter(Boolean).join('\n\n'), stored, refused }
}

// The split proposeSplit just recorded as 'proposed', as an ask of kind
// 'split' linked to its item_split row. The split's own row, payload and
// filing are untouched; this is the read-only record beside it. Written
// after recordProposedSplit commits (not in its transaction): a re-run of the
// step supersedes it by step_index, as it does every other ask.
export function recordSplitAsk(item, runId, stepIndex, split, itemSplitId) {
  const draft = {
    title: split.title,
    repo: split.repo,
    outcome: split.description,
    metric: split.metric,
    guardrails: split.guardrails || '',
  }
  insertAsk.run(item.id, runId, stepIndex, 'split', JSON.stringify(draft), `Split proposed at “${stepLabel(stepIndex)}”`, itemSplitId)
}

function parseJson(json, fallback) {
  try {
    const value = JSON.parse(json)
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

const parseDraft = (json) => parseJson(json, {})

// HZ-729: the ask's review as the snapshot shows it, or null before the first
// sweep. Only status 'done' is a real reviewer verdict; 'failed' and
// 'interrupted' carry 'escalate' with the reason no review came back. The
// body sent to the reviewer (input_json) is never shown.
function reviewOf(row) {
  if (row.review_id == null) return null
  const reasons = parseJson(row.review_reasons_json, null)
  const refersTo = parseJson(row.review_refers_to_json, null)
  return {
    status: row.review_status,
    provider: row.review_provider,
    verdict: row.review_verdict,
    reasons: Array.isArray(reasons) ? reasons : [],
    amended_draft: row.review_amended_draft_json ? parseJson(row.review_amended_draft_json, null) : null,
    refers_to: Array.isArray(refersTo) ? refersTo : [],
    wait_reason: row.review_wait_reason,
    contradiction: parseJson(row.review_contradiction_json, null),
  }
}

// One ask as the snapshot shows it, with the step by name.
function askView(row) {
  const draft = parseDraft(row.draft_json)
  return {
    id: row.id,
    kind: row.kind,
    step: stepLabel(row.step_index),
    title: draft.title ?? '',
    repo: draft.repo ?? '',
    outcome: draft.outcome ?? '',
    metric: draft.metric ?? '',
    guardrails: draft.guardrails ?? '',
    why: row.why,
    created_at: row.created_at,
    review: reviewOf(row),
  }
}

// The item snapshot's `asks`: open asks, newest first.
export function openAsks(itemId) {
  return selectOpen.all(itemId).map(askView)
}

// HZ-820: the item's soft asks Horizon dismissed when it closed or was
// abandoned, newest first, with the reason and when.
export function parentClosedAsks(itemId) {
  return selectParentDismissed.all(itemId).map((row) => ({ ...askView(row), dismiss_reason: row.dismiss_reason, resolved_at: row.resolved_at }))
}

// ---- HZ-731: blocking asks hold gates and the start of work ----

// Only kind 'blocking' is read: a soft ask or a split never holds anything.
const selectOpenBlocking = db.prepare("SELECT id, draft_json FROM ask WHERE item_id = ? AND kind = 'blocking' AND status = 'open' ORDER BY id")
// Open and filed blocking asks, oldest first, each with the item it filed (the
// work_item row's fields the start check reads, or NULLs while unfiled).
const selectStartAsks = db.prepare(`
  SELECT a.id, a.status, a.draft_json, w.id AS filed_id, w.title AS filed_title, w.cursor AS filed_cursor,
         w.kind AS filed_kind, w.merged_at AS filed_merged_at, w.abandoned_at AS filed_abandoned_at
    FROM ask a LEFT JOIN work_item w ON w.id = a.filed_item_id
   WHERE a.item_id = ? AND a.kind = 'blocking' AND a.status IN ('open','filed') ORDER BY a.id`)
const selectAskHolders = db.prepare("SELECT DISTINCT item_id FROM ask WHERE filed_item_id = ? AND kind = 'blocking' AND status = 'filed'")

// The item's open blocking asks as { id, title }. Caretaker approves no gate
// while this is non-empty.
export function openBlockingAsks(itemId) {
  return selectOpenBlocking.all(itemId).map((row) => ({ id: row.id, title: parseDraft(row.draft_json).title ?? '' }))
}

// What lifecycle.askStartHold judges: each open or filed blocking ask, with
// its filed item as a work_item-shaped row (null while unfiled). A dismissed
// or superseded ask is not listed, so it holds nothing.
export function startCheckAsks(itemId) {
  return selectStartAsks.all(itemId).map((row) => ({
    id: row.id,
    status: row.status,
    title: parseDraft(row.draft_json).title ?? '',
    filed:
      row.filed_id == null
        ? null
        : { id: row.filed_id, title: row.filed_title, cursor: row.filed_cursor, kind: row.filed_kind, merged_at: row.filed_merged_at, abandoned_at: row.filed_abandoned_at },
  }))
}

// The items whose blocking ask filed `filedItemId`: woken when it merges or
// closes, even if the owner removed the dependency edge File it added.
export const askHolderIds = (filedItemId) => selectAskHolders.all(filedItemId).map((row) => row.item_id)

// ---- HZ-730: File it and Dismiss ----

// The item_spawn request key one ask files under. One key per ask, so a
// second File it finds the first one's row and files nothing.
export const askRequestKey = (askId) => `ask:${askId}`

export const getAsk = (itemId, askId) => selectAsk.get(askId, itemId) ?? null

// The draft File it would file: the reviewer's amended draft when the verdict
// is amend, else the ask's own.
function chosenDraft(row, review) {
  const amended = review?.verdict === 'amend' && review.amended_draft_json ? parseJson(review.amended_draft_json, null) : null
  return amended ?? parseDraft(row.draft_json)
}

// The draft re-checked at file time, as at ingest: secrets, host paths, the
// field limits, the metric's line count, and the repo against the project's
// connected repos. { draft } or { error, status, field }.
export function effectiveDraft(row, review, { repos = [] } = {}) {
  const draft = chosenDraft(row, review)
  const raw = { kind: 'soft', why: row.why, ...Object.fromEntries(DRAFT_FIELDS.map((f) => [f, Object.hasOwn(draft, f) ? draft[f] : undefined])) }
  // Text first, with the draft's own repo let through; then the project check,
  // so a foreign repo is named as such rather than as a bad field.
  const checked = validateAsk(raw, { repos: typeof raw.repo === 'string' ? [raw.repo.trim()] : [] })
  if (checked.refused) return { error: 'draft_invalid', status: 422, field: checked.refused.field, message: `\`${checked.refused.field}\` ${checked.refused.message}` }
  const connected = repos.find((r) => r.toLowerCase() === checked.ask.repo.toLowerCase())
  if (!connected) return { error: 'repo_not_in_project', status: 409, message: `${checked.ask.repo} is not connected to this item’s project` }
  return { draft: { ...Object.fromEntries(DRAFT_FIELDS.map((f) => [f, checked.ask[f]])), repo: connected } }
}

// Files one open blocking or soft ask, or a soft ask Horizon dismissed when
// its item closed (HZ-820). spawnItems files under the ask's own
// request key (a retry after a half-finished call files nothing new) and a
// blocking ask's item becomes a dependency of the asking item. The ask must
// have been reviewed first (HZ-729); an escalated ask is the owner's call.
// { ok, itemId, alreadyFiled, dependencyAdded } or { error, status }.
export async function fileAsk(item, askId, { repos = [], actor = 'Horizon', spawnItems, linkSpawned }) {
  const row = getAsk(item.id, askId)
  if (!row) return { error: 'not_found', status: 404 }
  if (!ASK_KINDS.includes(row.kind)) return { error: 'ask_not_fileable', status: 409, message: 'A split is filed at its own gate.' }
  if (row.status === 'filed') return { ok: true, itemId: row.filed_item_id, alreadyFiled: true, dependencyAdded: false }
  if (row.status !== 'open' && !isParentDismissed(row)) return { error: 'ask_closed', status: 409, message: `This ask is ${row.status}.` }
  const review = selectReviewOf.get(row.id)
  if (!review?.verdict) return { error: 'ask_not_reviewed', status: 409, message: 'This ask has not been reviewed yet.' }
  const checked = effectiveDraft(row, review, { repos })
  if (checked.error) return checked
  const key = askRequestKey(row.id)
  const blocking = row.kind === 'blocking'
  const filed = await spawnItems(item, [checked.draft], { requestKey: key, kind: 'change', actor, waits: blocking })
  if (filed.error) return filed
  const itemId = filed.children[0]
  let dependencyAdded = false
  if (blocking) {
    const linked = linkSpawned(item.id, key)
    if (linked.error) return { error: 'link_failed', status: 409, message: linked.error }
    dependencyAdded = true
  }
  markFiled.run(itemId, actor, row.id)
  return { ok: true, itemId, alreadyFiled: false, dependencyAdded }
}

// Closes one open ask with the owner's reason and queues that reason for the
// asking item's next agent step, addressed to the agent of the step that
// asked. One transaction. { ok, alreadyDismissed? } or { error, status }.
export function dismissAsk(item, askId, { reason, actor = 'Horizon', queueFeedbackOnce }) {
  const text = redact(String(reason ?? ''), { oneLine: true }).trim()
  if (!text) return { error: 'reason_required', status: 400, message: 'Say why the ask is dismissed.' }
  if (text.length > DISMISS_REASON_MAX) return { error: 'reason_too_long', status: 400, message: `At most ${DISMISS_REASON_MAX} characters.` }
  const row = getAsk(item.id, askId)
  if (!row) return { error: 'not_found', status: 404 }
  if (row.status === 'dismissed') return { ok: true, alreadyDismissed: true }
  if (row.status !== 'open') return { error: 'ask_closed', status: 409, message: `This ask is ${row.status}.` }
  const title = parseDraft(row.draft_json).title ?? ''
  const message = `Owner dismissed the ask “${title}” from “${stepLabel(row.step_index)}”: ${text}`
  return db.transaction(() => {
    if (markDismissed.run(text, actor, row.id).changes === 0) return { error: 'ask_closed', status: 409, message: 'This ask is no longer open.' }
    const queued = queueFeedbackOnce(item.id, { message, target: STEPS[row.step_index]?.agent ?? 'Eng', source: 'ask' })
    if (queued.error) throw new Error(`could not queue the reason: ${queued.error}`)
    return { ok: true, title, reason: text }
  })()
}

// HZ-802: releases one filed blocking ask, so it no longer holds the asking
// item's start step (startCheckAsks lists only open and filed asks). The
// filed item and its dependency edge are left alone. { ok, title,
// filedItemId, reason, alreadyReleased? } or { error, status, message? }.
export function releaseAsk(item, askId, { reason, actor = 'Horizon' }) {
  const text = redact(String(reason ?? ''), { oneLine: true }).trim()
  if (!text) return { error: 'reason_required', status: 400, message: 'Say why the hold is released.' }
  if (text.length > DISMISS_REASON_MAX) return { error: 'reason_too_long', status: 400, message: `At most ${DISMISS_REASON_MAX} characters.` }
  const row = getAsk(item.id, askId)
  if (!row) return { error: 'not_found', status: 404 }
  const title = parseDraft(row.draft_json).title ?? ''
  if (row.status === 'released') return { ok: true, alreadyReleased: true, title, filedItemId: row.filed_item_id }
  if (row.status !== 'filed') return { error: 'ask_not_filed', status: 409, message: 'Only a filed ask can be released; dismiss an open ask.' }
  if (markReleased.run(text, actor, row.id).changes === 0) return { error: 'ask_not_filed', status: 409, message: 'This ask is no longer filed.' }
  return { ok: true, title, filedItemId: row.filed_item_id, reason: text }
}
