// HZ-697: is a tenant's GitHub token fit to connect exactly one repo?
//
// checkTenantToken(repo, token) answers before anything is saved:
//   - a classic `ghp_` token is refused outright: its `repo` scope reaches
//     every repository its user can, so it can never be limited to one. Any
//     other token that is not a fine-grained `github_pat_` one is refused too;
//   - the token must read the named repo (Metadata: read), and GitHub's
//     canonical name and default branch come from that read;
//   - every page of /user/repos (followed by its Link rel="next") must list
//     no repository but the named one;
//   - each of REQUIRED_PERMISSIONS is probed. A read probe passes on 2xx only.
//     A write probe POSTs a literal `{}` body, which GitHub can only refuse:
//     422 (invalid body) means the permission is granted, and ANY other status
//     — 403, 404, even 2xx — counts as missing. Nothing is ever created.
// A refusal's message names the over-broad reach or the missing permission,
// never the token. Network failures and GitHub 5xx are `github_unreachable`.

import { ghHeaders } from './github.js'

const API = 'https://api.github.com'
const PAGE_SIZE = 100
const MAX_PAGES = 50

// One probe per permission and access level, in the order they are checked.
// `path` is appended to /repos/{repo}.
export const REQUIRED_PERMISSIONS = Object.freeze([
  { permission: 'metadata:read', label: 'Metadata: read', method: 'GET', path: '' },
  { permission: 'contents:read', label: 'Contents: read', method: 'GET', path: '/contents/' },
  { permission: 'contents:write', label: 'Contents: write', method: 'POST', path: '/git/refs' },
  { permission: 'issues:read', label: 'Issues: read', method: 'GET', path: '/issues?per_page=1' },
  { permission: 'issues:write', label: 'Issues: write', method: 'POST', path: '/issues' },
  { permission: 'pull_requests:read', label: 'Pull requests: read', method: 'GET', path: '/pulls?per_page=1' },
  { permission: 'pull_requests:write', label: 'Pull requests: write', method: 'POST', path: '/pulls' },
  { permission: 'webhooks:read', label: 'Webhooks: read', method: 'GET', path: '/hooks?per_page=1' },
  { permission: 'webhooks:write', label: 'Webhooks: write', method: 'POST', path: '/hooks' },
  { permission: 'actions:read', label: 'Actions: read', method: 'GET', path: '/actions/runs?per_page=1' },
])

const refuse = (error, status, message = null, extra = {}) => ({ ok: false, status, error, ...(message ? { message } : {}), ...extra })
const unreachable = () => refuse('github_unreachable', 502, 'GitHub could not be reached. Try again.')
const rejected = () => refuse('token_rejected', 400, 'GitHub rejected this token.')

async function call(token, method, url) {
  const headers = ghHeaders(token)
  const init = method === 'GET' ? { headers } : { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }
  const res = await fetch(url, init)
  // Read the whole body so the connection is freed; only JSON reads use it.
  const body = await res.json().catch(() => null)
  return { status: res.status, ok: res.ok, body, next: /rel="next"/.test(res.headers.get('link') ?? '') }
}

const sameRepo = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

export async function checkTenantToken(repo, token) {
  if (typeof token === 'string' && token.startsWith('ghp_')) {
    return refuse(
      'token_too_broad',
      400,
      `A classic token's repo scope reaches every repository you can. Create a fine-grained token limited to ${repo} only.`,
    )
  }
  if (typeof token !== 'string' || !token.startsWith('github_pat_')) {
    return refuse('token_not_fine_grained', 400, `Use a fine-grained personal access token limited to ${repo} only.`)
  }
  try {
    // Metadata: read, and the canonical name everything else is checked against.
    const meta = await call(token, 'GET', `${API}/repos/${repo}`)
    if (meta.status === 401) return rejected()
    if (meta.status >= 500) return unreachable()
    if (!meta.ok) return missing(REQUIRED_PERMISSIONS[0], repo)
    const fullName = typeof meta.body?.full_name === 'string' ? meta.body.full_name : repo
    const defaultBranch = typeof meta.body?.default_branch === 'string' ? meta.body.default_branch : null

    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = await call(token, 'GET', `${API}/user/repos?per_page=${PAGE_SIZE}&page=${page}`)
      if (list.status === 401) return rejected()
      if (!list.ok || !Array.isArray(list.body)) return unreachable()
      const other = list.body.find((r) => !sameRepo(r?.full_name, fullName))
      if (other) {
        const name = typeof other.full_name === 'string' ? other.full_name : 'another repository'
        return refuse('token_too_broad', 400, `This token can reach ${name}. Limit it to ${fullName} only.`)
      }
      if (!list.next) break
      if (page === MAX_PAGES) return refuse('token_too_broad', 400, `This token can reach too many repositories. Limit it to ${fullName} only.`)
    }

    for (const probe of REQUIRED_PERMISSIONS.slice(1)) {
      const res = await call(token, probe.method, `${API}/repos/${fullName}${probe.path}`)
      if (res.status === 401) return rejected()
      if (res.status >= 500) return unreachable()
      const granted = probe.method === 'GET' ? res.ok : res.status === 422
      if (!granted) return missing(probe, fullName)
    }
    return { ok: true, fullName, defaultBranch }
  } catch {
    return unreachable()
  }
}

function missing(probe, repo) {
  return refuse('token_missing_permission', 400, `This token lacks ${probe.label} on ${repo}.`, { permission: probe.permission })
}
