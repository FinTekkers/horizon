// Real data layer: talks to the Horizon server (server/) via /api (Vite proxy).
// Same interface as mockApi.js — components never know which one they're on.
// State arrives over SSE (/api/stream), so all actions are fire-and-forget
// POSTs; the server sends what changed after every mutation (HZ-318: a full
// `snapshot` event on connect, then `delta` events at most once a second).

// Every server request goes through this base so the app works both at the
// dev root (/) and mounted under a subpath in production (vite `base`, e.g.
// '/horizon/' → '/horizon/api'). BASE_URL always ends with a slash.
export const API_BASE = `${import.meta.env.BASE_URL}api`

let repoUrl = 'https://github.com/FinTekkers/horizon'
let items = []
let projects = []
let activeProjectId = null
let farm = { status: 'running' }
// HZ-229's per-step typical durations. The concierge snapshot omits them, so
// a snapshot without the field keeps the last one.
let durationEstimates = null
let sync = { tokenConfigured: false, repos: [] }
let started = false
const listeners = new Set()

function emit() {
  listeners.forEach((fn) => fn())
}

function applySnapshot(data) {
  applyTop(data)
  items = data.items || []
  emit()
}

// HZ-318: what changed since the last event — whole items to add or replace,
// ids that left the board, changed top-level keys, and the full id order when
// it changed. Items the delta does not name keep their object, so a component
// keyed on one item (the Tracker's step-output fetch) only reruns when that
// item actually changed.
function applyDelta({ upserts = [], removed = [], top = {}, order }) {
  applyTop(top)
  const byId = new Map(items.map((it) => [it.id, it]))
  for (const id of removed) byId.delete(id)
  for (const item of upserts) byId.set(item.id, item)
  // A Map keeps insertion order, so without `order` the board order is
  // unchanged and an id this tab has never seen goes last.
  items = order ? order.filter((id) => byId.has(id)).map((id) => byId.get(id)) : [...byId.values()]
  emit()
}

// The board's top-level keys from a snapshot or a delta's `top`. A key the
// payload leaves out keeps its last value.
function applyTop(data) {
  repoUrl = data.repoUrl || repoUrl
  sync = data.sync || sync
  projects = data.projects || projects
  activeProjectId = data.activeProjectId ?? activeProjectId
  farm = data.farm || farm
  durationEstimates = data.durationEstimates ?? durationEstimates
}

function refetch() {
  fetch(`${API_BASE}/items?v=2`)
    .then((r) => r.json())
    .then(applySnapshot)
    .catch((err) => console.error('Failed to load items', err))
}

// SSE with reconnection: EventSource gives up permanently if the server is
// mid-restart (proxy returns an error status), so we recreate it with backoff.
// Every (re)connect receives a full snapshot from the server, which resyncs
// anything missed while disconnected.
let source = null
let retryMs = 1000

function connect() {
  source = new EventSource(`${API_BASE}/stream?v=2`)
  source.onopen = () => {
    retryMs = 1000
  }
  source.addEventListener('snapshot', (msg) => applySnapshot(JSON.parse(msg.data)))
  source.addEventListener('delta', (msg) => applyDelta(JSON.parse(msg.data)))
  // A server from before HZ-318 (a rollback) ignores `v` and sends the whole
  // board as default `message` frames.
  source.onmessage = (msg) => applySnapshot(JSON.parse(msg.data))
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      setTimeout(connect, retryMs)
      retryMs = Math.min(retryMs * 2, 15_000)
    }
    // CONNECTING means the browser is already retrying on its own
  }
}

function start() {
  if (started) return
  started = true
  // connect() alone is enough for first paint: the server writes a full
  // snapshot synchronously as the SSE connection's first message (see
  // /api/stream). A separate parallel refetch() here raced it — whichever
  // response landed last won, so an older snapshot arriving after a newer
  // one could silently revert the UI, with nothing to notice until the
  // stream's next reconnect.
  connect()
  // Coming back to the tab: resync immediately and revive a dead stream.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refetch()
      if (source?.readyState === EventSource.CLOSED) connect()
    }
  })
}

