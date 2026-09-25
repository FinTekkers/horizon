// Explains why a paused item is paused (HZ-94). There is no structured
// pause-reason field anywhere in the API — a paused run is `status =
// 'cancelled'`, invisible to both `item.activeRun` (status = 'active' only)
// and `item.stepOutputs` (status = 'done' only). The only surviving signal
// is the free-text pause event server/src/orchestrator.js's failFarmRun()
// already writes into `item.events` (newest first). This module is the only
// place that parses it.

// Mirrors AUTO_RETRY_REASONS in server/src/orchestrator.js by hand — that
// set can't be imported into the UI bundle. A 5th reason added there without
// a matching entry here just degrades to raw-cause text below, not a crash.
const CATEGORY_COPY = {
  never_picked_up: { label: 'Never picked up', detail: 'The farm never claimed this step before its queue watchdog fired.' },
  timeout: { label: 'Timed out', detail: 'The step started but the farm never reported it finishing in time.' },
  unreachable: { label: 'Farm unreachable', detail: 'Horizon could not reach the farm to dispatch or check on this step.' },
  turn_cap: { label: 'Ran out of turns', detail: 'The agent hit its turn budget before finishing the step.' },
}

const MANUAL_PAUSE_TEXT = 'paused agent work on this item'

// Matches failFarmRun's pause-event text exactly (both the exhausted-budget
// and plain-pause branches); the reason tag is absent whenever no reason was
// classified, per the frozen wording HZ-94 must not change.
const PAUSE_EVENT_RE =
  /^agent step failed(?: \(([^)]+)\))?: (.+?) — (?:auto-retry budget \((\d+)\) exhausted; item paused, resume to retry|item paused; resume to retry)$/

// Matches the intermediate auto-retry event failFarmRun writes just before a
// retry dispatch — used only to count attempts already used, never rendered.
const RETRY_EVENT_RE = /^transient failure \([^)]+\): .+ — auto-retrying \(\d+\/\d+\)$/

// Returns null when the item isn't paused, or a structured explanation:
// { category, label, cause, exhausted, attemptsUsed } for a failure pause;
// { category: 'manual' } for a human-initiated pause (nothing to explain —
// not a failure); or a category: null fallback that still carries a
// non-blank message when the paused item's newest event matches neither
// shape (legacy/corrupted data).
export function pauseReason(item) {
  if (!item?.paused) return null

  const events = item.events || []
  const latest = events[0]

  if (!latest) {
    return { category: null, label: null, cause: null, exhausted: false, attemptsUsed: 0 }
  }

  if (latest.text === MANUAL_PAUSE_TEXT) {
    return { category: 'manual', label: null, cause: null, exhausted: false, attemptsUsed: 0 }
  }

  const match = (latest.text || '').match(PAUSE_EVENT_RE)
  if (!match) {
    return { category: null, label: null, cause: null, exhausted: false, attemptsUsed: 0 }
  }

  const [, reason, cause, cap] = match
  const known = reason != null ? CATEGORY_COPY[reason] : null

  let attemptsUsed = 0
  for (let i = 1; i < events.length && RETRY_EVENT_RE.test(events[i]?.text || ''); i++) attemptsUsed++

  return {
    category: reason || null,
    label: known ? known.label : null,
    detail: known ? known.detail : null,
    cause,
    exhausted: cap != null,
    attemptsUsed,
  }
}
