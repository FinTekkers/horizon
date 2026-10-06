// HZ-263: deploy targets live in the deploy_target table (server/src/db.js).
// This module owns that table: the one-time seed, the row <-> target mapping,
// and the validation every target passes on each read before it may deploy.
//
// The seed copies a snapshot embedded below — it never reads a registry file.
// It runs once per database (the setting.deploy_target_seed marker), in one
// transaction, and only ever inserts with ON CONFLICT DO NOTHING: an existing
// row (same key or repo), edited or not, is never overwritten and nothing is
// deleted. Not INSERT OR IGNORE, which would also skip a NOT NULL violation
// instead of rolling the whole seed back.
//
// The DB is agent-writable (agents run as the unix user that owns
// horizon.db), so a row is never trusted as stored. checkRunnable() confines
// the script to the scripts dir after following symlinks, and requires the
// service and every extra service to be one the git-reviewed
// infra/host/horizon-deploy.sudoers permits restarting. That allow-list is
// read from the sudoers file on every call and never stored in the DB.
// repoDir and healthUrl are checked by format only: a well-formed path or URL
// elsewhere passes, which is part of the risk accepted at gate 5.

import { realpathSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, sep } from 'node:path'
import { db } from './db.js'

export const SEED_DEPLOY_TARGETS = Object.freeze([
  Object.freeze({
    key: 'horizon',
    repo: 'FinTekkers/horizon',
    script: 'deploy-horizon.sh',
    service: 'horizon-server',
    repoDir: '/opt/horizon',
    stateKey: 'horizon',
    healthUrl: 'http://127.0.0.1:3001/api/health',
    healthCheckType: 'json-health',
    extraServices: Object.freeze(['horizon-farm']),
  }),
  Object.freeze({
    key: 'ui-service',
    repo: 'FinTekkers/ui-service',
    script: 'deploy-ui-service.sh',
    service: 'fintekkers-ui',
    repoDir: '/opt/fintekkers/ui-service',
    stateKey: 'ui-service',
    healthUrl: 'https://www.fintekkers.org/',
    healthCheckType: 'ssr-asset-check',
  }),
])

const SEED_MARKER = 'deploy_target_seed'

// Read on every call, not at import, so a test can point it at a stub dir
// whenever it likes. In production nothing sets it: infra/host/.
export function scriptsDir() {
  return process.env.HORIZON_DEPLOY_SCRIPTS_DIR
    ?? fileURLToPath(new URL('../../infra/host/', import.meta.url))
}

export function scriptPath(target) {
  return join(scriptsDir(), target.script)
}

function toTarget(row) {
  const target = {
    key: row.key,
    repo: row.repo,
    script: row.script,
    service: row.service,
    repoDir: row.repo_dir,
    stateKey: row.state_key,
    healthUrl: row.health_url,
    healthCheckType: row.health_check_type,
  }
  if (row.extra_services !== null) {
    let extras
    try {
      extras = JSON.parse(row.extra_services)
    } catch {
      extras = row.extra_services // kept as-is so checkRunnable rejects it
    }
    target.extraServices = extras
  }
  return target
}

export function seedDeployTargets(database = db, targets = SEED_DEPLOY_TARGETS) {
  if (database.prepare('SELECT 1 FROM setting WHERE key = ?').get(SEED_MARKER)) {
    return { seeded: 0, skipped: 'already_seeded' }
  }
  const insert = database.prepare(`
    INSERT INTO deploy_target
      (key, repo, script, service, repo_dir, state_key, health_url, health_check_type, extra_services)
    VALUES (@key, @repo, @script, @service, @repoDir, @stateKey, @healthUrl, @healthCheckType, @extraServices)
    ON CONFLICT DO NOTHING
  `)
  try {
    let seeded = 0
    database.transaction(() => {
      for (const target of targets) {
        seeded += insert.run({
          ...target,
          extraServices: target.extraServices ? JSON.stringify(target.extraServices) : null,
        }).changes
      }
      // Last statement, plain INSERT: a racing second boot rolls back on the
      // primary-key collision (same guard as gate_notice_baseline in db.js).
      database.prepare("INSERT INTO setting (key, value) VALUES (?, 'done')").run(SEED_MARKER)
    })()
    return { seeded }
  } catch (error) {
    console.error(`deploy_target seed failed, rolled back: ${error.message}`)
    return { seeded: 0, error }
  }
}

export function listTargets(database = db) {
  return database.prepare('SELECT * FROM deploy_target ORDER BY rowid').all().map(toTarget)
}

export function findTargetByRepo(repo, database = db) {
  const row = database.prepare('SELECT * FROM deploy_target WHERE repo = ?').get(repo)
  return row ? toTarget(row) : null
}

export function findTargetByKey(key, database = db) {
  const row = database.prepare('SELECT * FROM deploy_target WHERE key = ?').get(key)
  return row ? toTarget(row) : null
}

// The services a sudoers text lets the deploy user restart, one per
// `systemctl restart <service>` on a non-comment line. Also parses
// `sudo -n -l` output, which lists the same commands (HZ-258 Dry run).
export function servicesInSudoersText(text) {
  const services = new Set()
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('#')) continue
    for (const match of line.matchAll(/\/systemctl restart ([A-Za-z0-9@_.-]+)/g)) services.add(match[1])
  }
  return services
}

// The services horizon-deploy.sudoers permits restarting. Unreadable file: none.
export function allowedServices() {
  let text
  try {
    text = readFileSync(join(scriptsDir(), 'horizon-deploy.sudoers'), 'utf8')
  } catch {
    return new Set()
  }
  return servicesInSudoersText(text)
}

