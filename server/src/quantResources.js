// HZ-972: a project's quant resource registry,
// farm/projects/<slug>/quant_resources.json (domain/quantResources.schema.json)
// — the only list of sources a quant persona may cite. Metadata only: the code
// and papers it names live in the private store repo, never in Horizon.
//
// A golden case cites an entry through its knowledge-library slug,
// knowledgeSlug(library.repo, library.path), derived here and never stored, so
// it cannot drift from knowledgeDocs.js. A project with no registry has no
// such rule: registryDocSlugs() returns null and nothing is refused.

import fs from 'node:fs'
import path from 'node:path'

import { validate } from '../../domain/validate.mjs'
// Pure modules only: goldenCases.js imports this, and the WhatsApp vote path
// reaches goldenCases.js, so definitions.js must stay off this graph
// (wa-poll-no-model.test.mjs).
import { PROJECTS_DIR, slugify } from './farmPaths.js'
import { knowledgeSlug } from './knowledgeSlug.js'

export const REGISTRY_FILE = 'quant_resources.json'

const SCHEMA = JSON.parse(fs.readFileSync(new URL('../../domain/quantResources.schema.json', import.meta.url), 'utf8'))
const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/
const ID_RE = /^[a-z0-9][a-z0-9-]*$/
// The knowledge-source shape of domain/projectPersonas.schema.json.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const PATH_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\.pdf$/

// The test seam: the one file read, replaceable.
export const deps = {
  readFile: (file) => fs.readFileSync(file, 'utf8'),
}

// Every problem with a parsed registry: the schema's, then the rules the
// schema subset cannot express. Empty === valid.
export function validateQuantResources(raw) {
  const errors = validate(SCHEMA, raw)
  if (errors.length) return errors
  if (!HEX40.test(raw.store.sha)) errors.push('store.sha must be 40 lowercase hex')
  const seen = new Set()
  for (const entry of raw.resources) {
    const at = `resource ${JSON.stringify(entry.id)}`
    if (!ID_RE.test(entry.id)) errors.push(`${at}: id must match ${ID_RE.source}`)
    if (seen.has(entry.id)) errors.push(`${at}: duplicate id`)
    seen.add(entry.id)
    if (entry.pinned?.sha !== undefined && !HEX40.test(entry.pinned.sha)) errors.push(`${at}: pinned.sha must be 40 lowercase hex`)
    if (entry.sha256 !== undefined && !HEX64.test(entry.sha256)) errors.push(`${at}: sha256 must be 64 lowercase hex`)
    if (entry.library && (!REPO_RE.test(entry.library.repo) || !PATH_RE.test(entry.library.path))) {
      errors.push(`${at}: library must be a {repo, path} PDF knowledge source`)
    }
  }
  return errors
}

// { resources, readers, errors } for a project name. No file: resources null,
// errors []. A file that fails to parse or validate: resources null, errors
// naming why — and registryDocSlugs() then refuses every citation, failing
// closed.
export function loadQuantResources(projectName) {
  const slug = typeof projectName === 'string' ? slugify(projectName) : ''
  if (!slug) return { resources: null, readers: [], errors: [] }
  const file = path.join(PROJECTS_DIR, slug, REGISTRY_FILE)
  let text
  try {
    text = deps.readFile(file)
  } catch (err) {
    if (err?.code === 'ENOENT') return { resources: null, readers: [], errors: [] }
    return { resources: null, readers: [], errors: [`${REGISTRY_FILE}: ${err.message}`] }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { resources: null, readers: [], errors: [`${REGISTRY_FILE}: ${err.message}`] }
  }
  const errors = validateQuantResources(raw)
  if (errors.length) return { resources: null, readers: [], errors: errors.map((e) => `${REGISTRY_FILE}: ${e}`) }
  return { resources: raw.resources, readers: raw.readers, store: raw.store, errors: [] }
}

// The doc slugs a golden case may cite in this project, or null when the
// project has no registry. A registry that does not load gives an empty set.
export function registryDocSlugs(projectName) {
  const { resources, errors } = loadQuantResources(projectName)
  if (!resources) return errors.length ? new Set() : null
  return new Set(resources.filter((r) => r.library).map((r) => knowledgeSlug(r.library.repo, r.library.path)))
}
