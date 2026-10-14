// The JS binding for a Plan's item drafts (HZ-448). farm/step_agent.py checks
// the Draft items step's `plan_draft` reply with domain/py/plan_draft.py; the
// server checks the same document again here, on ingest and on every owner
// edit, and never trusts the farm's or the browser's check.
//
// The contract is domain/planDraft.schema.json, interpreted here directly so a
// shape rule is never restated. The rules after it run in the same order as
// the Python binding, so both report the same first error: no blank text,
// unique ids, every `#n` dependency names a draft in the set, no cycle. Then
// the two only the server can answer, from the context it passes in: every
// repo is one the Plan may file in (unknown_repo) and every real key names an
// existing item, open or closed (unknown_key).

import source from '../planDraft.schema.json' with { type: 'json' }
import { fieldByName } from './fields.js'

const LOCAL_ID = /^#[1-9][0-9]*$/
const REAL_KEY = /^[A-Z][A-Z0-9]*-[0-9]+$/
const KEY_IN_TEXT = /\b([A-Z][A-Z0-9]*)-(\d+)\b/g

// The contract with the work-item field limits added from domain/fields.json,
// the one place they are declared: title and outcome lengths, repo's maximum,
// and metric's and guardrails' line caps as their maximum entries. The body
// schema of PUT /api/items/:id/plan-draft.
export const PLAN_DRAFT_SCHEMA = withFieldLimits(structuredClone(source))

function withFieldLimits(schema) {
  const item = schema.properties.items.items.properties
  for (const name of ['title', 'outcome', 'repo']) {
    const { minLength, maxLength } = fieldByName(name)
    Object.assign(item[name], minLength === undefined ? {} : { minLength }, { maxLength })
  }
  for (const name of ['metric', 'guardrails']) item[name].maxItems = fieldByName(name).maxLines
  return schema
}

const at = (parent, key) => (typeof key === 'number' ? `${parent}[${key}]` : parent ? `${parent}.${key}` : key)
const fail = (code, path, detail) => ({ ok: false, errors: [{ path, code, message: `${code}: ${detail}` }] })

// The first way `value` breaks `node`, as [path, detail], or null.
function shape(node, value, path) {
  if (node.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [path, 'must be an object']
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
  } else if (node.type === 'array') {
    if (!Array.isArray(value)) return [path, 'must be a list']
    if (value.length < (node.minItems ?? 0)) return [path, `must have at least ${node.minItems} entries`]
    if (value.length > (node.maxItems ?? value.length)) return [path, `must have at most ${node.maxItems} entries`]
    if (node.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) return [path, 'has a duplicate entry']
    for (let i = 0; i < value.length; i++) {
      const found = shape(node.items, value[i], at(path, i))
      if (found) return found
    }
  } else if (node.type === 'string') {
    if (typeof value !== 'string') return [path, 'must be a string']
    if (!value.trim()) return [path, 'must not be blank']
    if (value.length < (node.minLength ?? 0)) return [path, `must be at least ${node.minLength} characters`]
    if (value.length > (node.maxLength ?? value.length)) return [path, `must be at most ${node.maxLength} characters`]
    if (node.pattern && !new RegExp(node.pattern).test(value)) return [path, `${JSON.stringify(value)} is not in the expected form`]
  }
  return null
}

// The first dependency problem, as [code, path, detail], or null.
function graph(items) {
  const index = new Map()
  for (const [i, item] of items.entries()) {
    if (index.has(item.id)) return ['duplicate_id', `items[${i}].id`, `${item.id} is used by more than one draft`]
    index.set(item.id, i)
  }
  for (const [i, item] of items.entries()) {
    for (const [j, dep] of item.depends_on.entries()) {
      if (dep === item.id) return ['self_dep', `items[${i}].depends_on[${j}]`, `${dep} depends on itself`]
      if (LOCAL_ID.test(dep) && !index.has(dep)) {
        return ['unknown_dep', `items[${i}].depends_on[${j}]`, `${item.id} depends on ${dep}, which is not a draft in this plan`]
      }
    }
  }
  // Depth-first in draft order, each draft's dependencies in listed order —
  // the same walk as the Python binding, so both name the same cycle.
  const state = new Map()
  const visit = (node, stack) => {
    state.set(node, 'open')
    stack.push(node)
    for (const [j, dep] of items[index.get(node)].depends_on.entries()) {
      if (!LOCAL_ID.test(dep)) continue
      if (state.get(dep) === 'open') {
        const loop = [...stack.slice(stack.indexOf(dep)), dep]
        return ['cycle', `items[${index.get(node)}].depends_on[${j}]`, loop.join(' → ')]
      }
      if (!state.has(dep)) {
        const found = visit(dep, stack)
        if (found) return found
      }
    }
    stack.pop()
    state.set(node, 'done')
    return null
  }
  for (const item of items) {
    if (state.has(item.id)) continue
    const found = visit(item.id, [])
    if (found) return found
  }
  return null
}

