// Agent definitions as git-versioned files (HZ-9): the hierarchical library
// the UI browses and edits — global (roles + personas, shared by every
// project) → project rules → repo rules. The farm's own files are read and
// written in place; there is no DB copy to drift. Every UI save becomes a git
// commit (and a push when a remote exists) so git history is the audit log.
//
// The compose logic in effectivePrompt() mirrors farm/rules.py
// effective_prompt() and farm/personas.py compose_role() — parity-tested
// byte-for-byte in test/definitions-parity.test.mjs. Change both together.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Server and farm live in one repo/checkout, so a UI edit is immediately what
// farmd stamps into the next task. Overridable for tests only.
const FARM_DIR = process.env.HORIZON_FARM_DIR || path.resolve(import.meta.dirname, '../../farm')

export const MAX_DEFINITION_BYTES = 8192

// Whitelist map — file paths derive from this table plus a validated name,
// never from user input.
const KINDS = {
  role: 'roles',
  persona: 'roles/personas',
  project: 'rules/projects',
  repo: 'rules/repos',
}

// No slashes, no leading dot: a name can only ever select a .md file inside
// its kind's directory.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

// Mirrors CREDENTIAL_PATTERNS in farm/rules.py (the read-side lint) — $ENV_VAR
// references deliberately pass; literals do not.
const CREDENTIAL_PATTERNS = [
  ['credential assignment', /\b(password|passwd|secret|token|api[_-]?key|aws_secret_access_key)\b\s*[:=]\s*(?!\$)\S+/i],
  ['credential in URL', /:\/\/[^\s/:@]+:(?!\$)[^\s@]+@/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{8,}/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/],
]

export function lintRules(text) {
  return CREDENTIAL_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label)
}

class DefinitionError extends Error {
  constructor(code, extra = {}) {
    super(code)
    this.code = code
    Object.assign(this, extra)
  }
}

function definitionPath(kind, name) {
  if (!KINDS[kind] || typeof name !== 'string' || !NAME_RE.test(name)) return null
  return path.join(FARM_DIR, KINDS[kind], `${name}.md`)
}

