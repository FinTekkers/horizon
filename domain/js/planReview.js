// The JS binding for a Plan's draft review (HZ-463). The two review steps
// check the current draft before the owner files it; the server decides every
// finding here and never trusts the farm's. Nothing here reads a database or
// files anything: server/src/planReview.js gathers the context, and the
// findings only inform the human-only Approve & file gate.
//
// Four kinds of finding, each naming the offending draft's `#n`:
// - uncovered_gap: an Inventory gap no draft covers and none marked out of
//   scope. It has no offending draft, so its `draft` is null and it names the
//   gap's `repo` and text instead.
// - overlap: a draft that duplicates an open item in one of the Plan's repos —
//   an agent's claim against such an item, or an exactly equal title.
// - size: a draft outside 3–5 metric lines or 3–4 guardrails, the bounds of
//   domain/planDraft.schema.json and domain/fields.json, never restated.
// - unknown_key: a real key a draft names that is no existing item. A closed
//   item is an existing one.
//
// The coverage step's `plan_review` reply is domain/planReview.schema.json,
// interpreted here directly; domain/py/plan_review.py checks it on the farm.

import source from '../planReview.schema.json' with { type: 'json' }
import { PLAN_DRAFT_SCHEMA, realKeysIn } from './planDraft.js'
import { parseInventory } from './planInventory.js'

export const FINDING_TYPES = ['uncovered_gap', 'overlap', 'size', 'unknown_key']

const DRAFT_ITEM = PLAN_DRAFT_SCHEMA.properties.items.items.properties
const at = (parent, key) => (typeof key === 'number' ? `${parent}[${key}]` : parent ? `${parent}.${key}` : key)
const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  null: (v) => v === null,
}

// The first way `value` breaks `node`, as [path, detail], or null. Only the
// keywords planReview.schema.json uses.
function shape(node, value, path) {
  const types = [node.type].flat()
  if (!types.some((t) => TYPE_CHECKS[t](value))) return [path, `must be ${types.join(' or ')}`]
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = shape(node.items, value[i], at(path, i))
      if (found) return found
    }
  } else if (TYPE_CHECKS.object(value)) {
    const props = node.properties || {}
    for (const field of node.required || []) {
      if (!Object.hasOwn(value, field)) return [at(path, field), 'is missing']
    }
    const unknown = Object.keys(value).filter((k) => !Object.hasOwn(props, k)).sort()
    if (node.additionalProperties === false && unknown.length) return [path, `has unknown field(s): ${unknown.join(', ')}`]
    for (const [field, sub] of Object.entries(props)) {
      if (!Object.hasOwn(value, field)) continue
      const found = shape(sub, value[field], at(path, field))
      if (found) return found
    }
  } else if (typeof value === 'string') {
    if (value.trim().length < (node.minLength ?? 0)) return [path, 'must not be blank']
    if (node.pattern && !new RegExp(node.pattern).test(value)) return [path, `${JSON.stringify(value)} is not in the expected form`]
  }
  return null
}

// Whether the coverage step's `plan_review` reply satisfies the contract:
// { ok: true }, or { ok: false, errors: [{ path, code, message }] } naming the
// first rule it breaks.
export function validatePlanReview(reply) {
  const found = shape(source, reply, 'plan_review')
  if (found) {
    const [path, detail] = found
    return { ok: false, errors: [{ path, code: 'invalid_shape', message: `invalid_shape: ${path} ${detail}` }] }
  }
  for (const [i, entry] of reply.coverage.entries()) {
    if ((entry.draft === null) !== Object.hasOwn(entry, 'out_of_scope_reason')) {
      const path = `plan_review.coverage[${i}]`
      const message = 'invalid_shape: a gap names a draft, or is null with an out_of_scope_reason — never both, never neither'
      return { ok: false, errors: [{ path, code: 'invalid_shape', message }] }
    }
  }
  return { ok: true }
}

// Every gap in an Inventory artifact, as { gaps: [{ repo, gap }] }, or
// { error } when it carries no readable block. Reads the block HZ-447 renders
// and HZ-462 parses, as it is.
export function inventoryGaps(artifactMd) {
  const inventory = parseInventory(artifactMd)
  if (!inventory) return { error: 'the Inventory artifact carries no readable plan-inventory block' }
  return { gaps: inventory.repos.flatMap((row) => row.gaps.map((gap) => ({ repo: row.repo, gap }))) }
}

// A title as compared for an overlap: lower case, no punctuation, one space.
const normalTitle = (title) =>
  String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const lines = (value) => (Array.isArray(value) ? value.length : 0)