const REQUIRED_FIELDS = ['key', 'repo', 'script', 'service', 'repoDir', 'stateKey', 'healthUrl', 'healthCheckType']
// A library's deploy publishes to package registries (deploy-publish-release.sh)
// and restarts nothing, so its row has no service: service is '' and sudo is
// never involved. Its script's registry check is its health check.
export const NO_SERVICE_HEALTH_CHECK_TYPES = new Set(['registry-publish'])
export function restartsNothing(target) {
  return NO_SERVICE_HEALTH_CHECK_TYPES.has(target?.healthCheckType) && target?.service === ''
}
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const SERVICE = /^[A-Za-z0-9@_.-]+$/
const SCRIPT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/
const REPO_DIR = /^\/[A-Za-z0-9_./-]*$/

export function scriptInsideScriptsDir(script) {
  if (typeof script !== 'string' || !SCRIPT.test(script)) return false
  try {
    const root = realpathSync(scriptsDir())
    return realpathSync(join(root, script)).startsWith(root + sep)
  } catch {
    return false // missing file, broken symlink, missing dir
  }
}

export function serviceAllowed(service, allowed = allowedServices()) {
  return typeof service === 'string' && SERVICE.test(service) && allowed.has(service)
}

export function serviceNotAllowedReason(service) {
  return `service ${service} not in horizon-deploy.sudoers`
}

// { ok: true } or { ok: false, reason }. Never throws.
export function checkRunnable(target) {
  for (const field of REQUIRED_FIELDS) {
    if (field === 'service' && restartsNothing(target)) continue
    if (typeof target?.[field] !== 'string' || target[field] === '') return { ok: false, reason: `missing ${field}` }
  }
  if (!SLUG.test(target.key)) return { ok: false, reason: 'bad key' }
  if (!SLUG.test(target.stateKey)) return { ok: false, reason: 'bad stateKey' }
  if (!scriptInsideScriptsDir(target.script)) return { ok: false, reason: 'script outside infra/host' }
  if (!isAbsolute(target.repoDir) || !REPO_DIR.test(target.repoDir) || target.repoDir.split('/').includes('..')) {
    return { ok: false, reason: 'bad repoDir' }
  }
  let url
  try {
    url = new URL(target.healthUrl)
  } catch {
    return { ok: false, reason: 'bad healthUrl' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'bad healthUrl' }
  if (!SLUG.test(target.healthCheckType)) return { ok: false, reason: 'bad healthCheckType' }
  const extras = target.extraServices ?? []
  if (!Array.isArray(extras) || !extras.every((s) => typeof s === 'string')) {
    return { ok: false, reason: 'bad extraServices' }
  }
  const allowed = allowedServices()
  for (const service of restartsNothing(target) ? extras : [target.service, ...extras]) {
    if (!serviceAllowed(service, allowed)) return { ok: false, reason: serviceNotAllowedReason(service) }
  }
  return { ok: true }
}

// ---- Admin create / edit / delete (HZ-259) ----
// Each write runs checkRunnable() first — the only rule validator — so Admin
// can never store a row a release would refuse. The sudoers file stays the
// boundary: a service it does not permit is refused here and on every read.
// Results are { ok: true, target } or { ok: false, code, reason? } with code
// 'invalid' | 'conflict' | 'not_found'.

const TARGET_BODY_FIELDS = ['repo', 'script', 'service', 'repoDir', 'stateKey', 'healthUrl', 'healthCheckType']

// The target shape from a request body: only the known fields, key from the path.
export function targetFromBody(key, body) {
  const target = { key }
  for (const field of TARGET_BODY_FIELDS) target[field] = body?.[field]
  if (body?.extraServices !== undefined) target.extraServices = body.extraServices
  return target
}

function rowParams(target) {
  return {
    ...target,
    extraServices: target.extraServices?.length ? JSON.stringify(target.extraServices) : null,
  }
}

function writeTarget(target, statement) {
  const check = checkRunnable(target)
  if (!check.ok) return { ok: false, code: 'invalid', reason: check.reason }
  let changes
  try {
    changes = statement.run(rowParams(target)).changes
  } catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT')) return { ok: false, code: 'conflict' }
    throw error
  }
  return changes ? { ok: true } : { ok: false, code: 'not_found' }
}

export function createTarget(target, database = db) {
  const result = writeTarget(target, database.prepare(`
    INSERT INTO deploy_target
      (key, repo, script, service, repo_dir, state_key, health_url, health_check_type, extra_services)
    VALUES (@key, @repo, @script, @service, @repoDir, @stateKey, @healthUrl, @healthCheckType, @extraServices)
  `))
  return result.ok ? { ok: true, target: findTargetByKey(target.key, database) } : result
}

// key comes from the path and never changes; an unknown key is not_found.
export function updateTarget(key, fields, database = db) {
  if (!findTargetByKey(key, database)) return { ok: false, code: 'not_found' }
  const result = writeTarget(targetFromBody(key, fields), database.prepare(`
    UPDATE deploy_target SET
      repo = @repo, script = @script, service = @service, repo_dir = @repoDir, state_key = @stateKey,
      health_url = @healthUrl, health_check_type = @healthCheckType, extra_services = @extraServices,
      updated_at = datetime('now')
    WHERE key = @key
  `))
  return result.ok ? { ok: true, target: findTargetByKey(key, database) } : result
}

export function deleteTarget(key, database = db) {
  const { changes } = database.prepare('DELETE FROM deploy_target WHERE key = ?').run(key)
  return changes ? { ok: true } : { ok: false, code: 'not_found' }
}

// The one-time migration, on first import — which is server start, through
// deploy.js. A failure is logged and rolled back; boot continues and every
// release resolves to no target (fails closed).
seedDeployTargets()
