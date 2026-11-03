// HZ-703: the "Connect your repository" card's pure parts — when it shows,
// the GitHub token page it links to, and what a refusal says.

// The design's six permission chips. Each one is a GitHub pre-fill parameter
// at one access level, and `covers` names the server's checks it satisfies
// (REQUIRED_PERMISSIONS in server/src/tokenCheck.js, which the token is held
// to on connect). connectRepo.test.js fails if a server check has no chip.
export const TOKEN_PERMISSIONS = Object.freeze([
  { label: 'Contents: read and write', param: 'contents', level: 'write', covers: ['contents:read', 'contents:write'] },
  { label: 'Issues: read and write', param: 'issues', level: 'write', covers: ['issues:read', 'issues:write'] },
  {
    label: 'Pull requests: read and write',
    param: 'pull_requests',
    level: 'write',
    covers: ['pull_requests:read', 'pull_requests:write'],
  },
  { label: 'Webhooks: read and write', param: 'repository_hooks', level: 'write', covers: ['webhooks:read', 'webhooks:write'] },
  { label: 'Actions: read', param: 'actions', level: 'read', covers: ['actions:read'] },
  { label: 'Metadata: read', param: 'metadata', level: 'read', covers: ['metadata:read'] },
])

export const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new'

// The owner part of `owner/name` (or of a github.com URL), or null.
function repoOwner(repo) {
  const path = String(repo ?? '')
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
  const owner = path.split('/')[0]
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) ? owner : null
}

// GitHub's new fine-grained token page, with its name, description, resource
// owner (from what is typed so far) and every chip's permission filled in.
export function tokenPageUrl(repo) {
  const params = new URLSearchParams({
    name: 'Horizon',
    description: 'Lets Horizon plan, build and test changes in this repository.',
  })
  const owner = repoOwner(repo)
  if (owner) params.set('target_name', owner)
  for (const p of TOKEN_PERMISSIONS) params.set(p.param, p.level)
  return `${TOKEN_PAGE}?${params}`
}

const NOTHING_SAVED = 'Nothing was saved.'

// The UI's own line for a refusal that carries no server message.
const FALLBACK_TEXT = {
  pin_needed: 'Your gate PIN is needed to connect a repository.',
  network: 'Horizon could not be reached. Check your connection and try again.',
  not_a_tenant_project: "This project's repository is set by the Horizon owner, not here.",
  token_store_failed: 'Horizon could not store the token.',
  run_user_provision_failed: 'Horizon could not set up the run user for this project.',
}

const HINT = {
  token_too_broad: `On GitHub, create a fine-grained token. Under Repository access, choose Only select repositories → this one. Then paste it again. ${NOTHING_SAVED}`,
  token_missing_permission: `On GitHub, edit the token and give it the permissions above. Then paste it again. ${NOTHING_SAVED}`,
  pin_needed: `Find or regenerate it in Admin → Your PIN and API tokens, then paste the token again. ${NOTHING_SAVED}`,
}

// { text, hint } for a failed connect: the server's own message when it sent
// one, shown as is; else the UI's line for the code; else the error itself
// (a bad repo's 400 carries its sentence as `error`). Both are plain text.
export function refusalText(err) {
  const code = err?.code ?? err?.message ?? null
  const fallback = code && Object.hasOwn(FALLBACK_TEXT, code) ? FALLBACK_TEXT[code] : null
  const text = err?.serverMessage || fallback || err?.message || 'The repository could not be connected.'
  const hint = code && Object.hasOwn(HINT, code) ? HINT[code] : NOTHING_SAVED
  return { text, hint }
}

// True when a member's active project has no repository and nothing on its
// board yet: the card then stands in for the empty board. A member's project
// carries no `isolation` (boardView.js's memberProject drops it), but members
// only create tenant projects; a shared owner project the server refuses
// with a 404, which the card shows. Never for the owner.
export function needsRepo(project, isOwner, items = []) {
  if (isOwner || !project) return false
  if (!Array.isArray(project.repos) || project.repos.length > 0) return false
  return !items.some((item) => item.project_id === project.id)
}
