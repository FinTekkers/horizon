// Mock data layer for the Lifecycle Tracker.
//
// This module is the seam for the real backend: it exposes the same operations
// as the suggested API in ui/design-system/HANDOFF.md. To go live, replace the
// in-memory mutations with fetch calls and drive updates from a poll/websocket
// instead of the runAgents() timer simulation. Components only ever consume
// { subscribe, getItems } + the action functions, so nothing else changes.
//
//   GET  /items                                → getItems()
//   POST /items/:id/gates/:stepIndex/approve   → approveGate(id)
//   POST /items/:id/reject                     → requestChanges(id, target, feedback)
//   POST /items/:id/pause                      → setPaused(id, paused)
//   POST /items/:id/phases/:phase/restart      → restartPhase(id, phase, reason)
//   POST /items/:id/feedback                   → sendFeedback(id, target, message)

import { STEPS, PHASES, isClosed, ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } from '../../../domain/js/lifecycle.js'
import { DEFAULT_PRIORITY } from '../../../domain/js/priorities.js'
import { PERSONAS, isPersona } from '../domain/personas'

const SEED_ITEMS = [
  { id: 'BF-145', title: 'Risk-limit breach dashboard', priority: 'Low', cursor: 1, issue: 412, desc: 'Give risk managers a live view of limit utilization across every desk.', metric: 'Limit breaches acknowledged in < 2 min (from 14 min).', guardrails: 'Read-only — no position mutation. No PII in telemetry.' },
  { id: 'BF-128', title: 'Real-time P&L attribution service', priority: 'High', cursor: 3, issue: 398, desc: 'Attribute intraday P&L to factors, trades and fees in real time.', metric: 'Attribution available < 5s after fill; 99.9% coverage.', guardrails: 'No client identifiers in logs. Must reconcile to EOD books.', dependents: [{ id: 'BF-131', title: 'Margin-call alerting v2', abandoned: false }] },
  { id: 'BF-131', title: 'Margin-call alerting v2', priority: 'High', cursor: 5, issue: 401, desc: 'Replace batch margin alerts with streaming, tiered escalation.', metric: 'False-positive rate < 3%; median alert latency < 10s.', guardrails: 'Cannot auto-liquidate. Human in the loop for every call.', blocked: true, blockedBy: [{ id: 'BF-128', title: 'Real-time P&L attribution service', abandoned: false }], dependents: [{ id: 'BF-140', title: 'Backtesting data-lake migration', abandoned: false }] },
  { id: 'BF-119', title: 'Order-router latency fix', priority: 'Critical', cursor: 7, issue: 377, desc: 'Cut tail latency in the smart order router under burst load.', metric: 'p99 routing latency < 800µs at 5× peak volume.', guardrails: 'No change to fill-priority logic. Zero-downtime rollout.' },
  { id: 'BF-140', title: 'Backtesting data-lake migration', priority: 'Medium', cursor: 10, issue: 405, desc: 'Move backtest datasets onto the new lakehouse with full lineage.', metric: 'Backtest run cost −40%; lineage on every dataset.', guardrails: 'Dual-write during cutover. No silent schema drift.', blocked: true, blockedBy: [{ id: 'BF-131', title: 'Margin-call alerting v2', abandoned: false }] },
  { id: 'BF-102', title: 'FIX gateway refactor', priority: 'High', cursor: 12, issue: 366, desc: 'Modularize the FIX gateway and isolate venue adapters.', metric: 'New-venue onboarding < 2 days (from 3 weeks).', guardrails: 'Wire-compatible. Conformance suite stays green.' },
  { id: 'BF-097', title: 'Compliance audit export', priority: 'Medium', cursor: 13, issue: 352, desc: 'One-click immutable export of the full audit trail for regulators.', metric: 'Export any quarter in < 60s; tamper-evident hashes.', guardrails: 'Immutable store only. Every access is logged.' },
  { id: 'BF-090', title: 'Trader-console dark mode', priority: 'Low', cursor: 15, issue: 331, desc: 'Ship an accessible dark theme for the trader console.', metric: 'WCAG AA on all surfaces; opt-in persistence.', guardrails: 'No layout regressions in light mode.' },
]

export const REPO_URL = 'https://github.com/FinTekkers/horizon'

export function artifactUrl() {
  return '#'
}

export function outputUrl() {
  return '#'
}

export function runLogViewUrl() {
  return '#'
}

