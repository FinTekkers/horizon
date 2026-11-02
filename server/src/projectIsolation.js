// HZ-662: a project's isolation — `internal` (the owner's own work) or
// `tenant` (a project a non-owner created). A tenant project's items run only
// once it names a GitHub credential reference and a run user; until then the
// orchestrator holds them (kick) and farmd refuses them as a backstop.
//
// The same rule lives in farm/farmd.py's _isolation_refusal; both run
// domain/fixtures/isolation-cases.json, so the two cannot drift.
//
// github_token_ref holds a reference only, such as $ACME_GITHUB_TOKEN — never a
// token value. Nothing here resolves it or switches user; that is HZ-663.
//
// HZ-697: or the `file:` form, set only by a tenant's own repo connect. Its
// path is derived from the project id alone (tenantTokenRef), never from
// input. TOKEN_REF_RE stays the $NAME form only: it is also the Admin route's
// schema pattern, and Admin cannot set a `file:` ref.

export const ISOLATIONS = ['internal', 'tenant']
export const TOKEN_REF_RE = /^\$[A-Z_][A-Z0-9_]*$/
export const RUN_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/
export const TENANT_TOKEN_DIR = '/etc/horizon/tenant-tokens'
export const FILE_TOKEN_REF_RE = /^file:\/etc\/horizon\/tenant-tokens\/[1-9][0-9]{0,9}$/

// The one `file:` ref project `projectId` may hold. Throws on anything but a
// positive integer id, so no other value can shape the path.
export function tenantTokenRef(projectId) {
  if (!Number.isSafeInteger(projectId) || projectId < 1 || projectId > 9_999_999_999) throw new Error('tenantTokenRef: project id must be a positive integer')
  return `file:${TENANT_TOKEN_DIR}/${projectId}`
}

// The run user a tenant's own repo connect provisions for `projectId`.
export function tenantRunUser(projectId) {
  tenantTokenRef(projectId)
  return `hz-p${projectId}`
}

// Either form of reference — never a value.
export function isTokenRef(ref) {
  return typeof ref === 'string' && (TOKEN_REF_RE.test(ref) || FILE_TOKEN_REF_RE.test(ref))
}

// The shape farmd is sent and isolationRefusal reads, from a project row.
export function isolationFields(row) {
  return { isolation: row.isolation, githubTokenRef: row.github_token_ref ?? null, runUser: row.run_user ?? null }
}

// Why the farm must not run this project's items, or null. `project` is
// isolationFields()'s shape; null is an item with no project (or `Unlinked
// items`), which runs as today. Fails closed: any isolation other than the two
// known values — a missing one included — is refused. The reason names fields
// only, never the ref and never a value.
export function isolationRefusal(project) {
  if (project == null) return null
  if (!ISOLATIONS.includes(project.isolation)) return "unknown isolation: the farm will not run this project's items"
  if (project.isolation === 'internal') return null
  const missing = [
    ['github_token_ref', isTokenRef(project.githubTokenRef)],
    ['run_user', typeof project.runUser === 'string' && RUN_USER_RE.test(project.runUser)],
  ]
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
  if (missing.length === 0) return null
  return `tenant project needs ${missing.join(' and ')} before the farm runs it`
}
