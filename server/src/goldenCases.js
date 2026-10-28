// HZ-541: golden cases as an item's success criteria, approved at its first
// gate.
//
// A project's golden_cases sub-step (HZ-538's snapshot, an opening sub-step)
// writes the set into its artifact. At the first gate — Change "Approve &
// prioritize this work", Task "Approve & prioritize" — a human sees it as a
// table and approves the whole set with one action; the set is then copied
// into golden_case_set, and Draft implementation plan, Implement and Review
// refuse to run without it.
//
// Off unless both hold: the project's definitions switch (HZ-535) is on, and
// the item's snapshot has a golden_cases sub-step. Off, nothing here changes
// what an item serves, how its gates approve or how its steps run.
//
// Expected values only ever come from the approved row — never from a re-read
// of the sub-step's run, and never from the repo.

import { createHash } from 'node:crypto'
import { db } from './db.js'
import { substepsOf } from '../../domain/js/substeps.js'
import { extractGoldenCases, metricLineFor, parseSource } from '../../domain/js/goldenCases.js'
import { IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, kindStepIndex, requiredStepIndex } from '../../domain/js/lifecycle.js'

export const GOLDEN_CASES_OUTPUT = 'golden_cases'
// The first gate of each item kind that has an opening sub-step.
export const FIRST_GATE_INDEXES = Object.freeze([
  requiredStepIndex('Approve & prioritize this work'),
  kindStepIndex('Approve & prioritize', 'task'),
])
// The steps that refuse to run without an approved set. v1 guards the Change
// steps only: a Task approves its set at gate 19, but guarding its Run plan
// and Execute is a follow-up item.
export const GUARDED_STEP_INDEXES = Object.freeze([requiredStepIndex('Draft implementation plan'), IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX])
export const APPROVED_ARTIFACT_LABEL = 'Approved golden cases'
export const NOT_APPROVED_TEXT =
  'golden cases are not approved — approve the set at the first gate (“Approve & prioritize this work”), or send it back to the golden-cases sub-step'
// What an approver with no table in front of it (WhatsApp, Autopilot) is told.
export const APPROVE_IN_HORIZON_TEXT = 'golden cases need a human to approve in Horizon: open the item, check its golden cases and approve the set there'
export const CHANGED_TEXT = 'the golden cases changed since this page loaded — reload and check them again'

const selectProjectSwitch = db.prepare('SELECT definitions_enabled FROM project WHERE id = ?')
// By sub-step id, like store.js's substepDoneRuns: the anchor is checked in JS.
const selectSubstepRuns = db.prepare(
  "SELECT id, step_index, artifact, output FROM step_run WHERE item_id = ? AND substep_id = ? AND status = 'done' ORDER BY id DESC",
)
const selectApproved = db.prepare('SELECT * FROM golden_case_set WHERE item_id = ?')
const selectDocs = db.prepare("SELECT slug, repo, path, sections_json FROM knowledge_doc WHERE project_id = ? AND status = 'extracted'")
const insertApproved = db.prepare(
  'INSERT INTO golden_case_set (item_id, cases_json, hash, source_run_id, approved_by) VALUES (?, ?, ?, ?, ?)',
)
const deleteApproved = db.prepare('DELETE FROM golden_case_set WHERE item_id = ?')

export const hashOf = (cases) => createHash('sha256').update(JSON.stringify(cases), 'utf8').digest('hex')

// The item's golden_cases sub-step from its snapshot, or null.
export function goldenSubstep(item) {
  return substepsOf(item).find((s) => s.output === GOLDEN_CASES_OUTPUT) ?? null
}

// item is a work_item row or getItem() — either carries project_id and
// substeps_json.
export function goldenCasesRequired(item) {
  if (!item || item.project_id == null || !goldenSubstep(item)) return false
  return selectProjectSwitch.get(item.project_id)?.definitions_enabled === 1
}

// The set the sub-step's newest done run wrote: { runId, cases, errors, hash },
// or null when it has no done run.
export function pendingGoldenCases(item) {
  const sub = goldenSubstep(item)
  const run = sub && selectSubstepRuns.all(item.id, sub.id).find((r) => r.step_index === sub.anchor)
  if (!run) return null
  const { cases, errors } = extractGoldenCases(run.artifact || run.output)
  return { runId: run.id, cases, errors, hash: cases.length ? hashOf(cases) : null }
}

export function approvedGoldenCases(itemId) {
  const row = selectApproved.get(itemId)
  if (!row) return null
  return { cases: JSON.parse(row.cases_json), hash: row.hash, approvedBy: row.approved_by, approvedAt: row.approved_at }
}