export function issueUrl(item) {
  return `${REPO_URL}/issues/${item.issue}`
}

export function issueLabel(item) {
  return `#${item.issue}`
}

// ---- store ----

// last_activity_at mirrors the server's store.js: every SEED_ITEMS row starts
// "just touched" so mock mode's stale filter (HZ-80) doesn't diverge from a
// fresh server-backed board.
let items = SEED_ITEMS.map((it) => ({
  blocked: false,
  blockedByAbandoned: false,
  blockedBy: [],
  dependents: [],
  ...it,
  paused: false,
  rejected: false,
  events: [],
  last_activity_at: new Date().toISOString(),
}))
const listeners = new Set()
const timers = {}

function emit() {
  listeners.forEach((fn) => fn())
}

// Every mutation re-stamps last_activity_at — the mock mirror of the
// server's `touch` const in store.js, which every UPDATE statement includes.
function update(id, fn) {
  items = items.map((it) => (it.id === id ? { ...fn(it), last_activity_at: new Date().toISOString() } : it))
  emit()
}

function pushEvent(id, event) {
  update(id, (it) => ({ ...it, events: [event, ...it.events] }))
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getItems() {
  return items
}

// HZ-318's per-item step outputs stream. Mock items carry no recorded outputs.
export function subscribeStepOutputs(id, onOutputs) {
  const timer = setTimeout(() => onOutputs(items.find((it) => it.id === id)?.stepOutputs ?? {}), 0)
  return () => clearTimeout(timer)
}

// GitHub sync is a server feature; the mock reports "unavailable" so the UI
// hides the connect affordances.
export function getSync() {
  return null
}

// ---- auth (HZ-21) ----
// Mock mode (VITE_MOCK=1) skips the login screen entirely — a fixed demo
// user is "already logged in", same as before this ticket's TopBar showed a
// literal "AP".

const MOCK_USER = { id: 'mock-user', email: 'demo@example.com', name: 'Alex Porter', initials: 'AP', authMethod: 'password' }

export async function getCurrentUser() {
  return MOCK_USER
}

export async function login() {
  return { ok: true, user: MOCK_USER }
}

export async function logout() {
  return { ok: true }
}

export function googleLoginUrl() {
  return '#'
}

export async function regenerateGatePin() {
  return { ok: true, pin: '000000' }
}

// ---- personal API tokens (HZ-179) ----
// In-memory only; the mock raw token is a fixed-shape placeholder.

let mockApiTokens = []
let mockApiTokenSeq = 0

export async function listApiTokens() {
  return { tokens: mockApiTokens.map((t) => ({ ...t })) }
}

export async function createApiToken({ name, expiresInDays = 90 }) {
  const token = `hz_mock${String(Date.now()).padStart(40, '0')}`
  const createdAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
  mockApiTokenSeq += 1
  const entry = { id: `tok_mock_${mockApiTokenSeq}`, name, last4: token.slice(-4), createdAt, lastUsedAt: null, expiresAt }
  mockApiTokens = [entry, ...mockApiTokens]
  return { ...entry, token }
}

export async function revokeApiToken(id) {
  mockApiTokens = mockApiTokens.filter((t) => t.id !== id)
  return { ok: true }
}

export function getProjects() {
  return []
}

export function getActiveProjectId() {
  return null
}

export function getFarm() {
  return { status: 'running' }
}

// No history in mock mode: cards show elapsed time only.
export function getDurationEstimates() {
  return null
}

// No self-deploys in mock mode (HZ-360).
export function getDeployBlock() {
  return null
}

export async function setProjectEnabled() {
  throw new Error('Projects are not available in mock mode')
}

export async function setProjectAutopilot() {
  throw new Error('Projects are not available in mock mode')
}

// Mirrors store.setProjectStepProvider's eligibility rule, read from
// domain/steps.json; projects themselves need the server.
export async function setProjectStepProvider(projectId, stepIndex) {
  if (STEPS[stepIndex]?.kind !== 'agent' || !STEPS[stepIndex].providerOverrideEligible) {
    throw new Error('provider_not_eligible')
  }
  throw new Error('Projects are not available in mock mode')
}

export async function saveToken() {
  throw new Error('GitHub sync is not available in mock mode')
}

export async function createProject() {
  throw new Error('Projects are not available in mock mode')
}

export async function addRepoToProject() {
  throw new Error('Projects are not available in mock mode')
}

export async function disconnectRepo() {
  throw new Error('Projects are not available in mock mode')
}

export async function saveRepoChecks() {
  throw new Error('Projects are not available in mock mode')
}

export async function saveRepoMarks() {
  throw new Error('Projects are not available in mock mode')
}

export async function getRepoCheckDefaults() {
  return { available: false, defaults: { install: null, test: null, lint: null, e2e: null } }
}

export async function getRepoWebhooks() {
  throw new Error('Projects are not available in mock mode')
}

export async function fixRepoWebhook() {
  throw new Error('Projects are not available in mock mode')
}

let localSeq = 0

// The default mirrors POST /api/items' (HZ-135) rather than restating it, so the
// offline mock cannot start answering differently from the real route.
export async function createItem({ title, outcome, metric, guardrails, priority = DEFAULT_PRIORITY }) {
  const id = `LOC-${++localSeq}`
  items = [
    {
      id,
      title,
      priority,
      cursor: 0,
      issue: null,
      desc: outcome,
      metric,
      guardrails: guardrails || '',
      blocked: false,
      blockedByAbandoned: false,
      blockedBy: [],
      dependents: [],
      paused: false,
      rejected: false,
      events: [{ who: 'You', text: 'created this work item', color: '#5E4380', initials: 'YOU' }],
      last_activity_at: new Date().toISOString(),
    },
    ...items,
  ]
  emit()
  runAgents(id)
  return { ok: true, id }
}

// ---- agent simulation (mock only — replaced by real agent progress later) ----

const AGENT_STEP_MS = 1150

function runAgents(id) {
  const it = items.find((x) => x.id === id)
  if (!it || isClosed(it) || it.paused || it.rejected) return
  if (STEPS[it.cursor].kind !== 'agent') return
  clearTimeout(timers[id])
  timers[id] = setTimeout(() => {
    const cur = items.find((x) => x.id === id)
    if (cur && !isClosed(cur) && !cur.paused && !cur.rejected && STEPS[cur.cursor].kind === 'agent') {
      update(id, (x) => ({ ...x, cursor: x.cursor + 1 }))
      runAgents(id)
    }
  }, AGENT_STEP_MS)
}

// ---- actions ----

export async function approveGate(id, notes) {
  const it = items.find((x) => x.id === id)
  if (!it || isClosed(it) || STEPS[it.cursor].kind !== 'gate') return { ok: false }
  const label = STEPS[it.cursor].label.toLowerCase()
  update(id, (x) => ({ ...x, cursor: x.cursor + 1, rejected: false }))
  if (notes) {
    pushEvent(id, { who: 'You', text: `approved: ${label} — ${notes}`, color: '#5E4380', initials: '✓' })
  }
  runAgents(id)
  const updated = items.find((x) => x.id === id)
  return { ok: true, closed: isClosed(updated) }
}

// Mirrors the server's rework loop: rejection rolls back to the responsible
// agent step and re-runs it instead of freezing the item. targetStepIndex
// (HZ-51) lets a human pick an earlier agent step explicitly, same
// validation and Accept-gate exception as store.js's requestChanges.
export function requestChanges(id, target, feedback, targetStepIndex) {
  const it = items.find((x) => x.id === id)
  if (!it || isClosed(it)) return
  const atGate = STEPS[it.cursor]?.kind === 'gate'
  if (targetStepIndex != null) {
    const validTarget =
      atGate &&
      Number.isInteger(targetStepIndex) &&
      targetStepIndex >= 0 &&
      targetStepIndex < it.cursor &&
      STEPS[targetStepIndex]?.kind === 'agent'
    if (!validTarget) return
  }
  clearTimeout(timers[id])
  let reworkIdx = it.cursor
  if (atGate) {
    if (targetStepIndex != null) {
      reworkIdx = targetStepIndex
    } else if (reworkIdx === ACCEPT_GATE_INDEX) {
      reworkIdx = IMPLEMENT_STEP_INDEX
    } else {
      while (reworkIdx > 0 && STEPS[reworkIdx].kind !== 'agent') reworkIdx--
    }
  }
  const reworkLabel = STEPS[reworkIdx].label.toLowerCase()
  update(id, (x) => ({ ...x, cursor: reworkIdx, rejected: false, paused: false }))
  pushEvent(id, {
    who: 'You',
    text: `requested changes on ${target || 'this step'}${feedback ? ': ' + feedback : ''} — sent back to the ${reworkLabel} step`,
    color: '#9C333E',
    initials: 'YOU',
  })
  runAgents(id)
}

// HZ-92: mock mode never sets pr_mergeable === false (no real GitHub PR to
// check), so the "resolve conflicts" button never renders here — this stub
// exists only for interface parity with serverApi.js.
export async function resolveConflicts(id) {
  const it = items.find((x) => x.id === id)
  if (!it) return { ok: false, error: 'not_found' }
  return { ok: true, resolved: true }
}

// HZ-185: mock mode's review never rejects (no `reviewRejected` item), so the
// "Forward to Accept the code" button never renders here — this stub exists
// only for interface parity with serverApi.js.
export async function forwardToAccept(id) {
  const it = items.find((x) => x.id === id)
  if (!it) return { ok: false, error: 'not_found' }
  return { error: 'review_not_rejected' }
}

// Mirrors serverApi.setPaused: the explicit state, {ok, paused} back, and a
// rejection the button can show.
export async function setPaused(id, paused) {
  const it = items.find((x) => x.id === id)
  if (!it) throw new Error('not_found')
  update(id, (x) => ({ ...x, paused }))
  pushEvent(id, {
    who: 'You',
    text: paused ? 'paused agent work on this item' : 'resumed work',
    color: '#5E4380',
    initials: 'YOU',
  })
  if (paused) clearTimeout(timers[id])
  else runAgents(id)
  return { ok: true, paused }
}

// Mirrors store.removeDependency: drop the edge on both sides, log it, and
// re-kick the item. Mock blockedBy already lists only open blockers, so the
// flags recompute from what remains.
export async function removeDependency(id, dependsOnId) {
  const it = items.find((x) => x.id === id)
  if (!it || !(it.blockedBy || []).some((b) => b.id === dependsOnId)) throw new Error('not_found')
  update(id, (x) => {
    const blockedBy = x.blockedBy.filter((b) => b.id !== dependsOnId)
    return { ...x, blockedBy, blocked: blockedBy.length > 0, blockedByAbandoned: blockedBy.some((b) => b.abandoned) }
  })
  update(dependsOnId, (x) => ({ ...x, dependents: (x.dependents || []).filter((d) => d.id !== id) }))
  pushEvent(id, { who: 'You', text: `removed the dependency on ${dependsOnId}`, color: '#5E4380', initials: 'YOU' })
  if (!items.find((x) => x.id === id).blocked) runAgents(id)
  return { ok: true }
}

// Mirrors store.addDependency: add the edge on both sides and log it. An
// open blocker holds the item; a closed one releases a rule block at once,
// as store.releaseRuleBlockIfSatisfied does.
export async function addDependency(id, dependsOnId) {
  const it = items.find((x) => x.id === id)
  const dep = items.find((x) => x.id === dependsOnId)
  if (!it || !dep) throw new Error('not_found')
  if (id === dependsOnId || (it.blockedBy || []).some((b) => b.id === dependsOnId)) throw new Error('conflict')
  if (isClosed(dep)) {
    update(id, (x) => ({ ...x, ruleBlock: null }))
  } else {
    const entry = { id: dep.id, title: dep.title, abandoned: !!dep.abandoned_at }
    update(id, (x) => ({ ...x, blockedBy: [...(x.blockedBy || []), entry], blocked: true }))
    update(dependsOnId, (x) => ({ ...x, dependents: [...(x.dependents || []), { id: it.id, title: it.title, abandoned: false }] }))
  }
  pushEvent(id, { who: 'You', text: `added a dependency on ${dependsOnId}`, color: '#5E4380', initials: 'YOU' })
  if (!items.find((x) => x.id === id).blocked) runAgents(id)
  return { ok: true }
}

export function setPersona(id, agent, persona) {
  if (!isPersona(agent, persona)) return
  update(id, (it) => ({ ...it, personas: { ...it.personas, [agent]: persona } }))
  pushEvent(id, {
    who: 'You',
    text: `set the ${agent} specialist persona to ${PERSONAS[agent][persona].label}`,
    color: '#5E4380',
    initials: 'YOU',
  })
}

// Mirrors store.setStepProvider: only a step domain/steps.json marks
// providerOverrideEligible takes a choice; 'default' clears it.
export async function setStepProvider(id, stepIndex, provider) {
  const it = items.find((x) => x.id === id)
  if (!it) throw new Error('not_found')
  if (STEPS[stepIndex]?.kind !== 'agent' || !STEPS[stepIndex].providerOverrideEligible) {
    throw new Error('provider_not_eligible')
  }
  const on = { default: 'the default provider', claude: 'Claude', muse: 'Muse' }
  if (!Object.hasOwn(on, provider)) throw new Error('bad_provider')
  update(id, (x) => {
    const providerChoices = { ...x.providerChoices }
    if (provider === 'default') delete providerChoices[stepIndex]
    else providerChoices[stepIndex] = provider
    return { ...x, providerChoices }
  })
  pushEvent(id, { who: 'You', text: `set ${STEPS[stepIndex].label} to run on ${on[provider]}`, color: '#5E4380', initials: 'YOU' })
  return { ok: true }
}

// ---- agent definitions (HZ-9) ----
// Demo mode shows the hierarchy read-only; edits need the server (each save
// is a git commit there).

const MOCK_DEFINITIONS = {
  global: [
    { kind: 'role', name: 'eng_implement', bytes: 1420 },
    { kind: 'role', name: 'qa', bytes: 980 },
    { kind: 'persona', name: 'eng_fullstack', bytes: 812 },
    { kind: 'persona', name: 'eng_python', bytes: 764 },
    { kind: 'persona', name: 'eng_ui', bytes: 790 },
    { kind: 'persona', name: 'eng_performance', bytes: 800 },
    { kind: 'persona', name: 'qa_api_contract', bytes: 1120 },
    { kind: 'persona', name: 'qa_e2e_journey', bytes: 1080 },
    { kind: 'persona', name: 'qa_data_integrity', bytes: 1060 },
    { kind: 'persona', name: 'architect_data_modelling', bytes: 1140 },
    { kind: 'persona', name: 'architect_distributed_systems', bytes: 1250 },
    { kind: 'persona', name: 'pm_roadmap', bytes: 1000 },
    { kind: 'persona', name: 'pm_feature_development', bytes: 1100 },
  ],
  projects: [{ kind: 'project', name: 'fintekkers', bytes: 1500 }],
  repos: [
    { kind: 'repo', name: 'FinTekkers__ui-service', bytes: 2100 },
    { kind: 'repo', name: 'FinTekkers__ledger-models', bytes: 1800 },
  ],
}

export async function listDefinitions() {
  return MOCK_DEFINITIONS
}

// ---- flaky tests (HZ-327, read-only) ----

export async function getCheckFlakes() {
  return { repos: [] }
}

// ---- deploy targets (HZ-41, read-only) ----

export async function getDeployTargets() {
  return {
    targets: [
      {
        key: 'horizon',
        repo: 'FinTekkers/horizon',
        service: 'horizon-server',
        lastTag: 'refs/tags/v42',
        lastCommit: 'abc1234',
        lastResult: 'ok',
        lastAt: '2026-09-14T03:22:10Z',
      },
      {
        key: 'ui-service',
        repo: 'FinTekkers/ui-service',
        service: 'fintekkers-ui',
        lastTag: null,
        lastCommit: null,
        lastResult: 'never',
        lastAt: null,
      },
    ],
  }
}

// HZ-258: canned Dry run — five checks, one failing, so the panel shows both.
export async function dryRunDeployTarget(key) {
  return {
    key,
    ranAt: new Date().toISOString(),
    results: [
      { check: 'script', pass: true, reason: 'script found in infra/host and executable' },
      { check: 'repo dir', pass: true, reason: 'git work tree, origin is FinTekkers/horizon' },
      { check: 'service', pass: true, reason: 'horizon-server, horizon-farm active' },
      { check: 'sudo', pass: false, reason: 'sudo would prompt or is denied (exit 1)' },
      { check: 'health', pass: true, reason: 'health responded 200, ok: true' },
    ],
  }
}

// ---- deploy target overrides (HZ-259) — in-memory, so VITE_MOCK=1 works ----

const mockDeployTargetConfig = [
  {
    key: 'horizon',
    repo: 'FinTekkers/horizon',
    script: 'deploy-horizon.sh',
    service: 'horizon-server',
    repoDir: '/opt/horizon',
    stateKey: 'horizon',
    healthUrl: 'http://127.0.0.1:3001/api/health',
    healthCheckType: 'json-health',
    extraServices: ['horizon-farm'],
  },
  {
    key: 'ui-service',
    repo: 'FinTekkers/ui-service',
    script: 'deploy-ui-service.sh',
    service: 'fintekkers-ui',
    repoDir: '/opt/fintekkers/ui-service',
    stateKey: 'ui-service',
    healthUrl: 'https://www.fintekkers.org/',
    healthCheckType: 'ssr-asset-check',
  },
]

export async function getDeployTargetConfig() {
  return { targets: mockDeployTargetConfig.map((t) => ({ ...t })) }
}

export async function createDeployTarget(target) {
  mockDeployTargetConfig.push({ ...target })
  return { ok: true, target: { ...target } }
}

export async function updateDeployTarget(key, fields) {
  const index = mockDeployTargetConfig.findIndex((t) => t.key === key)
  if (index < 0) throw Object.assign(new Error('deploy_target_not_found'), { status: 404, code: 'deploy_target_not_found' })
  mockDeployTargetConfig[index] = { key, ...fields }
  return { ok: true, target: { ...mockDeployTargetConfig[index] } }
}

export async function deleteDeployTarget(key) {
  const index = mockDeployTargetConfig.findIndex((t) => t.key === key)
  if (index >= 0) mockDeployTargetConfig.splice(index, 1)
  return { ok: true }
}

export async function getDefinition(kind, name) {
  const content = `# ${name}\n\nDemo content — connect the Horizon server to view and edit the real ${kind} definition.`
  return { kind, name, content, path: `farm/…/${name}.md`, bytes: content.length }
}

export async function saveDefinition() {
  throw new Error('Definitions are read-only in mock mode — run the server to edit them')
}

export async function effectivePrompt() {
  return { prompt: '(the effective-prompt preview requires the server)' }
}

// HZ-246: rules versions live in the server's DB — read-only here too.
export async function listRuleTargets() {
  const target = (scope) => (def) => ({
    scope,
    key: def.name,
    label: scope === 'repo' ? def.name.replace('__', '/') : def.name,
    file: true,
    versions: 0,
  })
  return { projects: MOCK_DEFINITIONS.projects.map(target('project')), repos: MOCK_DEFINITIONS.repos.map(target('repo')) }
}

export async function listRuleVersions(scope, key) {
  const { content, path } = await getDefinition(scope, key)
  return { scope, key, default: { exists: true, path, content }, served_version: null, versions: [] }
}

export async function saveRule() {
  throw new Error('Rules are read-only in mock mode — run the server to edit them')
}

export async function restoreRule() {
  throw new Error('Rules are read-only in mock mode — run the server to edit them')
}

export function restartPhase(id, phase, reason) {
  const firstIdx = STEPS.findIndex((st) => st.phase === phase)
  update(id, (x) => ({ ...x, cursor: firstIdx, rejected: false, paused: false }))
  pushEvent(id, {
    who: 'You',
    text: `restarted the ${PHASES[phase]} phase${reason ? ': ' + reason : ''}`,
    color: '#DFA200',
    initials: 'YOU',
  })
  runAgents(id)
}

// Soft delete (HZ-59) — mock mirror of store.abandonItem: stops dispatch by
// clearing the mock agent timer and setting abandoned_at. HZ-354:
// removeDependentLinks drops every edge where this item is the blocker, on
// both sides, with one event per dependent.
export function abandonItem(id, reason, { removeDependentLinks = false } = {}) {
  const it = items.find((x) => x.id === id)
  if (!it || isClosed(it) || it.abandoned_at) return
  clearTimeout(timers[id])
  const trimmed = (reason || '').trim()
  update(id, (x) => ({ ...x, abandoned_at: new Date().toISOString(), abandoned_reason: trimmed, abandoned_by: 'You' }))
  pushEvent(id, { who: 'You', text: `abandoned this item: ${trimmed}`, color: '#9C333E', initials: 'YOU' })
  if (!removeDependentLinks) return
  const dependentIds = (it.dependents || []).map((d) => d.id)
  update(id, (x) => ({ ...x, dependents: [] }))
  for (const depId of dependentIds) {
    if (!items.some((x) => x.id === depId)) continue
    update(depId, (x) => {
      const blockedBy = (x.blockedBy || []).filter((b) => b.id !== id)
      return { ...x, blockedBy, blocked: blockedBy.length > 0, blockedByAbandoned: blockedBy.some((b) => b.abandoned) }
    })
    pushEvent(depId, { who: 'You', text: `removed the dependency on ${id} (${it.title}): it was abandoned`, color: '#5E4380', initials: 'YOU' })
    const dep = items.find((x) => x.id === depId)
    if (!dep.blocked && !dep.abandoned_at) runAgents(depId)
  }
}