export function subscribe(listener) {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getItems() {
  return items
}

export function getSync() {
  return sync
}

// HZ-318: one item's stepOutputs, which the board feed leaves off. Resolves to
// the { "<step index>": { output, attempt, artifact, attemptCount, label } }
// map, or null when the item is not visible or the request failed.
export async function getStepOutputs(id) {
  const res = await fetch(`${API_BASE}/items/${encodeURIComponent(id)}/step-outputs`).catch(() => null)
  if (!res?.ok) return null
  const data = await res.json().catch(() => null)
  return data?.stepOutputs ?? null
}

// ---- auth (HZ-21): hardcoded credential OR Google SSO ----
// Every request already carries the session cookie (fetch's default
// credentials: 'same-origin'), so no token plumbing is needed here beyond
// login/logout/me.

export function login(email, password) {
  return postJson('/auth/login', { email, password })
}

export function logout() {
  return postJson('/auth/logout', {})
}

// Resolves to the logged-in user, or null if there is no session.
export async function getCurrentUser() {
  const res = await fetch(`${API_BASE}/auth/me`).catch(() => null)
  if (!res || res.status === 401) return null
  const data = await res.json().catch(() => ({}))
  return data.user || null
}

// Plain server-driven redirect — no Google JS SDK in this bundle.
export function googleLoginUrl() {
  return `${API_BASE}/auth/google/start`
}

// ---- gate PIN ----
// A cryptographic blocker kept separate from login: every account gets its
// own PIN, auto-generated (never chosen) so an AI agent can't self-approve a
// gate. The plaintext lives ONLY here (browser localStorage); the server
// keeps a hash. Gate actions send it as a header; agents have no way to get it.

const PIN_STORAGE = 'horizon_gate_pin'

function gatePin() {
  return localStorage.getItem(PIN_STORAGE) || ''
}

function promptForPin(message) {
  const pin = window.prompt(message)
  if (pin) localStorage.setItem(PIN_STORAGE, pin)
  return pin || ''
}

async function gatePost(path, body, method = 'POST') {
  let pin = gatePin()
  if (!pin) {
    pin = promptForPin('Enter your gate PIN (shown when it was last generated — regenerate it in Admin if lost):')
  }
  const doFetch = (p) =>
    fetch(`${API_BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-human-key': p },
      body: JSON.stringify(body ?? {}),
    })
  let res = await doFetch(pin).catch(() => null)
  if (res && res.status === 401) {
    localStorage.removeItem(PIN_STORAGE)
    const retryPin = promptForPin('Gate PIN incorrect — enter your gate PIN:')
    if (retryPin) res = await doFetch(retryPin).catch(() => null)
  }
  return res
}

// Regenerating replaces the old PIN outright — returns the new plaintext,
// shown once, same as account creation.
export async function regenerateGatePin() {
  const result = await postJson('/auth/gate-pin/regenerate', {})
  localStorage.setItem(PIN_STORAGE, result.pin) // this browser is the PIN holder
  return result
}

// ---- personal API tokens (HZ-179) ----
// The raw token comes back once, from createApiToken, and is handed straight
// to the caller to show — it is never stored here (no localStorage, unlike
// the gate PIN above): the browser has no use for it after the user copies it.

export function listApiTokens() {
  return getJson('/tokens')
}

export function createApiToken({ name, expiresInDays }) {
  return postJson('/tokens', { name, expiresInDays })
}

export function revokeApiToken(id) {
  return deleteJson(`/tokens/${encodeURIComponent(id)}`)
}

export function getProjects() {
  return projects
}

export function getActiveProjectId() {
  return activeProjectId
}

export function getFarm() {
  return farm
}

export function getDurationEstimates() {
  return durationEstimates
}

// HZ-208: flip a project's enabled flag. The PIN is asked for on every flip
// and sent only in the x-human-key header — never cached (unlike gatePost,
// which keeps it in localStorage), never logged, never in the URL.
export async function setProjectEnabled(projectId, enabled, pin) {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/enabled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-human-key': pin },
    body: JSON.stringify({ enabled }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

// HZ-270: a project's Autopilot mode (off | shadow | on). Same PIN handling
// as setProjectEnabled: sent only in the x-human-key header, never cached.
export async function setProjectAutopilot(projectId, mode, pin) {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/autopilot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-human-key': pin },
    body: JSON.stringify({ mode }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

// HZ-245: a repo's check commands (install, test, lint, e2e). Same PIN
// handling as setProjectEnabled: asked for on every save, sent only in the
// x-human-key header, never cached.
export async function saveRepoChecks(projectId, repo, checks, pin) {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/repos/checks`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-human-key': pin },
    body: JSON.stringify({ repo, ...checks }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

// What auto-detection would run for the repo — Admin's placeholders.
export function getRepoCheckDefaults(projectId, repo) {
  return getJson(`/projects/${encodeURIComponent(projectId)}/repos/check-defaults?repo=${encodeURIComponent(repo)}`)
}

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`)
  return data
}

async function deleteJson(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`)
  return data
}

export function saveToken(token) {
  return postJson('/sync/token', { token })
}

export function createProject(name) {
  return postJson('/projects', { name })
}

export function addRepoToProject(projectId, repo) {
  return postJson(`/projects/${projectId}/repos`, { repo })
}

export function disconnectRepo(projectId, repo) {
  return postJson(`/projects/${projectId}/repos/disconnect`, { repo })
}

// HZ-244: each connected repo's GitHub webhook status, read live by the server.
export function getRepoWebhooks(projectId) {
  return getJson(`/projects/${encodeURIComponent(projectId)}/repos/webhooks`)
}

// HZ-244: create a missing webhook or repair a mismatched one. Gate-PIN
// protected like setProjectEnabled — the PIN goes only in the x-human-key
// header, never cached or put in the URL.
export async function fixRepoWebhook(projectId, repo, pin) {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/repos/webhook/fix`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-human-key': pin },
    body: JSON.stringify({ repo }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

export function artifactUrl(itemId, stepIndex) {
  return `${API_BASE}/items/${itemId}/artifacts/${stepIndex}`
}

// Full-page views opened via "See agent output" (HZ-14) — plain links, same
// new-tab pattern as artifactUrl above; the browser sends the session cookie
// automatically so opening either in a new tab never asks for a second login.
export function outputUrl(itemId, stepIndex) {
  return `${API_BASE}/items/${itemId}/steps/${stepIndex}/output`
}

export function runLogViewUrl(runId) {
  return `${API_BASE}/runs/${runId}/log/view`
}

export function issueUrl(item) {
  return item.repo ? `https://github.com/${item.repo}/issues/${item.issue}` : `${repoUrl}/issues/${item.issue}`
}

export function issueLabel(item) {
  return `#${item.issue}`
}

// Creates a work item (a GitHub issue when sync is connected). Resolves with
// { id, issue?, url? }; throws with the server/GitHub rejection reason.
export async function createItem(fields) {
  const res = await fetch(`${API_BASE}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`)
  return data
}

// ---- actions ----

function post(path, body) {
  return fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).catch((err) => console.error(`POST ${path} failed`, err))
}

export async function approveGate(id, notes) {
  const item = items.find((it) => it.id === id)
  if (!item) return { ok: false }
  // Approving "Accept the code" merges the PR server-side. If GitHub refuses
  // (conflicts, required checks), open the PR so the human resolves it there,
  // then approves the gate again. A pre-merge check failure (HZ-183) is not
  // GitHub's refusal — the PR page says nothing about it, the item's activity
  // names the failing check — so that one stays on the tracker.
  const res = await gatePost(`/items/${id}/gates/${item.cursor}/approve`, notes ? { notes } : {})
  if (!res) return { ok: false }
  const data = await res.json().catch(() => ({ ok: false }))
  if (!res.ok && res.status !== 401 && item.pr_url && !data.premerge) {
    window.open(item.pr_url, '_blank', 'noopener')
  }
  return data
}

export function requestChanges(id, target, feedback, targetStepIndex) {
  const body = { target: target || '', feedback: feedback || '' }
  if (targetStepIndex != null) body.targetStepIndex = targetStepIndex
  gatePost(`/items/${id}/reject`, body)
}

// HZ-92: the fast path — a plain git merge + the repo's own tests, run by
// the farm, gated by the same PIN as every other Accept-gate action. Resolves
// with the server's {ok, resolved, escalated?} so the caller can surface
// what actually happened (mechanically fixed vs. sent back to implement).
export async function resolveConflicts(id) {
  const res = await gatePost(`/items/${id}/resolve-conflicts`, {})
  return res ? await res.json().catch(() => ({ ok: false })) : { ok: false }
}

// HZ-185: forward an item the latest automated review rejected to Accept the
// code with the failing verdict attached, gated by the same PIN. Resolves with
// the server's {ok, forwarded} or {error} so the caller can say why not.
export async function forwardToAccept(id) {
  const res = await gatePost(`/items/${id}/forward-to-accept`, {})
  return res ? await res.json().catch(() => ({ ok: false })) : { ok: false }
}

export function togglePause(id) {
  const item = items.find((it) => it.id === id)
  if (!item) return
  post(`/items/${id}/pause`, { paused: !item.paused })
}

// HZ-310: drops one edge. postJson (not the fire-and-forget post) so a 404 or
// 409 rejects and the item view keeps the edge shown with the error. The
// server logs the event, broadcasts the snapshot and re-kicks the item.
export function removeDependency(id, dependsOnId) {
  return postJson(`/items/${id}/dependencies/remove`, { dependsOnId })
}

export function restartPhase(id, phase, reason) {
  gatePost(`/items/${id}/phases/${phase}/restart`, { reason: reason || '' })
}

// Soft delete (HZ-59) — same gate PIN as approve/reject, reused via gatePost.
export function abandonItem(id, reason) {
  gatePost(`/items/${id}/abandon`, { reason: reason || '' })
}

// Personas are agent-scoped (HZ-125): one slot per composing agent, so the
// agent travels with the id and the server merges rather than replaces.
export function setPersona(id, agent, persona) {
  return post(`/items/${id}/persona`, { agent, persona })
}

// ---- agent definitions (HZ-9) ----

async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export function listDefinitions() {
  return getJson('/definitions')
}

// ---- deploy targets (HZ-41, read-only) ----

export function getDeployTargets() {
  return getJson('/admin/deploy-targets')
}

// HZ-258: a target's Dry run — five read-only checks. Gate-PIN protected like
// fixRepoWebhook: the PIN goes only in the x-human-key header, never cached.
// The body is always empty: the server probes only the stored target.
export async function dryRunDeployTarget(key, pin) {
  const res = await fetch(`${API_BASE}/admin/deploy-targets/${encodeURIComponent(key)}/dry-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-human-key': pin },
    body: JSON.stringify({}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

// ---- deploy target overrides (HZ-259) ----
// The stored rows, and PIN-gated create / edit / delete. The PIN goes only in
// the x-human-key header — never the URL, body or storage. Errors carry the
// status, the server's error code and checkRunnable's reason, nothing else.

export function getDeployTargetConfig() {
  return getJson('/admin/deploy-targets/config')
}

async function deployTargetWrite(method, path, body, pin) {
  const headers = { 'x-human-key': pin }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API_BASE}/admin/deploy-targets${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    err.code = data.error ?? data.code
    err.reason = data.reason
    throw err
  }
  return data
}

export function createDeployTarget(target, pin) {
  return deployTargetWrite('POST', '', target, pin)
}

export function updateDeployTarget(key, fields, pin) {
  return deployTargetWrite('PUT', `/${encodeURIComponent(key)}`, fields, pin)
}

export function deleteDeployTarget(key, pin) {
  return deployTargetWrite('DELETE', `/${encodeURIComponent(key)}`, undefined, pin)
}

export function getDefinition(kind, name) {
  return getJson(`/definitions/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`)
}

export function effectivePrompt(params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v))
  return getJson(`/definitions/effective?${qs}`)
}

// Saving is a gate action (same gate PIN as approvals) — every save becomes
// a git commit server-side, attributed to the logged-in session's own name;
// errors carry the lint/size rejection detail.
export async function saveDefinition(kind, name, content) {
  const res = await gatePost(
    `/definitions/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`,
    { content },
    'PUT',
  )
  if (!res) throw new Error('Could not reach the server')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (data.error === 'credential_pattern') {
      throw new Error(`Looks like a credential — move it to an $ENV_VAR reference (${data.matches.join(', ')})`)
    }
    if (data.error === 'rules_too_large') throw new Error(`Too large — the per-file cap is ${data.limit} bytes`)
    if (data.error === 'git_dirty') throw new Error('The server checkout has unrelated staged changes — resolve them first')
    if (data.error === 'push_failed') throw new Error(`Committed locally but the push failed — the edit is not on origin yet (${data.commit})`)
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data
}

// ---- project and repo rules (HZ-246: DB versions over the .md defaults) ----

export function listRuleTargets() {
  return getJson('/rules/targets')
}

export function listRuleVersions(scope, key) {
  return getJson(`/rules/${encodeURIComponent(scope)}/${encodeURIComponent(key)}/versions`)
}

// Same PIN handling as setProjectEnabled: asked for on every save or restore,
// sent only in the x-human-key header, never cached.
async function rulesPost(path, body, pin) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-human-key': pin },
    body: JSON.stringify(body ?? {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    let message = data.error || `HTTP ${res.status}`
    if (data.error === 'credential_pattern') {
      message = `Looks like a credential — move it to an $ENV_VAR reference (${data.matches.join(', ')})`
    }
    if (data.error === 'rules_too_large') message = `Too large — the cap is ${data.limit} bytes`
    if (data.error === 'rules_secret_not_configured') message = 'Rules saving is not configured on the Horizon server'
    if (data.error === 'unverified_version') message = 'That version failed its integrity check and cannot be restored'
    const err = new Error(message)
    err.status = res.status
    throw err
  }
  return data
}

export function saveRule(scope, key, content, pin) {
  return rulesPost(`/rules/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`, { content }, pin)
}

export function restoreRule(scope, key, version, pin) {
  return rulesPost(
    `/rules/${encodeURIComponent(scope)}/${encodeURIComponent(key)}/versions/${encodeURIComponent(version)}/restore`,
    {},
    pin,
  )
}
