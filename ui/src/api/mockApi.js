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
//   POST /items/:id/pause                      → togglePause(id)
//   POST /items/:id/phases/:phase/restart      → restartPhase(id, phase, reason)
//   POST /items/:id/feedback                   → sendFeedback(id, target, message)

import { STEPS, PHASES, isClosed } from '../domain/lifecycle'

const SEED_ITEMS = [
  { id: 'BF-145', title: 'Risk-limit breach dashboard', priority: 'Low', cursor: 1, issue: 412, desc: 'Give risk managers a live view of limit utilization across every desk.', metric: 'Limit breaches acknowledged in < 2 min (from 14 min).', guardrails: 'Read-only — no position mutation. No PII in telemetry.' },
  { id: 'BF-128', title: 'Real-time P&L attribution service', priority: 'High', cursor: 3, issue: 398, desc: 'Attribute intraday P&L to factors, trades and fees in real time.', metric: 'Attribution available < 5s after fill; 99.9% coverage.', guardrails: 'No client identifiers in logs. Must reconcile to EOD books.' },
  { id: 'BF-131', title: 'Margin-call alerting v2', priority: 'High', cursor: 5, issue: 401, desc: 'Replace batch margin alerts with streaming, tiered escalation.', metric: 'False-positive rate < 3%; median alert latency < 10s.', guardrails: 'Cannot auto-liquidate. Human in the loop for every call.' },
  { id: 'BF-119', title: 'Order-router latency fix', priority: 'Critical', cursor: 7, issue: 377, desc: 'Cut tail latency in the smart order router under burst load.', metric: 'p99 routing latency < 800µs at 5× peak volume.', guardrails: 'No change to fill-priority logic. Zero-downtime rollout.' },
  { id: 'BF-140', title: 'Backtesting data-lake migration', priority: 'Medium', cursor: 9, issue: 405, desc: 'Move backtest datasets onto the new lakehouse with full lineage.', metric: 'Backtest run cost −40%; lineage on every dataset.', guardrails: 'Dual-write during cutover. No silent schema drift.' },
  { id: 'BF-102', title: 'FIX gateway refactor', priority: 'High', cursor: 11, issue: 366, desc: 'Modularize the FIX gateway and isolate venue adapters.', metric: 'New-venue onboarding < 2 days (from 3 weeks).', guardrails: 'Wire-compatible. Conformance suite stays green.' },
  { id: 'BF-097', title: 'Compliance audit export', priority: 'Medium', cursor: 12, issue: 352, desc: 'One-click immutable export of the full audit trail for regulators.', metric: 'Export any quarter in < 60s; tamper-evident hashes.', guardrails: 'Immutable store only. Every access is logged.' },
  { id: 'BF-090', title: 'Trader-console dark mode', priority: 'Low', cursor: 14, issue: 331, desc: 'Ship an accessible dark theme for the trader console.', metric: 'WCAG AA on all surfaces; opt-in persistence.', guardrails: 'No layout regressions in light mode.' },
]

export const REPO_URL = 'https://github.com/FinTekkers/horizon'

export function issueUrl(item) {
  return `${REPO_URL}/issues/${item.issue}`
}

export function issueLabel(item) {
  return `#${item.issue}`
}

// ---- store ----

let items = SEED_ITEMS.map((it) => ({ ...it, paused: false, rejected: false, events: [] }))
const listeners = new Set()
const timers = {}

function emit() {
  listeners.forEach((fn) => fn())
}

function update(id, fn) {
  items = items.map((it) => (it.id === id ? fn(it) : it))
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

// GitHub sync is a server feature; the mock reports "unavailable" so the UI
// hides the connect affordances.
export function getSync() {
  return null
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

export async function activateProject() {
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

let localSeq = 0

export async function createItem({ title, outcome, metric, guardrails, priority = 'Medium' }) {
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
      paused: false,
      rejected: false,
      events: [{ who: 'You', text: 'created this work item', color: '#5E4380', initials: 'YOU' }],
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

export function approveGate(id) {
  const it = items.find((x) => x.id === id)
  if (!it || isClosed(it) || STEPS[it.cursor].kind !== 'gate') return
  update(id, (x) => ({ ...x, cursor: x.cursor + 1, rejected: false }))
  runAgents(id)
}

// Mirrors the server's rework loop: rejection rolls back to the responsible
// agent step and re-runs it instead of freezing the item.
export function requestChanges(id, target, feedback) {
  const it = items.find((x) => x.id === id)
  if (!it || isClosed(it)) return
  clearTimeout(timers[id])
  let reworkIdx = it.cursor
  if (STEPS[reworkIdx]?.kind === 'gate') {
    while (reworkIdx > 0 && STEPS[reworkIdx].kind !== 'agent') reworkIdx--
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

export function togglePause(id) {
  const it = items.find((x) => x.id === id)
  if (!it) return
  const paused = !it.paused
  update(id, (x) => ({ ...x, paused }))
  pushEvent(id, {
    who: 'You',
    text: paused ? 'paused agent work on this item' : 'resumed work',
    color: '#5E4380',
    initials: 'YOU',
  })
  if (paused) clearTimeout(timers[id])
  else runAgents(id)
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

