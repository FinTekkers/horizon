// HZ-244: each connected repo's GitHub webhook — the one that delivers issues,
// comments, PRs and releases to POST /api/webhooks/github.
//
// The only module that touches $GITHUB_WEBHOOK_SECRET on the way out or reads a
// hook's raw `config`. Everything it returns is a Status:
//
//   { status: 'ok'|'missing'|'mismatched'|'error', lastResponseCode, reason, httpStatus? }
//
// — never the secret, the token, the raw config or the hook id.
//
// Writes are deliberately narrow: ensure() (connect) only ever POSTs a hook
// when there is none, and fix() (PIN-gated) POSTs or PATCHes the hook whose
// config.url is exactly ours. There is no DELETE path, and a hook with any
// other URL is never written to.

import { WEBHOOK_SECRET, WEBHOOK_URL } from './config.js'
import { getToken } from './settings.js'
import { ghHeaders } from './github.js'

// Sorted, so a hook's events compare as a set by joining.
export const HOOK_EVENTS = ['issue_comment', 'issues', 'pull_request', 'release']

// Paths a Horizon webhook lives at: bare, and under nginx's /horizon/ prefix.
const HOOK_PATHS = new Set(['/api/webhooks/github', '/horizon/api/webhooks/github'])

export function webhookUrl() {
  return WEBHOOK_URL
}

// A hook GitHub can actually reach — https, and not this machine. Guards
// against a misconfigured HORIZON_UI_URL creating localhost hooks on every
// connect.
function urlIsPublic(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (parsed.protocol !== 'https:') return false
  return !(host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1' || host.startsWith('127.'))
}

function hookBody() {
  return {
    name: 'web',
    active: true,
    events: HOOK_EVENTS,
    config: { url: webhookUrl(), content_type: 'json', secret: WEBHOOK_SECRET, insecure_ssl: '0' },
  }
}

const status = (s, lastResponseCode = null, reason = null) => ({ status: s, lastResponseCode, reason })

const githubError = (httpStatus) => ({ ...status('error', null, httpStatus ? 'github_error' : 'github_unreachable'), httpStatus: httpStatus ?? null })

const lastCode = (hook) => (Number.isInteger(hook?.last_response?.code) ? hook.last_response.code : null)

function matches(hook) {
  const events = Array.isArray(hook.events) ? [...hook.events].sort().join(',') : ''
  return hook.active === true && hook.config?.content_type === 'json' && events === HOOK_EVENTS.join(',')
}

// A Horizon-shaped hook on another host (say, an old hostname). Reported as
// mismatched, but never written to: Fix creates a correct hook beside it.
function isForeignHorizonHook(hook) {
  const url = hook.config?.url
  if (typeof url !== 'string' || url === webhookUrl()) return false
  try {
    return HOOK_PATHS.has(new URL(url).pathname)
  } catch {
    return false
  }
}

// One read-only GET. Returns the public Status plus, internally, the id of our
// own mismatched hook so fix() can PATCH it.
async function classify(repo) {
  let res
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/hooks?per_page=100`, { headers: ghHeaders(getToken()) })
  } catch {
    return { result: githubError(null) }
  }
  if (!res.ok) return { result: githubError(res.status) }
  const hooks = (await res.json().catch(() => null)) || []
  if (!Array.isArray(hooks)) return { result: githubError(res.status) }

  const ours = hooks.filter((h) => h?.config?.url === webhookUrl()).sort((a, b) => a.id - b.id)
  const good = ours.find(matches)
  if (good) return { result: status('ok', lastCode(good)) }
  if (ours.length) return { result: status('mismatched', lastCode(ours[0])), hookId: ours[0].id }
  const foreign = hooks.find((h) => h && isForeignHorizonHook(h))
  if (foreign) return { result: status('mismatched', lastCode(foreign), 'foreign_url') }
  return { result: status('missing') }
}

// Reads only. With no secret configured nothing is called at all — Horizon
// could not create a signed hook anyway.
export async function inspect(repo) {
  if (!WEBHOOK_SECRET) return status('error', null, 'secret_not_configured')
  return (await classify(repo)).result
}

// Refusals checked before any GitHub call by both write paths.
function writeRefusal() {
  if (!WEBHOOK_SECRET) return status('error', null, 'secret_not_configured')
  if (!urlIsPublic(webhookUrl())) return status('error', null, 'webhook_url_not_public')
  return null
}

async function write(method, path) {
  let res
  try {
    res = await fetch(`https://api.github.com/repos/${path}`, {
      method,
      headers: { ...ghHeaders(getToken()), 'Content-Type': 'application/json' },
      body: JSON.stringify(hookBody()),
    })
  } catch {
    return githubError(null)
  }
  // The response echoes the hook's config — read nothing from it.
  await res.arrayBuffer().catch(() => {})
  return res.ok ? null : githubError(res.status)
}

// Connect: create the hook only when the repo has no Horizon hook at all.
// A matching or mismatched hook is reported, never touched.
export async function ensure(repo) {
  const refused = writeRefusal()
  if (refused) return refused
  const { result } = await classify(repo)
  if (result.status !== 'missing') return result
  return (await write('POST', `${repo}/hooks`)) || status('ok', null, 'created')
}

// PIN-gated Fix webhook: POST when missing (or only a foreign-host hook
// exists), PATCH our own hook by id when it is mismatched.
export async function fix(repo) {
  const refused = writeRefusal()
  if (refused) return { action: 'none', ...refused }
  const { result, hookId } = await classify(repo)
  if (result.status === 'ok' || result.status === 'error') return { action: 'none', ...result }
  if (result.status === 'mismatched' && hookId != null) {
    const failed = await write('PATCH', `${repo}/hooks/${encodeURIComponent(hookId)}`)
    return failed ? { action: 'none', ...failed } : { action: 'repaired', ...status('ok', result.lastResponseCode) }
  }
  const failed = await write('POST', `${repo}/hooks`)
  return failed ? { action: 'none', ...failed } : { action: 'created', ...status('ok') }
}