// Every case's source against the project's knowledge index, in one query:
// [{ indexed, url, title, page }] in case order.
function resolveSources(projectId, cases) {
  const docs = new Map()
  for (const row of selectDocs.all(projectId)) {
    let sections = []
    try {
      sections = JSON.parse(row.sections_json)
    } catch {
      sections = []
    }
    docs.set(row.slug, { repo: row.repo, path: row.path, sections: Array.isArray(sections) ? sections : [] })
  }
  return cases.map((c) => {
    const ref = parseSource(c.source)
    const doc = ref && docs.get(ref.doc)
    const section = doc && doc.sections.find((s) => s?.id === ref.section)
    if (!section) return { indexed: false, url: null, title: null, page: null }
    const path = doc.path.split('/').map(encodeURIComponent).join('/')
    const page = Number.isInteger(section.page) ? section.page : null
    return {
      indexed: true,
      url: `https://github.com/${doc.repo}/blob/HEAD/${path}${page ? `#page=${page}` : ''}`,
      title: typeof section.title === 'string' ? section.title : ref.section,
      page,
    }
  })
}

const unindexedErrors = (cases, sources) =>
  cases.filter((_, i) => !sources[i].indexed).map((c) => `case ${JSON.stringify(c.id)}: source ${c.source} is not in the knowledge index`)

// The approval check at a first gate, before anything is written. With an
// approved set already (a send-back that kept it brought the item back here),
// there is nothing to approve. Otherwise the pending set must be valid, every
// source indexed, and `goldenHash` the hash the approver was shown.
// { set } to store, {} for nothing to store, or { error, message }.
export function checkGoldenApproval(item, goldenHash) {
  if (approvedGoldenCases(item.id)) return {}
  const pending = pendingGoldenCases(item)
  if (!pending || (!pending.cases.length && !pending.errors.length)) {
    return { error: 'golden_cases_missing', message: 'the golden-cases sub-step has written no golden cases yet' }
  }
  const errors = pending.errors.length ? pending.errors : unindexedErrors(pending.cases, resolveSources(item.project_id, pending.cases))
  if (errors.length) return { error: 'golden_cases_invalid', message: errors[0], errors }
  if (goldenHash == null) return { error: 'golden_cases_changed', message: APPROVE_IN_HORIZON_TEXT }
  if (goldenHash !== pending.hash) return { error: 'golden_cases_changed', message: CHANGED_TEXT }
  return { set: pending }
}

export function approveGoldenCases(itemId, set, actor) {
  insertApproved.run(itemId, JSON.stringify(set.cases), set.hash, set.runId, actor)
}

export function clearGoldenCases(itemId) {
  deleteApproved.run(itemId)
}

// The prior-artifact entry Draft implementation plan, Implement and Review are
// dispatched with, from the approved row only. null when the step is not
// guarded or the item has no approved set.
export function goldenCasesInput(itemId, stepIndex) {
  if (!GUARDED_STEP_INDEXES.includes(stepIndex)) return null
  const approved = approvedGoldenCases(itemId)
  if (!approved) return null
  return {
    label: APPROVED_ARTIFACT_LABEL,
    content: `${approved.cases.length} golden cases, approved by ${approved.approvedBy}. Each needs a test that meets its expected value within its tolerance; expected values come from here, never from the code under test.\n\n\`\`\`json golden-cases\n${JSON.stringify({ cases: approved.cases }, null, 2)}\n\`\`\``,
  }
}

// { goldenCases } for the item view, or {} so an item without the feature
// serves exactly the keys it did before.
export function goldenCasesFields(row) {
  if (!goldenCasesRequired(row)) return {}
  const sub = goldenSubstep(row)
  const approved = approvedGoldenCases(row.id)
  const pending = approved ? null : pendingGoldenCases(row)
  const cases = approved ? approved.cases : (pending?.cases ?? [])
  const sources = resolveSources(row.project_id, cases)
  const errors = approved ? [] : pending ? (pending.errors.length ? pending.errors : unindexedErrors(cases, sources)) : []
  return {
    goldenCases: {
      substepId: sub.id,
      gateIndex: FIRST_GATE_INDEXES.find((i) => i > sub.anchor) ?? null,
      hash: approved ? approved.hash : (pending?.hash ?? null),
      approved: !!approved,
      approvedBy: approved?.approvedBy ?? null,
      approvedAt: approved?.approvedAt ?? null,
      // The line farm/roles/golden_cases_addendum.md has the metric step mark.
      metricLine: metricLineFor(row.metric),
      errors,
      cases: cases.map((c, i) => ({
        ...c,
        sourceIndexed: sources[i].indexed,
        sourceUrl: sources[i].url,
        sourceTitle: sources[i].title,
        sourcePage: sources[i].page,
      })),
    },
  }
}
