// HZ-538: a project's sub-step definitions (farm/projects/<slug>/steps.json)
// and the snapshot of the ones that apply to an item, taken once, at intake.
//
// Snapshot data only. Nothing here — or anywhere yet — dispatches, runs or
// prompts a sub-step; dispatch is HZ-539, and it reads work_item.substeps_json,
// never the files, so there is no second matcher to drift from this one.
//
// File shape:
//   { "substeps": [ { id, label, kind, anchor, persona?, output, applies } ] }
//
// - kind 'opening' follows a definition step: Change 1 or Task 17. It outputs
//   'artifact' or 'golden_cases'.
// - kind 'audit' follows Implement (11) or Execute (24). It outputs 'findings'.
// - anchor is the global step index the sub-step follows — an index, not a
//   label, so a label rename cannot silently move a sub-step.
// - A sub-step never gates: a `gate` key is refused whatever its value, as is
//   any key not listed above.
// - applies: { labels?, repos?, paths? }, at least one non-empty. Any list
//   matching is a match. `paths` globs (`*`, `?`, `**`) are tested against the
//   backtick spans in the item's description that look like paths — an item
//   has no changed files at intake.
//
// One bad entry rejects the whole file (fail closed, never a partial
// snapshot), and every error names the sub-step id.
//
// The per-project switch is HZ-535's project.definitions_enabled: off, the
// file is never read and no snapshot is taken.

import fs from 'node:fs'
import path from 'node:path'

import { STEPS } from '../../domain/js/lifecycle.js'
import { PROJECTS_DIR, slugify } from './definitions.js'
import { PERSONAS, isPersona } from './personas.js'

export const SUBSTEP_OUTPUTS = Object.freeze(['artifact', 'golden_cases', 'findings'])
// Change "Define how we measure success" and Task "How we'll verify".
export const OPENING_ANCHORS = Object.freeze([1, 17])
// "Specialist agent implements" and "Execute".
export const AUDIT_ANCHORS = Object.freeze([11, 24])

const KIND_RULES = {
  opening: { anchors: OPENING_ANCHORS, outputs: ['artifact', 'golden_cases'] },
  audit: { anchors: AUDIT_ANCHORS, outputs: ['findings'] },
}
const KEYS = new Set(['id', 'label', 'kind', 'anchor', 'persona', 'output', 'applies'])
const APPLIES_KEYS = ['labels', 'repos', 'paths']
const ID_RE = /^[a-z0-9][a-z0-9-]*$/

// The test seam: the one file read, replaceable.
export const deps = {
  readFile: (file) => fs.readFileSync(file, 'utf8'),
}

const isEntry = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isStringList = (value) => Array.isArray(value) && value.every((s) => typeof s === 'string' && s.trim())

function validateEntry(entry, problems) {
  const { kind, anchor, output, persona, applies } = entry
  for (const key of Object.keys(entry)) {
    if (key === 'gate') problems.push('a sub-step has no gate of its own; remove "gate"')
    else if (!KEYS.has(key)) problems.push(`unknown key "${key}"`)
  }
  if (typeof entry.label !== 'string' || !entry.label.trim()) problems.push('label must be a non-empty string')
  if (!Object.hasOwn(KIND_RULES, kind ?? '')) {
    problems.push(`kind must be opening or audit, got ${JSON.stringify(kind)}`)
  } else {
    const rules = KIND_RULES[kind]
    if (!rules.anchors.includes(anchor)) {
      problems.push(`${kind} anchor must be one of ${rules.anchors.join(', ')}, got ${JSON.stringify(anchor)}`)
    }
    if (SUBSTEP_OUTPUTS.includes(output) && !rules.outputs.includes(output)) {
      problems.push(`${kind} output must be ${rules.outputs.join(' or ')}, got ${output}`)
    }
  }
  if (!SUBSTEP_OUTPUTS.includes(output)) problems.push(`output must be one of ${SUBSTEP_OUTPUTS.join(', ')}, got ${JSON.stringify(output)}`)
  if (persona !== undefined && !Object.keys(PERSONAS).some((agent) => isPersona(agent, persona))) {
    problems.push(`unknown persona ${JSON.stringify(persona)}`)
  }
  if (!isEntry(applies)) {
    problems.push('applies must be an object')
  } else {
    for (const key of Object.keys(applies)) {
      if (!APPLIES_KEYS.includes(key)) problems.push(`unknown applies key "${key}"`)
      else if (!isStringList(applies[key])) problems.push(`applies.${key} must be a list of non-empty strings`)
    }
    if (!APPLIES_KEYS.some((key) => Object.hasOwn(applies, key) && Array.isArray(applies[key]) && applies[key].length > 0)) {
      problems.push('applies needs at least one non-empty list of labels, repos or paths')
    }
  }
}

