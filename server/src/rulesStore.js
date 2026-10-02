// Project and repo rules saved in Admin (HZ-246): versioned rows in the
// rule_version table, layered over the farm/rules/*.md files, which stay the
// defaults. Append-only — there is no update or delete here, and restore is a
// new save of the old text.
//
// Agents run as the same OS user as this DB, so a direct SQLite write must not
// change what they read: every PIN-approved save is signed with
// RULES_HMAC_SECRET, and serving re-checks the signature. A row that fails is
// skipped (the newest row that still verifies is served, else the file) and
// logged once as a tamper event. Accepted risk (operator ruling, 2026-10-02):
// an agent that reads the server's environment can still forge a signature;
// this catches naive or accidental edits, not a determined forger.

import crypto from 'node:crypto'
import { db } from './db.js'
import { RULES_HMAC_SECRET } from './config.js'
import { MAX_DEFINITION_BYTES, lintRules, rulesKey } from './definitions.js'

export const RULE_SCOPES = ['project', 'repo']

// The rules file stem: a project slug (definitions.js slugify) or owner__repo.
const KEY_RE = {
  project: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
  repo: /^[A-Za-z0-9][A-Za-z0-9_.-]*__[A-Za-z0-9_.-]+$/,
}

export function isRuleScope(scope) {
  return RULE_SCOPES.includes(scope)
}

export function isRuleKey(scope, key) {
  return isRuleScope(scope) && typeof key === 'string' && key.length <= 300 && KEY_RE[scope].test(key)
}

export class RulesError extends Error {
  constructor(code, extra = {}) {
    super(code)
    this.code = code
    Object.assign(this, extra)
  }
}

function sign(row) {
  const payload = JSON.stringify([row.scope, row.key, row.version, row.content, row.actor, row.created_at, row.restored_from])
  return crypto.createHmac('sha256', RULES_HMAC_SECRET).update(payload).digest('hex')
}

function verified(row) {
  if (!RULES_HMAC_SECRET || typeof row.hmac !== 'string') return false
  const expected = Buffer.from(sign(row), 'hex')
  const actual = Buffer.from(row.hmac, 'hex')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

// Once per row per process, bounded: a restart logs it again, which is fine.
const tamperLogged = new Set()
const MAX_TAMPER_LOGGED = 1000

function logTamper(row) {
  if (tamperLogged.has(row.id)) return
  if (tamperLogged.size >= MAX_TAMPER_LOGGED) tamperLogged.clear()
  tamperLogged.add(row.id)
  // Never the content: the row is untrusted, and rules are not log material.
  console.warn(`rules: TAMPER scope=${row.scope} key=${JSON.stringify(row.key)} version=${row.version} — not served`)
}

const selectVersions = db.prepare('SELECT * FROM rule_version WHERE scope = ? AND key = ? ORDER BY version DESC')
const selectVersion = db.prepare('SELECT * FROM rule_version WHERE scope = ? AND key = ? AND version = ?')
const selectMaxVersion = db.prepare('SELECT MAX(version) AS v FROM rule_version WHERE scope = ? AND key = ?')
const insertVersion = db.prepare(`
  INSERT INTO rule_version (scope, key, version, content, actor, restored_from, created_at, hmac)
  VALUES (@scope, @key, @version, @content, @actor, @restored_from, @created_at, @hmac)
`)

// The newest row whose signature verifies, or null. Rows newer than it that
// fail are logged as tampered and skipped.
function newestVerified(scope, key) {
  if (!RULES_HMAC_SECRET || !isRuleKey(scope, key)) return null
  for (const row of selectVersions.all(scope, key)) {
    if (verified(row)) return row
    logTamper(row)
  }
  return null
}

// What agents get for this scope/key: the newest verified version's text,
// byte-for-byte. null means "serve the file default" — no usable version, or
// the newest one is empty/whitespace-only (operator ruling: blank = no DB rules).
export function getServedRule(scope, key) {
  const row = newestVerified(scope, key)
  return row && row.content.trim() ? row.content : null
}

// The served rules for a project name and an owner/repo, in the shape
// definitions.resolveRules and farm/rules.py resolve_rules take as overrides:
// a key only for a scope that has DB rules. Read fresh on every call — never
// cached, so a save reaches the next step.
export function servedRulesFor(projectName, repo) {
  const overrides = {}
  const project = getServedRule('project', rulesKey('project', projectName))
  if (project !== null) overrides.project = project
  const repoRules = getServedRule('repo', rulesKey('repo', repo))
  if (repoRules !== null) overrides.repo = repoRules
  return overrides
}

export function servedVersion(scope, key) {
  const row = newestVerified(scope, key)
  return row && row.content.trim() ? row.version : null
}

export function listRuleVersions(scope, key) {
  if (!isRuleKey(scope, key)) return []
  return selectVersions.all(scope, key).map((row) => ({
    id: row.id,
    version: row.version,
    content: row.content,
    actor: row.actor,
    restored_from: row.restored_from,
    created_at: row.created_at,
    verified: verified(row),
  }))
}

// The only writer. Its callers are the PIN-gated save and restore routes.
export function saveRule(scope, key, content, actor, restoredFrom = null) {
  if (!isRuleKey(scope, key)) throw new RulesError('bad_key')
  if (!RULES_HMAC_SECRET) throw new RulesError('rules_secret_not_configured')
  if (typeof content !== 'string') throw new RulesError('bad_content')
  if (Buffer.byteLength(content, 'utf8') > MAX_DEFINITION_BYTES) {
    throw new RulesError('rules_too_large', { limit: MAX_DEFINITION_BYTES })
  }
  const matches = lintRules(content)
  if (matches.length > 0) throw new RulesError('credential_pattern', { matches })
  return db.transaction(() => {
    const row = {
      scope,
      key,
      version: (selectMaxVersion.get(scope, key).v ?? 0) + 1,
      content,
      actor: String(actor),
      restored_from: restoredFrom,
      created_at: new Date().toISOString(),
    }
    const id = insertVersion.run({ ...row, hmac: sign(row) }).lastInsertRowid
    return { id: Number(id), version: row.version, restored_from: row.restored_from, created_at: row.created_at }
  })()
}

// Restore is a new version carrying version N's text. A row that fails its
// signature is never re-signed into a fresh, trusted one.
export function restoreRule(scope, key, version, actor) {
  if (!isRuleKey(scope, key)) throw new RulesError('bad_key')
  if (!RULES_HMAC_SECRET) throw new RulesError('rules_secret_not_configured')
  const row = selectVersion.get(scope, key, version)
  if (!row) throw new RulesError('unknown_version')
  if (!verified(row)) {
    logTamper(row)
    throw new RulesError('unverified_version')
  }
  return saveRule(scope, key, row.content, actor, row.version)
}
