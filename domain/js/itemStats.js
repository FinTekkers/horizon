// HZ-921: an item's Effort & cost summary, as both of its readers show it.
// statsVisible is when it is shown — at its kind's last step ("Review the work
// & close", or a kind's own Review & close gate) and on every closed or
// abandoned item: the one rule for GET /api/items/:id/stats (server/src/app.js)
// and the item page (ui/src/components/Tracker.jsx). The formatters are the
// one wording of its figures, for the page (EffortCostCard.jsx) and the stats
// comment's summary line (server/src/statsComment.js), so both read the same.
// JS-only on purpose: the farm never reads the summary.

import { endIndex, isAbandoned, isClosed, itemKindOf } from './lifecycle.js'

export function statsVisible(item) {
  if (item == null || !Number.isInteger(item.cursor)) return false
  if (isAbandoned(item) || isClosed(item)) return true
  return item.cursor === endIndex(itemKindOf(item)) - 1
}

// ---- the figures, in words ----

export function formatCost(cost) {
  return cost == null ? 'cost not recorded' : `$${cost.toFixed(2)}`
}

export function formatTokens(tokens) {
  if (tokens == null) return 'tokens not recorded'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M tokens`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K tokens`
  return `${tokens} tokens`
}

export function formatTurns(turns) {
  return turns == null ? 'turns not recorded' : `${turns} turn${turns === 1 ? '' : 's'}`
}

export function formatDuration(ms) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'under 1m'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

export function formatClarification(clarification) {
  if (clarification.none) return 'No clarification needed'
  return `${clarification.total} clarification${clarification.total === 1 ? '' : 's'}`
}

// Cost · implement tokens and turns · elapsed · clarifications.
export function statsSummaryLine(stats) {
  const impl = stats.implementation
  const implement = impl ? `implement ${formatTokens(impl.tokens)}, ${formatTurns(impl.turns)}` : 'no implement step'
  return [
    `Cost ${formatCost(stats.totals.cost_usd)}`,
    implement,
    `elapsed ${formatDuration(stats.time.elapsed_ms)}`,
    formatClarification(stats.clarification),
  ].join(' · ')
}
