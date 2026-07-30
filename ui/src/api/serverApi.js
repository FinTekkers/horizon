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
let security = { gateKeyConfigured: false }
let started = false
const listeners = new Set()

function emit() {
  listeners.forEach((fn) => fn())
}

function applySnapshot(data) {
  repoUrl = data.repoUrl || repoUrl
  sync = data.sync || sync
  security = data.security || security
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
  refetch()
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

export function getSecurity() {
  return security
}

// ---- human gate key ----
// The plaintext key lives ONLY here (browser localStorage); the server keeps
// a hash. Gate actions send it as a header; agents have no way to obtain it.

const KEY_STORAGE = 'horizon_human_key'

function humanKey() {
  return localStorage.getItem(KEY_STORAGE) || ''
}

function promptForKey(message) {
  const key = window.prompt(message)
  if (key) localStorage.setItem(KEY_STORAGE, key)
  return key || ''
}

async function gatePost(path, body, method = 'POST') {
  let key = humanKey()
  if (security.gateKeyConfigured && !key) {
    key = promptForKey('Enter the human gate key (set in Admin → Security):')
  }
  const doFetch = (k) =>
    fetch(`${API_BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-human-key': k },
      body: JSON.stringify(body ?? {}),
    })
  let res = await doFetch(key).catch(() => null)
  if (res && res.status === 401) {
    localStorage.removeItem(KEY_STORAGE)
    const retryKey = promptForKey('Gate key incorrect — enter the human gate key:')
    if (retryKey) res = await doFetch(retryKey).catch(() => null)
  }
  return res
}

export async function saveHumanKey(key, currentKey) {
  const result = await postJson('/security/key', { key, currentKey: currentKey || '' })
  localStorage.setItem(KEY_STORAGE, key) // this browser is the key holder
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
// unauthenticated new-tab pattern as artifactUrl above.
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

export function requestChanges(id, target, feedback) {
  gatePost(`/items/${id}/reject`, { target: target || '', feedback: feedback || '' })
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

export function getDefinition(kind, name) {
  return getJson(`/definitions/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`)
}

export function effectivePrompt(params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v))
  return getJson(`/definitions/effective?${qs}`)
}

// Saving is a gate action (same human key as approvals) — every save becomes
// a git commit server-side; errors carry the lint/size rejection detail.
export async function saveDefinition(kind, name, content) {
  const res = await gatePost(
    `/definitions/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`,
    { content, actor: 'AP' },
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
