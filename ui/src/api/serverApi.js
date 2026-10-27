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
// HZ-360: the self-deploy's block, {blocked, startedAt, latestEnd} or null.
let deployBlock = null
// HZ-547: each Plan's or Task's filed items, summed by the server
// (server/src/planProgress.js). Sent on connect and when it changes.
let planProgress = []
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

// HZ-389: an action's answer carries the item it just wrote, in the shape a
// delta upserts, so it replaces the cached item the same way. An answer older
// than the cached item (a delta landed first) is not applied. `restart` — the
// attempt a send-back started — is kept apart from the item, per item id, for
// the step card's "Sent: attempt N starting"; it is recorded even when the
// item is not swapped, since the newer cached item may not show that run yet.
const restartsSent = new Map()

function applyActionItem(item, restart) {
  if (restart) restartsSent.set(item.id, restart)
  const cached = items.find((it) => it.id === item.id)
  const stale = cached?.last_activity_at && item.last_activity_at && cached.last_activity_at > item.last_activity_at
  // A new array either way, so a page reading items re-renders and reads the
  // restart even when the cached item is kept.
  items = items.map((it) => (it.id === item.id && !stale ? item : it))
  emit()
}

// { stepIndex, attempt } of the last send-back this tab made on the item, or
// null. The Tracker decides how long it is shown.
export function getRestartSent(id) {
  return restartsSent.get(id) ?? null
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
  // HZ-360: null is news here (the block ended), so it is copied as given.
  if ('deployBlock' in data) deployBlock = data.deployBlock
  planProgress = data.planProgress ?? planProgress
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
//
// HZ-388: a half-dead connection never fires onerror, so the stream also has
// a watchdog. The server sends a named `heartbeat` event every 15 s; 45 s with
// no event of any kind means the stream is dead, and it is replaced. Only one
// reconnect is ever pending, and the old stream is closed before the new one
// opens, so two streams are never open at once.
const STALL_MS = 45_000

// A resettable stall timer: kick() on every event, onStall after ms of silence.
function watchdog(onStall, ms = STALL_MS) {
  let timer = null
  return {
    kick() {
      clearTimeout(timer)
      timer = setTimeout(onStall, ms)
    },
    stop() {
      clearTimeout(timer)
      timer = null
    },
  }
}

let source = null
let retryMs = 1000
let reconnectTimer = null
const boardDog = watchdog(() => scheduleReconnect())

// The board stream's one reconnect path: onerror (CLOSED) and the watchdog
// both land here, and a pending reconnect makes any later call a no-op.
function scheduleReconnect() {
  if (reconnectTimer) return
  boardDog.stop()
  source?.close()
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, retryMs)
  retryMs = Math.min(retryMs * 2, 15_000)
}

