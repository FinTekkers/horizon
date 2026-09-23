// Real data layer: talks to the Horizon server (server/) via /api (Vite proxy).
// Same interface as mockApi.js — components never know which one they're on.
// State arrives over SSE (/api/stream), so all actions are fire-and-forget
// POSTs; the server broadcasts the updated item list after every mutation.

// Every server request goes through this base so the app works both at the
// dev root (/) and mounted under a subpath in production (vite `base`, e.g.
// '/horizon/' → '/horizon/api'). BASE_URL always ends with a slash.
export const API_BASE = `${import.meta.env.BASE_URL}api`

let repoUrl = 'https://github.com/FinTekkers/horizon'
let items = []
let projects = []
let activeProjectId = null
let farm = { status: 'running' }
let sync = { tokenConfigured: false, repos: [] }
let started = false
const listeners = new Set()

function emit() {
  listeners.forEach((fn) => fn())
}

function applySnapshot(data) {
  repoUrl = data.repoUrl || repoUrl
  sync = data.sync || sync
  projects = data.projects || projects
  activeProjectId = data.activeProjectId ?? activeProjectId
  farm = data.farm || farm
  items = data.items || []
  emit()
}

function refetch() {
  fetch(`${API_BASE}/items`)
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
  source = new EventSource(`${API_BASE}/stream`)
  source.onopen = () => {
    retryMs = 1000
  }
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

export function getProjects() {
  return projects
}

export function getActiveProjectId() {
  return activeProjectId
}

export function getFarm() {
  return farm
}

export function activateProject(projectId) {
  return postJson(`/projects/${projectId}/activate`, {})
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
  if (!item) return
  // Approving "Accept the code" merges the PR server-side. If GitHub refuses
  // (conflicts, required checks), open the PR so the human resolves it there,
  // then approves the gate again.
  const res = await gatePost(`/items/${id}/gates/${item.cursor}/approve`, notes ? { notes } : {})
  if (res && !res.ok && res.status !== 401 && item.pr_url) {
    window.open(item.pr_url, '_blank', 'noopener')
  }
}

export function requestChanges(id, target, feedback, targetStepIndex) {
  const body = { target: target || '', feedback: feedback || '' }
  if (targetStepIndex != null) body.targetStepIndex = targetStepIndex
  gatePost(`/items/${id}/reject`, body)
}

export function togglePause(id) {
  const item = items.find((it) => it.id === id)
  if (!item) return
  post(`/items/${id}/pause`, { paused: !item.paused })
}

export function restartPhase(id, phase, reason) {
  gatePost(`/items/${id}/phases/${phase}/restart`, { reason: reason || '' })
}

export function setPersona(id, persona) {
  return post(`/items/${id}/persona`, { persona })
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
