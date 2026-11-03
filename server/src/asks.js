// HZ-728: a step's follow-up and prerequisite work as data. A reply may carry
// an `asks` list next to its artifact; each ask is a complete draft item plus
// the one line that says why. This module validates each ask with the
// server's own context (the project's connected repos) and stores it in the
// `ask` table, linked to the item and the step run. A PM `split` is recorded
// here too, as an ask of kind 'split'.
//
// Recorded and shown only: nothing here calls GitHub, adds a dependency or
// touches a gate. A refused ask is never fatal — the step's artifact and its
// valid asks are still stored, and the artifact's `## Asks` section names the
// field that failed.
//
// Depends on db.js and leaf modules only; callers pass in what it needs (the
// connected repos) and write the events, so nothing here imports store.js.

import { db } from './db.js'
import { redact } from './caretakerRules.js'
import { HOST_PATH, hasHostPath } from './planText.js'
import { STEPS } from '../../domain/js/lifecycle.js'
import { fieldByName } from '../../domain/js/fields.js'

// What an agent may send. 'split' is written by recordSplitAsk only. The
// status column has no CHECK, so later items can add their own; this module
// writes 'open' and 'superseded'.
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
const selectOpen = db.prepare("SELECT * FROM ask WHERE item_id = ? AND status = 'open' ORDER BY id DESC")

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

function parseDraft(json) {
  try {
    const draft = JSON.parse(json)
    return draft && typeof draft === 'object' ? draft : {}
  } catch {
    return {}
  }
}

// The item snapshot's `asks`: open asks, newest first, with the step by name.
export function openAsks(itemId) {
  return selectOpen.all(itemId).map((row) => {
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
    }
  })
}