function connect() {
  source?.close()
  const es = new EventSource(`${API_BASE}/stream?v=2`)
  source = es
  // Armed before onopen, so a stream that never opens is replaced too.
  boardDog.kick()
  // Events from a stream this tab has already replaced are ignored.
  const live = (fn) => (msg) => {
    if (es !== source) return
    boardDog.kick()
    fn(msg)
  }
  es.onopen = live(() => {
    retryMs = 1000
  })
  es.addEventListener('snapshot', live((msg) => applySnapshot(JSON.parse(msg.data))))
  es.addEventListener('delta', live((msg) => applyDelta(JSON.parse(msg.data))))
  // Carries no state: it only resets the watchdog.
  es.addEventListener('heartbeat', live(() => {}))
  // A server from before HZ-318 (a rollback) ignores `v` and sends the whole
  // board as default `message` frames.
  es.onmessage = live((msg) => applySnapshot(JSON.parse(msg.data)))
  es.onerror = () => {
    if (es === source && es.readyState === EventSource.CLOSED) scheduleReconnect()
    // CONNECTING means the browser is already retrying on its own; the
    // watchdog replaces the stream if that retry never gets through.
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
      // A pending reconnect already owns the next stream.
      if (source?.readyState === EventSource.CLOSED && !reconnectTimer) connect()
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

// HZ-318: one item's stepOutputs, which the board feed leaves off, over the
// item's own stream — the only route to them. Calls onOutputs with the
// { "<step index>": { output, attempt, artifact, attemptCount, label } } map on
// open and on every change. Returns the close function: the Tracker opens it on
// mount and closes it on leave. EventSource reconnects by itself after a drop;
// a 404 (the item is not on the board) closes it for good. HZ-388: 45 s with no
// event (the server's `heartbeat` comes every 15 s) replaces the stream, with
// the same backoff as the board stream; the new one's first `outputs` frame
// resyncs. A closed subscription never reopens.
export function subscribeStepOutputs(id, onOutputs) {
  const url = `${API_BASE}/items/${encodeURIComponent(id)}/stream`
  let stream = null
  let timer = null
  let closed = false
  let retryMs = 1000
  const dog = watchdog(reopen)

  function open() {
    const es = new EventSource(url)
    stream = es
    dog.kick()
    es.onopen = () => {
      if (es !== stream) return
      retryMs = 1000
      dog.kick()
    }
    es.addEventListener('outputs', (msg) => {
      if (es !== stream) return
      dog.kick()
      onOutputs(JSON.parse(msg.data).stepOutputs)
    })
    // Carries no state: it only resets the watchdog.
    es.addEventListener('heartbeat', () => {
      if (es === stream) dog.kick()
    })
    es.onerror = () => {
      // The browser gave up (a 404): the item left the board, so stay closed.
      if (es === stream && es.readyState === EventSource.CLOSED) dog.stop()
    }
  }

  function reopen() {
    if (closed || timer) return
    stream.close()
    timer = setTimeout(() => {
      timer = null
      open()
    }, retryMs)
    retryMs = Math.min(retryMs * 2, 15_000)
  }

  open()
  return () => {
    closed = true
    dog.stop()
    clearTimeout(timer)
    timer = null
    stream.close()
  }
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

// HZ-509: whether this browser holds a gate PIN, so a panel can wait for a
// click before a request would prompt for one.
export function hasGatePin() {
  return !!gatePin()
}

// A GET carries no body: fetch refuses one, and the caller would only see null.
async function gatePost(path, body, method = 'POST') {
  let pin = gatePin()
  if (!pin) {
    pin = promptForPin('Enter your gate PIN (shown when it was last generated — regenerate it in Admin if lost):')
  }
  const doFetch = (p) =>
    fetch(
      `${API_BASE}${path}`,
      method === 'GET'
        ? { method, headers: { 'x-human-key': p } }
        : { method, headers: { 'Content-Type': 'application/json', 'x-human-key': p }, body: JSON.stringify(body ?? {}) },
    )
  let res = await doFetch(pin).catch(() => null)
  if (res && res.status === 401) {
    localStorage.removeItem(PIN_STORAGE)
    const retryPin = promptForPin('Gate PIN incorrect — enter your gate PIN:')
    if (retryPin) res = await doFetch(retryPin).catch(() => null)
  }
  return res
}

// HZ-449: a Plan's current item drafts and what has been filed from them
// ({ version, doc, editable, filed }), or null when it has none yet.
export async function getPlanDraft(id) {
  const res = await fetch(`${API_BASE}/items/${encodeURIComponent(id)}/plan-draft`)
  if (res.status === 404) return null
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// HZ-449: saves an owner's edit of the whole draft, made on `baseVersion`.
// The gate PIN goes in the x-human-key header, as gatePost sends it. Rejects
// like gateAction, with the server's `errors` (a 422) and `currentVersion`
// (a 409 stale_version) on the error.
export async function savePlanDraft(id, baseVersion, doc) {
  if (!gatePin() && !promptForPin('Enter your gate PIN (shown when it was last generated — regenerate it in Admin if lost):')) {
    throw new Error('pin_needed')
  }
  const res = await gatePost(`/items/${encodeURIComponent(id)}/plan-draft`, { base_version: baseVersion, doc }, 'PUT')
  if (!res) throw new Error('network')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    err.errors = data.errors ?? []
    err.currentVersion = data.currentVersion ?? null
    throw err
  }
  return data
}

// HZ-470: an awaited gate action (Kill, Restart phase). Rejects with
// Error('pin_needed') when no PIN is stored and the prompt is cancelled or
// empty — nothing is sent; Error('network') when no answer came; else
// Error(<error code>) with `status` on a non-2xx. Never retries on its own
// beyond gatePost's single 401 re-prompt.
async function gateAction(path, body) {
  // promptForPin stores the PIN it gets, so gatePost reads it back from
  // storage and does not prompt a second time.
  if (!gatePin() && !promptForPin('Enter your gate PIN (shown when it was last generated — regenerate it in Admin if lost):')) {
    throw new Error('pin_needed')
  }
  const res = await gatePost(path, body)
  if (!res) throw new Error('network')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

// ---- screenshots at Accept the code (HZ-509) ----

// { commit, shots } — the item's changed, new and removed shots and whether
// each is approved. Rejects with Error(<error code>) and `status` on a non-2xx.
export async function getScreenshots(id) {
  const res = await fetch(`${API_BASE}/items/${encodeURIComponent(id)}/screenshots`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

// One image as an object URL (the caller revokes it). An <img> cannot send
// the PIN header, so the bytes are fetched here. Rejects like gateAction.
export async function getScreenshotImage(id, screen, kind) {
  const path = `/items/${encodeURIComponent(id)}/screenshots/${encodeURIComponent(screen)}/${encodeURIComponent(kind)}`
  const res = await gatePost(path, null, 'GET')
  if (!res) throw new Error('network')
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return URL.createObjectURL(await res.blob())
}

// Approves `screens` (or every listed shot, with { all: true }) of the publish
// `commit` names. Resolves to the new { commit, shots }. Never approves the gate.
export function approveScreenshots(id, commit, { screens, all } = {}) {
  return gateAction(`/items/${encodeURIComponent(id)}/screenshots/approve`, all ? { commit, all: true } : { commit, screens })
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

export function getDeployBlock() {
  return deployBlock
}

export function getPlanProgress() {
  return planProgress
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

// HZ-535: a project's definitions switch. Same PIN handling as
// setProjectAutopilot, so a 401 carries its status for the Admin message.
export async function setProjectDefinitionsEnabled(projectId, enabled, pin) {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/definitions-enabled`, {
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

// HZ-245: a repo's check commands (install, test, lint, e2e, screenshots). Same PIN
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

// HZ-304: a repo's 'no checks' / 'no deploy' marks ({noChecks?, noDeploy?}).
// Same PIN handling as saveRepoChecks: sent only in the x-human-key header.
export async function saveRepoMarks(projectId, repo, marks, pin) {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/repos/marks`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-human-key': pin },
    body: JSON.stringify({ repo, ...marks }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

// HZ-494: a repo's test-login env file — a host PATH only ("" clears it).
// Same PIN handling as saveRepoChecks: sent only in the x-human-key header.
export async function saveRepoTestEnvFile(projectId, repo, path, pin) {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/repos/test-env`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-human-key': pin },
    body: JSON.stringify({ repo, path }),
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

async function putJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
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

// HZ-561: with an attempt, that attempt's artifact (HZ-46's per-attempt route).
export function artifactUrl(itemId, stepIndex, attempt) {
  const base = `${API_BASE}/items/${itemId}/artifacts/${stepIndex}`
  return attempt ? `${base}/${attempt}` : base
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

// HZ-407: the Execute card's Full log link — the job's whole redacted log as
// plain text, served also after Stop.
export function jobLogUrl(itemId) {
  return `${API_BASE}/items/${itemId}/job/log?format=text`
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
  // HZ-384: the run plan this tab showed, so the server refuses the approval
  // if a newer plan landed since — the human approves the plan they saw.
  // HZ-491: and the runner it showed, so a newly pinned or cleared image is
  // not approved unseen.
  const body = {
    ...(notes ? { notes } : {}),
    ...(item.runPlan?.hash ? { planHash: item.runPlan.hash } : {}),
    ...(item.runPlan?.runner ? { runner: item.runPlan.runner } : {}),
  }
  const res = await gatePost(`/items/${id}/gates/${item.cursor}/approve`, body)
  if (!res) return { ok: false }
  const data = await res.json().catch(() => ({ ok: false }))
  if (!res.ok && res.status !== 401 && item.pr_url && !data.premerge) {
    window.open(item.pr_url, '_blank', 'noopener')
  }
  // HZ-360: held for a Horizon deploy (a tab that had not heard of the block
  // yet). Show it queued now; the next push carries the server's own fields.
  if (data.held) {
    deployBlock = deployBlock ?? { blocked: true, startedAt: null, latestEnd: data.latestEnd ?? null }
    items = items.map((it) => (it.id === id ? { ...it, acceptWaiting: { source: 'human', actor: data.actor ?? null } } : it))
    emit()
  }
  return data
}

// HZ-389: awaited, so the composer stays open with the error when it fails.
// Rejects with Error('network') when no answer came, or Error(<error code>)
// with `status` on a non-2xx — items are untouched either way. A 2xx answer's
// item is applied at once, and its `restart` recorded for the step card.
export async function requestChanges(id, target, feedback, targetStepIndex) {
  const body = { target: target || '', feedback: feedback || '' }
  if (targetStepIndex != null) body.targetStepIndex = targetStepIndex
  const res = await gatePost(`/items/${id}/reject`, body)
  if (!res) throw new Error('network')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  if (data.item) applyActionItem(data.item, data.restart)
  return data
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

// HZ-385: sends the state the button shows, never a flip of this tab's cached
// item, which a dead stream can leave stale. postJson so a 404 or 409 rejects
// and the button shows it. The answer's item (HZ-389), or else its `paused`,
// is applied at once; the stream's next delta for the item replaces the whole
// item, so the server always has the last word.
export async function setPaused(id, paused) {
  const data = await postJson(`/items/${id}/pause`, { paused })
  if (data.item) applyActionItem(data.item)
  else if (typeof data.paused === 'boolean') {
    items = items.map((it) => (it.id === id ? { ...it, paused: data.paused } : it))
    emit()
  }
  return data
}

// HZ-544: adds (`off` true) or removes the issue's `autopilot-off` label.
// Turning Autopilot off for the item needs only the login; handing the gates
// back needs the gate PIN, prompted for like any gate action — a cancelled
// prompt rejects with Error('pin_needed') and sends nothing. Rejects with the
// server's error code otherwise; on success the answer's item is applied.
export async function setAutopilotOff(id, off) {
  const path = `/items/${encodeURIComponent(id)}/autopilot-off`
  const data = off ? await postJson(path, { off: true }) : await gateAction(path, { off: false })
  if (data.item) applyActionItem(data.item)
  return data
}

// HZ-407: the Execute card's Stop run and Resume, behind the same login as
// Pause. postJson so a 409 rejects and the card can say why. Stop's answer
// carries the paused item, applied at once; the job's own view (command 2
// `stopped`) arrives on the item's stream.
export async function stopJob(id) {
  const data = await postJson(`/items/${id}/job/stop`, {})
  if (data.item) applyActionItem(data.item)
  return data
}

export function resumeJob(id) {
  return postJson(`/items/${id}/job/resume`, {})
}

// HZ-310: drops one edge. postJson (not the fire-and-forget post) so a 404 or
// 409 rejects and the item view keeps the edge shown with the error. The
// server logs the event, broadcasts the snapshot and re-kicks the item.
export function removeDependency(id, dependsOnId) {
  return postJson(`/items/${id}/dependencies/remove`, { dependsOnId })
}

// HZ-365: the rule-block banner's Add dependency, on HZ-346's route. postJson
// so a 404 or 409 rejects and the dialog shows it.
export function addDependency(id, dependsOnId) {
  return postJson(`/items/${id}/dependencies`, { dependsOnId })
}

// HZ-470: awaited through gateAction, so the dialog that sent it can show a
// failure instead of closing on it.
export async function restartPhase(id, phase, reason) {
  return gateAction(`/items/${id}/phases/${phase}/restart`, { reason: reason || '' })
}

// Soft delete (HZ-59) — same gate PIN as approve/reject, reused via gatePost.
// HZ-354: removeDependentLinks also drops every link where this item is the
// blocker, in the same request. HZ-470: awaited, like restartPhase.
export async function abandonItem(id, reason, { removeDependentLinks = false } = {}) {
  return gateAction(`/items/${id}/abandon`, { reason: reason || '', removeDependentLinks })
}

// Personas are agent-scoped (HZ-125): one slot per composing agent, so the
// agent travels with the id and the server merges rather than replaces.
export function setPersona(id, agent, persona) {
  return post(`/items/${id}/persona`, { agent, persona })
}

// HZ-357: the "Runs on" choice for one step ('default' | 'claude' | 'muse').
// Rejects with the server's error code (provider_not_eligible, closed, …) so
// the picker can say why; the saved choice comes back on the board stream.
// HZ-370: a project's default "Runs on" for one step; PIN-gated like
// setProjectAutopilot, so a 401 carries its status for the Admin message.
export async function setProjectStepProvider(projectId, stepIndex, provider, pin) {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/step-providers/${stepIndex}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-human-key': pin },
    body: JSON.stringify({ provider }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

export function setStepProvider(id, stepIndex, provider) {
  return putJson(`/items/${id}/steps/${stepIndex}/provider`, { provider })
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

// HZ-327: flaky tests per repo, newest first — read-only.
export function getCheckFlakes() {
  return getJson('/admin/check-flakes')
}

// HZ-549: Admin's Productivity report, read-only. The response follows
// domain/productivity.schema.json; cost and token fields are null when not
// captured, never 0.
export function getProductivity({ range = '14d', project = 'all' } = {}) {
  const qs = new URLSearchParams({ range, project })
  return getJson(`/admin/productivity?${qs}`)
}

// HZ-563: Farm health — admins only, read-only. Rejects with the server's
// error code: admin_required (403), farm_health_warming (503) before the
// server's first reading, or HTTP <status>.
export function getFarmHealth() {
  return getJson('/admin/farm-health')
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

// The one wording for a credential_pattern refusal, so a definitions save, a
// rules save and a project definitions save (HZ-542) all say the same thing.
export function credentialMessage(matches) {
  return `Looks like a credential — move it to an $ENV_VAR reference (${matches.join(', ')})`
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
    if (data.error === 'credential_pattern') throw new Error(credentialMessage(data.matches))
    if (data.error === 'rules_too_large') throw new Error(`Too large — the per-file cap is ${data.limit} bytes`)
    if (data.error === 'git_dirty') throw new Error('The server checkout has unrelated staged changes — resolve them first')
    if (data.error === 'push_failed') throw new Error(`Committed locally but the push failed — the edit is not on origin yet (${data.commit})`)
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data
}

// HZ-542: a project's personas.json or steps.json, saved as one git commit
// under farm/projects/<slug>/. Same gate PIN handling and the same refusal
// wording as saveDefinition; an anchor or tool refusal carries the server's
// own message, which names it.
export async function saveProjectDefinition(slug, file, content) {
  const res = await gatePost(
    `/projects/${encodeURIComponent(slug)}/definitions/${encodeURIComponent(file)}`,
    { content },
    'PUT',
  )
  if (!res) throw new Error('Could not reach the server')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (data.error === 'credential_pattern') throw new Error(credentialMessage(data.matches))
    if (data.error === 'definitions_too_large') throw new Error(`Too large — the per-file cap is ${data.limit} bytes`)
    if (data.error === 'invalid_definitions') throw new Error(`Not a valid ${file}: ${data.detail}`)
    if (data.error === 'git_dirty') throw new Error('The server checkout has unrelated staged changes — resolve them first')
    if (data.error === 'push_failed') throw new Error(`Committed locally but the push failed — the edit is not on origin yet (${data.commit})`)
    throw new Error(data.message || data.error || `HTTP ${res.status}`)
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
    if (data.error === 'credential_pattern') message = credentialMessage(data.matches)
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