function listKind(kind) {
  const dir = path.join(FARM_DIR, KINDS[kind])
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // an absent layer lists as empty, same posture as the farm
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => ({
      kind,
      name: e.name.slice(0, -3),
      bytes: fs.statSync(path.join(dir, e.name)).size,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function listDefinitions() {
  return {
    global: [...listKind('role'), ...listKind('persona')],
    projects: listKind('project'),
    repos: listKind('repo'),
  }
}

export function readDefinition(kind, name) {
  const file = definitionPath(kind, name)
  if (!file || !fs.existsSync(file)) return null
  const content = fs.readFileSync(file, 'utf8')
  return {
    kind,
    name,
    content,
    path: path.join('farm', KINDS[kind], `${name}.md`),
    bytes: Buffer.byteLength(content, 'utf8'),
  }
}

function git(...args) {
  return execFileSync('git', ['-C', FARM_DIR, ...args], { encoding: 'utf8' }).trim()
}

// Branch/push policy (architecture review note 1): commit on the checkout's
// current branch and push to origin immediately — a push failure fails the
// save loudly (the local commit stays as evidence, but the caller is told the
// edit is NOT durably versioned). A checkout with no origin remote (tests,
// throwaway clones) commits locally and reports pushed:false.
//
// All steps are synchronous, so Node's event loop serializes concurrent saves
// — last write wins, git history is the audit trail.
export function writeDefinition(kind, name, content, actor = 'unknown') {
  const file = definitionPath(kind, name)
  if (!file) throw new DefinitionError('unknown_definition')
  if (typeof content !== 'string' || !content.trim()) throw new DefinitionError('empty_content')
  if (Buffer.byteLength(content, 'utf8') > MAX_DEFINITION_BYTES) {
    throw new DefinitionError('rules_too_large', { limit: MAX_DEFINITION_BYTES })
  }
  const matches = lintRules(content)
  if (matches.length > 0) throw new DefinitionError('credential_pattern', { matches })

  // Unrelated staged work would be swept into our commit — refuse instead.
  try {
    git('diff', '--cached', '--quiet')
  } catch {
    throw new DefinitionError('git_dirty')
  }

  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (existing === content) return { ok: true, commit: null, unchanged: true }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  git('add', '--', file)
  git(
    '-c', 'user.name=Horizon',
    '-c', 'user.email=horizon@local',
    'commit', '-m', `definitions: ${kind}/${name} edited via UI by ${actor}`,
  )
  const commit = git('rev-parse', '--short', 'HEAD')

  let hasOrigin = true
  try {
    git('remote', 'get-url', 'origin')
  } catch {
    hasOrigin = false
  }
  if (hasOrigin) {
    try {
      git('push', 'origin', 'HEAD')
    } catch (err) {
      throw new DefinitionError('push_failed', { commit, detail: String(err.stderr || err.message).slice(0, 300) })
    }
  }
  return { ok: true, commit, pushed: hasOrigin }
}

// ---- effective-prompt preview (mirrors the farm composition exactly) ----

function readFarmFile(relpath) {
  try {
    return fs.readFileSync(path.join(FARM_DIR, relpath), 'utf8')
  } catch {
    return null
  }
}

// Mirror of farm/config.py slugify (ASCII names — parity holds for those).
function slugify(name) {
  return [...name.toLowerCase()].map((c) => (/[a-z0-9]/.test(c) ? c : '-')).join('').replace(/^-+|-+$/g, '')
}

const PERSONA_IDS = ['fullstack', 'python_backend', 'frontend_ui']
const DEFAULT_PERSONA = 'fullstack'

// Mirror of farm/personas.py resolve + compose_role.
function composeRole(roleText, personaId) {
  const candidate = typeof personaId === 'string' ? personaId.trim().toLowerCase() : ''
  const resolved = PERSONA_IDS.includes(candidate) ? candidate : DEFAULT_PERSONA
  for (const id of [resolved, DEFAULT_PERSONA]) {
    const personaMd = readFarmFile(path.join('roles/personas', `${id}.md`))
    if (personaMd !== null) return `${roleText}\n\n## Your specialization\n${personaMd}`
  }
  return roleText
}

// Mirror of farm/rules.py resolve_rules (byte cap included).
function resolveRules(projectName, repo) {
  const parts = []
  const readCapped = (relpath) => {
    const full = path.join(FARM_DIR, relpath)
    let raw
    try {
      raw = fs.readFileSync(full)
    } catch {
      return ''
    }
    if (raw.length > MAX_DEFINITION_BYTES) return ''
    return raw.toString('utf8').trim()
  }
  if (typeof projectName === 'string' && projectName.trim()) {
    parts.push(readCapped(path.join('rules/projects', `${slugify(projectName)}.md`)))
  }
  if (typeof repo === 'string' && repo.trim()) {
    parts.push(readCapped(path.join('rules/repos', `${repo.trim().replaceAll('/', '__')}.md`)))
  }
  return parts.filter(Boolean).join('\n\n')
}

// Mirror of farm/rules.py render_rules_section.
const MAX_PROMPT_RULES_CHARS = 24000

function renderRulesSection(rulesText) {
  const text = typeof rulesText === 'string' ? rulesText.trim() : ''
  if (!text) return ''
  return `## Project rules\n${text.slice(0, MAX_PROMPT_RULES_CHARS)}`
}

// Mirror of farm/rules.py effective_prompt — the exact string an agent for
// this project/repo/persona receives (role defaults to the implement step).
export function effectivePrompt({ role = 'eng_implement', persona, project, repo } = {}) {
  const roleFile = definitionPath('role', role)
  const roleText = roleFile && fs.existsSync(roleFile) ? fs.readFileSync(roleFile, 'utf8') : ''
  const composed = composeRole(roleText, persona)
  const section = renderRulesSection(resolveRules(project, repo))
  return section ? `${composed}\n\n${section}` : composed
}