// Pure. { substeps, errors }: substeps is [] whenever errors is not.
export function validateSubsteps(raw) {
  if (!isEntry(raw) || !Array.isArray(raw.substeps)) return { substeps: [], errors: ['expected {"substeps": [...]}'] }
  const errors = []
  const seen = new Set()
  raw.substeps.forEach((entry, i) => {
    const id = isEntry(entry) ? entry.id : undefined
    const name = typeof id === 'string' && id ? `substep ${JSON.stringify(id)}` : `substep #${i + 1}`
    const problems = []
    if (!isEntry(entry)) {
      problems.push('must be an object')
    } else {
      if (typeof id !== 'string' || !ID_RE.test(id)) problems.push('id must match ^[a-z0-9][a-z0-9-]*$')
      else if (seen.has(id)) problems.push('duplicate id')
      else seen.add(id)
      validateEntry(entry, problems)
    }
    for (const problem of problems) errors.push(`${name}: ${problem}`)
  })
  if (errors.length) return { substeps: [], errors }
  const substeps = raw.substeps.map((entry) => ({
    id: entry.id,
    label: entry.label,
    kind: entry.kind,
    anchor: entry.anchor,
    persona: entry.persona ?? null,
    output: entry.output,
    applies: Object.fromEntries(APPLIES_KEYS.map((key) => [key, Object.hasOwn(entry.applies, key) ? [...entry.applies[key]] : []])),
  }))
  return { substeps, errors: [] }
}

// The project's definitions. No file: none and no errors.
export function loadSubsteps(projectName) {
  const slug = typeof projectName === 'string' ? slugify(projectName) : ''
  if (!slug) return { substeps: [], errors: [] }
  const source = `farm/projects/${slug}/steps.json`
  let text
  try {
    text = deps.readFile(path.join(PROJECTS_DIR, slug, 'steps.json'))
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { substeps: [], errors: [] }
    return { substeps: [], errors: [`${source} could not be read (${err.code ?? err.message})`] }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { substeps: [], errors: [`${source} is not valid JSON (${err.message})`] }
  }
  return validateSubsteps(raw)
}

// `*` and `?` never cross `/`; `**/` is any number of directories, none
// included; a bare `**` is anything. Anchored at both ends.
function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

export function matchesGlob(glob, file) {
  return globToRegExp(glob).test(file)
}

// Backtick spans in a description that look like a path.
function descPaths(desc) {
  if (typeof desc !== 'string') return []
  return [...desc.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter((s) => s && /[/.]/.test(s))
}

const lower = (list) => list.map((s) => s.toLowerCase())

// Pure. The definitions that apply to an item, in file order: the anchor's
// step belongs to the item's kind, and any `applies` list matches. `labels`
// are GitHub label objects or names, matched case-insensitively, as are repos.
export function matchSubsteps(substeps, { kind, labels, repo, desc }) {
  const labelNames = new Set(lower((labels || []).map((label) => String(typeof label === 'string' ? label : label?.name || ''))))
  const repoName = typeof repo === 'string' ? repo.toLowerCase() : ''
  const paths = descPaths(desc)
  return substeps.filter((s) => {
    if ((STEPS[s.anchor]?.itemKind ?? 'change') !== kind) return false
    return (
      lower(s.applies.labels).some((label) => labelNames.has(label)) ||
      lower(s.applies.repos).includes(repoName) ||
      s.applies.paths.some((glob) => paths.some((file) => matchesGlob(glob, file)))
    )
  })
}

// The substeps_json value for a new item in `project` ({ id, name,
// definitions_enabled }), or null: no project, the switch off (the file is
// never read), a file that fails to load (logged, naming the ids), or nothing
// matching. Never throws — a bad file must not break the GitHub sync.
export function snapshotSubsteps({ project, kind, labels, repo, desc }) {
  try {
    if (!project || !project.definitions_enabled) return null
    const { substeps, errors } = loadSubsteps(project.name)
    if (errors.length) {
      console.error(`sub-steps for ${project.name} not snapshotted: ${errors.join('; ')}`)
      return null
    }
    const matched = matchSubsteps(substeps, { kind, labels, repo, desc })
    return matched.length ? JSON.stringify(matched) : null
  } catch (err) {
    console.error(`sub-steps for ${project?.name} not snapshotted: ${err.message}`)
    return null
  }
}
