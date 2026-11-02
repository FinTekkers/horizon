// HZ-697: a tenant project's own GitHub token — where it lives, and which
// token each server GitHub call for a repo uses.
//
// A tenant's repo connect writes the token to TENANT_TOKEN_ROOT/<project id>,
// mode 0600, owned by this process's user (the farm user: both services run
// as it), and stores only the `file:` ref (projectIsolation.tenantTokenRef).
// The path comes from the integer project id alone — never from input. The
// token is never logged, returned or put in an error from here.
//
// tokenForRepo is what github.js and webhooks.js call per repo. A repo of a
// tenant project gets that project's own token or null — never the owner's
// GITHUB_TOKEN. Everything else (internal projects, unconnected repos) gets
// settings.getToken(), exactly as before. The file is re-read on every call,
// so no cache can outlive a ref change.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { db } from './db.js'
import { getToken } from './settings.js'
import { TENANT_TOKEN_ROOT } from './config.js'
import { FILE_TOKEN_REF_RE, TOKEN_REF_RE, tenantTokenRef } from './projectIsolation.js'

// Installed root-owned by infra/host/install-tenant-host.sh; the sudoers rule
// in infra/host/horizon-tenant.sudoers allows exactly this path with one id.
export const PROVISION_HELPER = '/usr/local/libexec/horizon/horizon-provision-run-user'
const PROVISION_TIMEOUT_MS = 30_000

// The token file of project `projectId`. Throws on anything but a positive
// integer id (tenantTokenRef's check), so no other value can shape the path.
export function tenantTokenPath(projectId) {
  tenantTokenRef(projectId)
  return path.join(TENANT_TOKEN_ROOT, String(projectId))
}

// Writes the token atomically: a fresh temp file (O_EXCL, 0600) beside the
// target, fsynced, its mode and owner checked, then renamed into place. Any
// failure removes the temp file and throws an error that names no value.
export function writeTenantToken(projectId, token) {
  const target = tenantTokenPath(projectId)
  const tmp = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`
  let fd = null
  try {
    fd = fs.openSync(tmp, 'wx', 0o600)
    fs.fchmodSync(fd, 0o600)
    fs.writeSync(fd, token)
    fs.fsyncSync(fd)
    const info = fs.fstatSync(fd)
    if ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()) throw new Error('tenant token file has the wrong mode or owner')
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, target)
  } catch (err) {
    if (fd != null) fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
    throw new Error(`tenant token file could not be written (${err.code ?? 'check'})`)
  }
}

// Rolls back a write. Missing is fine.
export function removeTenantToken(projectId) {
  fs.rmSync(tenantTokenPath(projectId), { force: true })
}

// The token in project `projectId`'s file, or null when it is missing, a
// symlink, not a regular file, not mode 0600, not ours, or empty.
export function readTenantToken(projectId) {
  let fd
  try {
    fd = fs.openSync(tenantTokenPath(projectId), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const info = fs.fstatSync(fd)
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()) return null
    return fs.readFileSync(fd, 'utf8').trim() || null
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

// A tenant project row's own token: its `file:` ref (only the one its id
// allows) or a `$NAME` ref from this process's environment. Null otherwise.
function tenantProjectToken(row) {
  const ref = row.github_token_ref
  if (typeof ref !== 'string') return null
  if (FILE_TOKEN_REF_RE.test(ref)) return ref === tenantTokenRef(row.id) ? readTenantToken(row.id) : null
  if (TOKEN_REF_RE.test(ref)) return process.env[ref.slice(1)] || null
  return null
}

// COLLATE NOCASE, and a tenant row first: a case variant of a tenant's repo
// must still resolve to the tenant, never fall through to the owner's token.
const selectRepoProject = db.prepare(`
  SELECT p.id, p.isolation, p.github_token_ref FROM project_repo r JOIN project p ON p.id = r.project_id
  WHERE r.repo = ? COLLATE NOCASE ORDER BY p.isolation = 'tenant' DESC LIMIT 1
`)

// The token for GitHub calls about `repo` (owner/name). See the header.
export function tokenForRepo(repo) {
  const row = typeof repo === 'string' ? selectRepoProject.get(repo) : null
  if (!row || row.isolation !== 'tenant') return getToken()
  return tenantProjectToken(row)
}

// Whether `repo` belongs to a tenant project — its calls must never fall back
// to the owner's token.
export function isTenantRepo(repo) {
  return typeof repo === 'string' && selectRepoProject.get(repo)?.isolation === 'tenant'
}

// Creates (idempotently) run user hz-p<id> through the root helper. No shell:
// the id is one argv entry, and the error names no output.
export function provisionRunUser(projectId) {
  tenantTokenRef(projectId)
  const id = String(projectId)
  return new Promise((resolve, reject) => {
    execFile('sudo', ['-n', PROVISION_HELPER, id], { timeout: PROVISION_TIMEOUT_MS }, (err) =>
      err ? reject(new Error('run user provisioning failed')) : resolve(),
    )
  })
}