function uncoveredGaps(gaps, coverage, ids) {
  const covers = (entry, { repo, gap }) =>
    entry.repo === repo &&
    entry.gap.trim() === gap.trim() &&
    (entry.draft === null ? Object.hasOwn(entry, 'out_of_scope_reason') : ids.has(entry.draft))
  return gaps
    .filter((g) => !coverage.some((entry) => covers(entry, g)))
    .map(({ repo, gap }) => ({
      type: 'uncovered_gap',
      draft: null,
      path: 'coverage',
      repo,
      gap,
      message: `no draft covers the ${repo} gap "${gap}", and it is not marked out of scope`,
    }))
}

function overlapsWith(items, overlaps, openItems) {
  const open = new Map(openItems.map((o) => [o.key, o]))
  const found = new Map()
  const add = (i, key, why) => {
    const draft = items[i].id
    if (found.has(`${draft} ${key}`)) return
    const { title, repo } = open.get(key)
    found.set(`${draft} ${key}`, {
      type: 'overlap',
      draft,
      path: `items[${i}]`,
      key,
      message: `${draft} duplicates the open ${repo} item ${key} "${title}": ${why}`,
    })
  }
  const index = new Map(items.map((item, i) => [item.id, i]))
  for (const claim of overlaps) {
    if (index.has(claim.draft) && open.has(claim.key)) add(index.get(claim.draft), claim.key, claim.reason)
  }
  for (const [i, item] of items.entries()) {
    for (const o of openItems) {
      if (normalTitle(o.title) === normalTitle(item.title)) add(i, o.key, 'the titles match')
    }
  }
  return [...found.values()]
}

function sizes(items) {
  const out = []
  for (const [i, item] of items.entries()) {
    for (const name of ['metric', 'guardrails']) {
      const { minItems, maxItems } = DRAFT_ITEM[name]
      const n = lines(item[name])
      if (n < minItems || n > maxItems) {
        out.push({
          type: 'size',
          draft: item.id,
          path: `items[${i}].${name}`,
          message: `${item.id} has ${n} ${name} line(s); a draft keeps ${minItems} to ${maxItems}`,
        })
      }
    }
  }
  return out
}

function unknownKeys(doc, keyExists, keyPrefixes) {
  const finding = (draft, path, key) => ({
    type: 'unknown_key',
    draft,
    path,
    key,
    message: `${draft ?? 'the shared text'} names ${key}, which is not an existing item — name a new item only by #n`,
  })
  const out = []
  for (const [i, item] of doc.items.entries()) {
    for (const key of realKeysIn({ items: [item] }, keyPrefixes)) {
      if (!keyExists(key)) out.push(finding(item.id, `items[${i}]`, key))
    }
  }
  const shared = { shared_guardrails: doc.shared_guardrails ?? [], open_questions: doc.open_questions ?? [] }
  for (const key of realKeysIn(shared, keyPrefixes)) {
    if (!keyExists(key)) out.push(finding(null, 'shared', key))
  }
  return out
}

// Every finding against a draft document, in FINDING_TYPES order:
// - `gaps`: [{ repo, gap }] from the Inventory (inventoryGaps);
// - `coverage`, `overlaps`: the coverage step's checked `plan_review`;
// - `openItems`: [{ key, title, repo }], every open item in the Plan's repos;
// - `keyExists(key)`, `keyPrefixes`: the server's real-key context, as
//   validatePlanDraft takes it.
// A pure function: HZ-449 can call it again before filing.
export function reviewPlanDraft({ doc, gaps = [], coverage = [], overlaps = [], openItems = [], keyExists = () => false, keyPrefixes = [] }) {
  const items = doc.items
  return [
    ...uncoveredGaps(gaps, coverage, new Set(items.map((item) => item.id))),
    ...overlapsWith(items, overlaps, openItems),
    ...sizes(items),
    ...unknownKeys(doc, keyExists, keyPrefixes),
  ]
}

// The `## Review findings` section a review step appends to its artifact:
// the findings of `types`, then any advisory `notes`.
export function renderPlanReviewMd(findings, types, notes = []) {
  const shown = findings.filter((f) => types.includes(f.type))
  const rows = shown.length
    ? shown.map((f) => `- **${f.type}**${f.draft ? ` \`${f.draft}\`` : ''}: ${f.message}`)
    : [`- None: no ${types.join(' or ')} finding.`]
  return ['## Review findings', ...rows, ...notes.map((n) => `- Note: ${n}`)].join('\n')
}
