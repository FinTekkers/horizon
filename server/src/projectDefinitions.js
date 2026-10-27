// HZ-542: Admin's "Project definitions" — read, edit and git history for a
// project's own definitions files, farm/projects/<slug>/personas.json
// (HZ-535, tools from HZ-536, knowledge from HZ-537) and steps.json (HZ-538).
//
// Reads never write: a GET is fs reads, DB SELECTs and `git log` only. Saves go
// through definitions.js commitFarmFile, the HZ-9 commit path, so each save is
// one commit touching only farm/projects/<slug>/<file>. Every check below runs
// before that call, and commitFarmFile lints before it writes, so a refused
// save never reaches disk, git or a log line.
//
// The slug is the project name through definitions.js slugify, which mirrors
// farm/config.py slugify for ASCII names only. A non-ASCII project name can
// slug differently on the two sides; such a project is not supported here.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { assertProjectPersonasShape } from '../../domain/js/personas.js'
import { DefinitionError, FARM_DIR, commitFarmFile, lintRules, rulesKey } from './definitions.js'
import { docsForProject } from './knowledgeDocs.js'
import * as store from './store.js'
import { AUDIT_ANCHORS, OPENING_ANCHORS, validateSubsteps } from './substeps.js'

// Whitelist map — the only two files a save can write. Paths derive from this
// table plus a resolved project slug, never from user input.
export const PROJECT_DEFINITION_FILES = Object.freeze(['personas.json', 'steps.json'])

// Larger than MAX_DEFINITION_BYTES (8192, one rules .md): a personas.json
// carries a badge, model, tools and knowledge per persona, and steps.json a
// list of sub-steps with their globs, so pretty-printed JSON for a real
// project outgrows 8 KiB well before it is unreasonable.
export const MAX_PROJECT_DEFINITION_BYTES = 32768

const HISTORY_LIMIT = 50

const isFile = (file) => PROJECT_DEFINITION_FILES.includes(file)
const relpathOf = (slug, file) => path.join('projects', slug, file)

// { id, name, slug, definitionsEnabled } for the project whose slug this is,
// or null. Only known projects resolve.
export function resolveProjectSlug(slug) {
  if (typeof slug !== 'string' || !slug) return null
  const project = store.listProjects({ checks: false }).find((p) => rulesKey('project', p.name) === slug)
  return project ? { id: project.id, name: project.name, slug, definitionsEnabled: !!project.definitionsEnabled } : null
}

// The tool ids farm/tools/allowlist.json declares. Read only — nothing here
// writes the allow-list (docs/tool-allowlist.md). An unreadable file allows
// no tools.
function toolAllowlist() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(FARM_DIR, 'tools', 'allowlist.json'), 'utf8'))
    return Array.isArray(data?.tools) ? data.tools.map((t) => t?.id).filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

// One definitions file as the view shows it. A missing file is exists:false
// and is never created; a file the credential lint refuses is never shown.
function readFile(slug, file) {
  let text
  try {
    text = fs.readFileSync(path.join(FARM_DIR, relpathOf(slug, file)), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { exists: false, content: null }
    throw err
  }
  const matches = lintRules(text)
  if (matches.length > 0) return { exists: true, content: null, error: 'credential_pattern', matches }
  try {
    return { exists: true, content: JSON.parse(text) }
  } catch {
    return { exists: true, content: null, error: 'invalid_json' }
  }
}

// Everything the view shows for one project, or null for an unknown slug.
export function readProjectDefinitions(slug) {
  const project = resolveProjectSlug(slug)
  if (!project) return null
  return {
    slug,
    project: { id: project.id, name: project.name },
    switch: project.definitionsEnabled ? 'on' : 'off',
    allowedOpeningSteps: [...OPENING_ANCHORS],
    allowedAuditSteps: [...AUDIT_ANCHORS],
    toolAllowlist: toolAllowlist(),
    files: Object.fromEntries(PROJECT_DEFINITION_FILES.map((file) => [file, readFile(slug, file)])),
    knowledge: docsForProject(project.id).map((doc) => ({
      slug: doc.slug,
      status: doc.status,
      pageCount: doc.pageCount,
      sectionCount: doc.sectionCount,
    })),
  }
}

// The file's commits, newest first: [{ commit, author, date, subject }].
// `git log --follow` takes exactly one path, and this always passes one.
export function projectDefinitionHistory(slug, file, limit = HISTORY_LIMIT) {
  if (!resolveProjectSlug(slug)) throw new DefinitionError('unknown_project')
  if (!isFile(file)) throw new DefinitionError('unknown_file')
  const out = execFileSync(
    'git',
    ['-C', FARM_DIR, 'log', '--follow', '-n', String(limit), '--format=%h%x09%an%x09%aI%x09%s', '--', relpathOf(slug, file)],
    { encoding: 'utf8' },
  )
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [commit, author, date, ...subject] = line.split('\t')
      return { commit, author, date, subject: subject.join('\t') }
    })
}

