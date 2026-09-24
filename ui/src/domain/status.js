// Shared status presentation for a work item (board card + tracker header).

import { AGENTS, isClosed, curStep, awaitingGate, IMPLEMENT_STEP_INDEX } from './lifecycle'

// HZ-33: the word "Paused" must never be the sole explanation anywhere in the
// UI — every paused chip names WHY, even a plain human pause.
const CATEGORY_SHORT = { infra: 'infra', turn_cap: 'turn-cap', checks_failed: 'checks failed' }
const CATEGORY_LABEL = { infra: 'Infrastructure error', turn_cap: 'Turn/time budget exhausted', checks_failed: 'Checks failed' }

function pendingRetry(item) {
  if (item.paused || !item.nextRetryAt) return false
  return Date.parse(item.nextRetryAt) > Date.now()
}

function pausedLabel(item) {
  if (!item.failureCategory) return 'Paused — by you'
  const short = CATEGORY_SHORT[item.failureCategory] || item.failureCategory
  return `Paused — ${short}`
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
  if (paused) return { label: pausedLabel(item), color: 'var(--muted-strong)', bg: 'var(--chip)' }
  if (!closed && !rejected && pendingRetry(item)) {
    return { label: verbose ? 'Auto-retrying shortly' : 'Retrying', color: 'var(--warning-ink)', bg: 'var(--warning-bg)' }
  }
  if (awaiting) {
    return { label: verbose ? 'Awaiting your approval' : 'Awaiting you', color: 'var(--warning-ink)', bg: 'var(--warning-bg)' }
  }
  const agent = AGENTS[cur.agent]
  return { label: verbose ? `${agent.label} working` : agent.label, color: 'var(--primary-ink)', bg: 'var(--primary-bg)' }
}

// Full detail for the tracker banner (HZ-33 success metric): category, cause,
// attempts used, checkpoint state, and next action — never just "Paused".
// null when the item isn't paused from a classified failure (e.g. a plain
// human pause, which the status chip above already names distinctly).
export function failureBanner(item) {
  if (!item.paused || !item.failureCategory) return null
  const { failureCategory: category, failureCause: cause, retryCount: attempts, retryBudget: budget } = item
  const retryable = category !== 'checks_failed'

  const checkpoint =
    category === 'turn_cap' && item.cursor === IMPLEMENT_STEP_INDEX
      ? 'Checkpoint: the in-progress work was committed and pushed — the next attempt resumes it instead of restarting.'
      : category === 'checks_failed'
        ? 'Checkpoint: none needed — the branch is unchanged; fix the cause, then resume.'
        : 'Checkpoint: none for this step — a resumed attempt starts fresh.'

  const nextAction = retryable
    ? `Next action: auto-retry budget (${budget}) is exhausted after ${attempts} attempt(s) — resume manually once you've addressed the cause.`
    : "Next action: review the cause below, fix it (or leave feedback for the agent), then resume — this category never auto-retries."

  return {
    category,
    categoryLabel: CATEGORY_LABEL[category] || category,
    cause,
    attempts,
    budget,
    retryable,
    checkpoint,
    nextAction,
  }
}

// Header note for a step currently sitting in auto-retry backoff (not yet
// paused) — makes the "avoid" half of HZ-33 visible, not just the feed event.
export function retryPendingInfo(item) {
  if (!pendingRetry(item)) return null
  return {
    category: item.failureCategory,
    categoryLabel: CATEGORY_LABEL[item.failureCategory] || item.failureCategory,
    cause: item.failureCause,
    attempts: item.retryCount,
    budget: item.retryBudget,
    nextRetryAt: item.nextRetryAt,
  }
}
