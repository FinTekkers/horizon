// Real data layer: talks to the Horizon server (server/) via /api (Vite proxy).
// Same interface as mockApi.js — components never know which one they're on.
// State arrives over SSE (/api/stream), so all actions are fire-and-forget
// POSTs; the server broadcasts the updated item list after every mutation.

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
  fetch('/api/items')
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
  source = new EventSource('/api/stream')
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

async function gatePost(path, body) {
  let key = humanKey()
  if (security.gateKeyConfigured && !key) {
    key = promptForKey('Enter the human gate key (set in Admin → Security):')
  }
  const doFetch = (k) =>
    fetch(`/api${path}`, {
      method: 'POST',
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
  const res = await fetch(`/api${path}`, {
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

export function issueUrl(item) {
  return item.repo ? `https://github.com/${item.repo}/issues/${item.issue}` : `${repoUrl}/issues/${item.issue}`
}

export function issueLabel(item) {
  return `#${item.issue}`
}

// Creates a work item (a GitHub issue when sync is connected). Resolves with
// { id, issue?, url? }; throws with the server/GitHub rejection reason.
export async function createItem(fields) {
  const res = await fetch('/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`)
  return data
}

// Tail an active farm run's log (HZ-5 Live activity) — the same stream shown
// in the run's tmux pane. Throws with .status set so callers can stop polling
// on 404 (PM-session steps share a log and have no per-run tail).
export async function getRunLog(runId, offset = 0) {
  const res = await fetch(`/api/runs/${runId}/log?offset=${encodeURIComponent(offset)}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

// ---- actions ----

function post(path, body) {
  return fetch(`/api${path}`, {
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
