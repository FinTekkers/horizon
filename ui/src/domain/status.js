// Shared status presentation for a work item (board card + tracker header).

import { AGENTS, isClosed, curStep, awaitingGate } from './lifecycle'

// verbose=true gives the tracker-header phrasing; false gives the compact card one.
export function itemStatus(item, verbose = false) {
  const closed = isClosed(item)
  const rejected = item.rejected && !closed
  const paused = !!item.paused && !closed && !rejected
  const awaiting = awaitingGate(item)
  const cur = curStep(item)

  if (closed) return { label: 'Closed', color: '#0E6E74', bg: '#E2F0F0' }
  if (rejected) return { label: 'Changes requested', color: '#9C333E', bg: '#F6E2E4' }
  if (paused) return { label: 'Paused', color: '#6E6A7E', bg: '#EAE6F1' }
  if (awaiting) {
    return { label: verbose ? 'Awaiting your approval' : 'Awaiting you', color: '#9A6E00', bg: '#FAF0D6' }
  }
  const agent = AGENTS[cur.agent]
  return { label: verbose ? `${agent.label} working` : agent.label, color: '#2E6CB2', bg: '#EAF1F9' }
}
