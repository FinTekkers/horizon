// Shared status presentation for a work item (board card + tracker header).

import { AGENTS, isClosed, curStep, awaitingGate } from './lifecycle'

// A dispatched step whose run the farm currently reports as queued rather
// than running (HZ-54) — distinct from a step merely "not yet reached"
// (stepStatus's 'pending'). item.activeRun.state defaults to 'running' at
// the data layer (store.js) whenever the farm is mock/unreachable/silent on
// the field, so this only ever fires on a real, current signal.
export function isQueued(item) {
  return !!item.activeRun && item.activeRun.step_index === item.cursor && item.activeRun.state === 'queued'
}

// verbose=true gives the tracker-header phrasing; false gives the compact card one.
export function itemStatus(item, verbose = false) {
  const closed = isClosed(item)
  const rejected = item.rejected && !closed
  const paused = !!item.paused && !closed && !rejected
  const awaiting = awaitingGate(item)
  const cur = curStep(item)

  if (closed) return { label: 'Closed', color: 'var(--success-ink)', bg: 'var(--success-bg)' }
  if (rejected) return { label: 'Changes requested', color: 'var(--danger-ink)', bg: 'var(--danger-bg)' }
  if (paused) return { label: 'Paused', color: 'var(--muted-strong)', bg: 'var(--chip)' }
  if (awaiting) {
    return { label: verbose ? 'Awaiting your approval' : 'Awaiting you', color: 'var(--warning-ink)', bg: 'var(--warning-bg)' }
  }
  if (isQueued(item)) {
    return { label: 'Queued', color: '#8C8C8E', bg: '#EDEDEF', reason: item.activeRun.reason || undefined }
  }
  const agent = AGENTS[cur.agent]
  return { label: verbose ? `${agent.label} working` : agent.label, color: 'var(--primary-ink)', bg: 'var(--primary-bg)' }
}
