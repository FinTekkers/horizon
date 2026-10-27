// HZ-463: a Plan's two review steps check its current draft before the owner
// files it. This module gathers their context from the database — read only —
// and domain/js/planReview.js decides the findings:
// - `Review drafts: coverage & overlap` maps every Inventory gap to a draft or
//   marks it out of scope, and finds drafts that duplicate an open item. Its
//   agent judges both; the server re-checks every claim.
// - `Review drafts: metrics & size` finds drafts outside 3–5 metric lines or
//   3–4 guardrails, and real keys that name no existing item. The server
//   computes both; its agent adds advisory notes only.
//
// The draft is read only through currentDraft(). Nothing here writes: no
// work item, issue, dependency link or draft version, and no GitHub call. A
// finding never fails the step; it is shown at the human-only Approve & file
// gate through the step's artifact.

import { db } from './db.js'
import { currentDraft, draftKeyContext } from './planDraft.js'
import { getPlanScope } from './store.js'
import { inventoryGaps, renderPlanReviewMd, reviewPlanDraft, validatePlanReview } from '../../domain/js/planReview.js'
import {
  PLAN_COVERAGE_REVIEW_STEP_INDEX,
  PLAN_INVENTORY_STEP_INDEX,
  PLAN_METRICS_REVIEW_STEP_INDEX,
  isAbandoned,
  isClosed,
} from '../../domain/js/lifecycle.js'

export const PLAN_REVIEW_INPUT_LABEL = 'Plan review input'
// The open items the prompt lists. The server's own title check always reads
// every open item.
export const PROMPT_OPEN_ITEMS_CAP = 300

// The finding types each review step shows.
const STEP_TYPES = {
  [PLAN_COVERAGE_REVIEW_STEP_INDEX]: ['uncovered_gap', 'overlap'],
  [PLAN_METRICS_REVIEW_STEP_INDEX]: ['size', 'unknown_key'],
}

export const isPlanReviewStep = (stepIndex) => Object.hasOwn(STEP_TYPES, stepIndex)

// Every open item in the Plan's repos but the Plan itself, newest first, as
// { key, title, repo }.
function openItemsInScope(item) {
  const repos = getPlanScope(item.id).repos.map((r) => r.repo)
  if (repos.length === 0) return []
  return db
    .prepare(
      `SELECT id, title, repo, cursor, kind, abandoned_at FROM work_item
       WHERE repo IN (${repos.map(() => '?').join(', ')}) AND id != ? ORDER BY rowid DESC`,
    )
    .all(...repos, item.id)
    .filter((row) => !isClosed(row) && !isAbandoned(row))
    .map((row) => ({ key: row.id, title: row.title, repo: row.repo }))
}

// The gaps in the Plan's latest Inventory artifact: { gaps } or { error }.
function latestGaps(item) {
  const row = db
    .prepare(
      `SELECT artifact FROM step_run WHERE item_id = ? AND step_index = ? AND substep_id IS NULL AND status = 'done' AND artifact IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(item.id, PLAN_INVENTORY_STEP_INDEX)
  return row ? inventoryGaps(row.artifact) : { error: 'the Plan has no Inventory artifact' }
}

// The `Plan review input` artifact both review steps are dispatched with: the
// current draft, the Inventory's gaps and the open items in scope, as JSON.
export function planReviewInput(item) {
  const draft = currentDraft(item.id)
  const inventory = latestGaps(item)
  const open = openItemsInScope(item)
  const content = {
    draft: draft?.doc ?? null,
    gaps: inventory.gaps ?? [],
    ...(inventory.error ? { gaps_error: inventory.error } : {}),
    open_items: open.slice(0, PROMPT_OPEN_ITEMS_CAP),
    ...(open.length > PROMPT_OPEN_ITEMS_CAP ? { truncated: true } : {}),
  }
  return { label: PLAN_REVIEW_INPUT_LABEL, content: JSON.stringify(content, null, 2) }
}

// The review step's findings against the current draft, and the
// `## Review findings` section for its artifact. `reply` is the coverage
// step's `plan_review`; it is ignored for the metrics step.
export function reviewStep(item, stepIndex, reply) {
  const types = STEP_TYPES[stepIndex]
  const draft = currentDraft(item.id)
  if (!draft) return { findings: [], md: renderPlanReviewMd([], types, ['no draft to review']) }
  const notes = []
  const context = { doc: draft.doc, ...draftKeyContext(item) }
  if (stepIndex === PLAN_COVERAGE_REVIEW_STEP_INDEX) {
    const inventory = latestGaps(item)
    if (inventory.error) notes.push(`Inventory block unreadable: ${inventory.error}; coverage was not checked`)
    else context.gaps = inventory.gaps
    const checked = validatePlanReview(reply)
    if (checked.ok) Object.assign(context, { coverage: reply.coverage, overlaps: reply.overlaps })
    else notes.push(`the agent's plan_review was not usable (${checked.errors[0].message}), so every gap counts as uncovered`)
    context.openItems = openItemsInScope(item)
  }
  const findings = reviewPlanDraft(context).filter((f) => types.includes(f.type))
  return { findings, md: renderPlanReviewMd(findings, types, notes) }
}