// Every string in the draft, with its path.
function* strings(value, path) {
  if (typeof value === 'string') yield [path, value]
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, at(path, i))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* strings(v, at(path, k))
}

// Every real key the draft names, in order of first appearance, each with the
// path it first appears at. A `depends_on` entry in key form always counts; in
// free text only a key whose prefix is one of `keyPrefixes` does, so `UTF-8` or
// `SHA-256` in prose is never mistaken for an item.
function keyRefs(doc, keyPrefixes) {
  const prefixes = new Set(keyPrefixes)
  const found = new Map()
  for (const [path, text] of strings(doc, '')) {
    if (/\.depends_on\[\d+\]$/.test(path) && REAL_KEY.test(text)) {
      if (!found.has(text)) found.set(text, path)
      continue
    }
    for (const match of text.matchAll(KEY_IN_TEXT)) {
      if (prefixes.has(match[1]) && !found.has(match[0])) found.set(match[0], path)
    }
  }
  return found
}

export function realKeysIn(doc, keyPrefixes = []) {
  return [...keyRefs(doc, keyPrefixes).keys()]
}

// { ok: true } or { ok: false, errors: [{ path, code, message }] } — the first
// rule the draft breaks. With no `keyExists`, real keys go unchecked; with no
// `knownRepos`, repos do — the farm-side view the shared fixtures compare.
export function validatePlanDraft(doc, { knownRepos = null, keyExists = null, keyPrefixes = [] } = {}) {
  const found = shape(PLAN_DRAFT_SCHEMA, doc, '')
  if (found) return fail('invalid_shape', found[0] || 'plan_draft', `${found[0] || 'plan_draft'} ${found[1]}`)
  const problem = graph(doc.items)
  if (problem) return fail(...problem)
  if (knownRepos) {
    const repos = new Set(knownRepos.map((r) => r.toLowerCase()))
    const i = doc.items.findIndex((item) => !repos.has(item.repo.toLowerCase()))
    if (i >= 0) return fail('unknown_repo', `items[${i}].repo`, `${doc.items[i].repo} is not a repo this plan can file in`)
  }
  if (keyExists) {
    const unknown = [...keyRefs(doc, keyPrefixes)].filter(([key]) => !keyExists(key))
    if (unknown.length) {
      const keys = unknown.map(([key]) => key).join(', ')
      return fail('unknown_key', unknown[0][1], `${keys} ${unknown.length === 1 ? 'is not an existing item' : 'are not existing items'} — name a new item by its #n id`)
    }
  }
  return { ok: true }
}

// A table cell: one line, pipes escaped.
const cell = (text) => String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')

// The draft as markdown, appended to the Draft items artifact so the gate card
// shows the items table.
export function renderPlanDraftMd(doc) {
  const lines = ['## Draft items', '', '| ID | Repo | Title | Depends on | Must also cover |', '| --- | --- | --- | --- | --- |']
  for (const item of doc.items) {
    const deps = item.depends_on.length ? item.depends_on.join(', ') : '—'
    const cover = item.must_also_cover.length ? item.must_also_cover.map(cell).join('; ') : '—'
    lines.push(`| ${item.id} | \`${cell(item.repo)}\` | ${cell(item.title)} | ${deps} | ${cover} |`)
  }
  for (const item of doc.items) {
    lines.push('', `### ${item.id} ${cell(item.title)}`, '', `**Outcome.** ${item.outcome}`, '', '**Success metric**')
    lines.push(...item.metric.map((m, i) => `${i + 1}. ${m}`), '', '**Guardrails**', ...item.guardrails.map((g) => `- ${g}`))
  }
  if (doc.shared_guardrails.length) lines.push('', '## Shared guardrails', ...doc.shared_guardrails.map((g) => `- ${g}`))
  if (doc.open_questions.length) {
    lines.push('', '## Open questions')
    for (const q of doc.open_questions) lines.push(`- **${q.question}** Recommended: ${q.recommended_answer}`)
  }
  return lines.join('\n')
}
