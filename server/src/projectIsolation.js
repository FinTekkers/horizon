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

export const ISOLATIONS = ['internal', 'tenant']
export const TOKEN_REF_RE = /^\$[A-Z_][A-Z0-9_]*$/
export const RUN_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/

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
    ['github_token_ref', typeof project.githubTokenRef === 'string' && TOKEN_REF_RE.test(project.githubTokenRef)],
    ['run_user', typeof project.runUser === 'string' && RUN_USER_RE.test(project.runUser)],
  ]
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
  if (missing.length === 0) return null
  return `tenant project needs ${missing.join(' and ')} before the farm runs it`
}
