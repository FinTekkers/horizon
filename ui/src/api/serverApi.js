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

// ---- actions ----

function post(path, body) {
  return fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).catch((err) => console.error(`POST ${path} failed`, err))
}

export async function approveGate(id) {
  const item = items.find((it) => it.id === id)
  if (!item) return
  // Approving "Accept the code" merges the PR server-side. If GitHub refuses
  // (conflicts, required checks), open the PR so the human resolves it there,
  // then approves the gate again.
  const res = await fetch(`/api/items/${id}/gates/${item.cursor}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => null)
  if (res && !res.ok && item.pr_url) {
    window.open(item.pr_url, '_blank', 'noopener')
  }
}

export function requestChanges(id, target, feedback) {
  post(`/items/${id}/reject`, { target: target || '', feedback: feedback || '' })
}

export function togglePause(id) {
  const item = items.find((it) => it.id === id)
  if (!item) return
  post(`/items/${id}/pause`, { paused: !item.paused })
}

export function restartPhase(id, phase, reason) {
  post(`/items/${id}/phases/${phase}/restart`, { reason: reason || '' })
}