function checkPersonas(slug, value) {
  try {
    assertProjectPersonasShape(value, slug)
  } catch (err) {
    throw new DefinitionError('invalid_definitions', { detail: err.message })
  }
  const allowed = new Set(toolAllowlist())
  for (const persona of value.personas) {
    for (const tool of persona.tools ?? []) {
      if (!allowed.has(tool)) {
        throw new DefinitionError('tool_not_allowed', {
          tool,
          message: `Tool "${tool}" (persona ${persona.id}) is not in farm/tools/allowlist.json`,
        })
      }
    }
    // A save writes personas.json only; the role markdown it names must be
    // in the repo already, or the farm would refuse the whole overlay.
    if (!fs.existsSync(path.join(FARM_DIR, 'projects', slug, 'personas', persona.file))) {
      throw new DefinitionError('invalid_definitions', {
        detail: `farm/projects/${slug}/personas/${persona.file} does not exist (persona ${persona.id})`,
      })
    }
  }
}

function checkSteps(value) {
  // The anchor first, so a wrong one is named on its own rather than as one
  // line of the full validation below.
  for (const entry of Array.isArray(value?.substeps) ? value.substeps : []) {
    if (entry === null || typeof entry !== 'object') continue
    const anchor = entry.anchor
    if (entry.kind === 'opening' && !OPENING_ANCHORS.includes(anchor)) {
      throw new DefinitionError('anchor_not_allowed', {
        anchor,
        message: `Anchor ${JSON.stringify(anchor)} is not an allowed opening step (allowed: ${OPENING_ANCHORS.join(', ')})`,
      })
    }
    if (entry.kind === 'audit' && !AUDIT_ANCHORS.includes(anchor)) {
      throw new DefinitionError('anchor_not_allowed', {
        anchor,
        message: `Anchor ${JSON.stringify(anchor)} is not an allowed audit step (allowed: ${AUDIT_ANCHORS.join(', ')})`,
      })
    }
  }
  const { errors } = validateSubsteps(value)
  if (errors.length) throw new DefinitionError('invalid_definitions', { detail: errors.join('; ') })
}

// Saves one definitions file as one commit. Throws DefinitionError with code
// unknown_project, unknown_file, definitions_too_large, credential_pattern,
// invalid_definitions, tool_not_allowed, anchor_not_allowed, git_dirty or
// push_failed — every one but the last before anything is written.
export function writeProjectDefinition(slug, file, value, actor = 'unknown') {
  if (!resolveProjectSlug(slug)) throw new DefinitionError('unknown_project')
  if (!isFile(file)) throw new DefinitionError('unknown_file')
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_PROJECT_DEFINITION_BYTES) {
    throw new DefinitionError('definitions_too_large', { limit: MAX_PROJECT_DEFINITION_BYTES })
  }
  const matches = lintRules(text)
  if (matches.length > 0) throw new DefinitionError('credential_pattern', { matches })
  if (file === 'personas.json') checkPersonas(slug, value)
  else checkSteps(value)
  return commitFarmFile(relpathOf(slug, file), text, `definitions: projects/${slug}/${file} edited via UI by ${actor}`)
}
