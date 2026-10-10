// Explains why a paused item is paused (HZ-94). There is no structured
// pause-reason field anywhere in the API — a paused run is `status =
// 'cancelled'`, invisible to both `item.activeRun` (status = 'active' only)
// and `item.stepOutputs` (status = 'done' only). The only surviving signal
// is the free-text pause event server/src/orchestrator.js's failFarmRun()
// already writes into `item.events` (newest first). This module is the only
// place that parses it.
//
// HZ-343: the pause event is not always the newest event — a "forward to …
// refused" event (or anything else) can land on top of it — so the parser
// scans back from the newest event to the last `resumed work`, never past it.

// HZ-132: the reason IDS are no longer typed here. They are declared once in
// domain/reasons.json and reach this file through domain/js/reasons.js, which
// Rollup inlines into the bundle the same way it inlines the step table — so
// the keys below cannot drift from the tags server/src/orchestrator.js writes
// and farm/ emits. Only the COPY is owned here: labels and details are
// presentation, which domain/ deliberately does not hold.
//
// A reason declared in domain/reasons.json with no entry below is a bug, not a
// graceful degradation — ui/src/domain/pauseReason.test.js walks REASON_IDS and
// fails if any one of them resolves a null label.
import { REASON } from '../../../domain/js/reasons.js'

const CATEGORY_COPY = {
  [REASON.NEVER_PICKED_UP]: { label: 'Never picked up', detail: 'The farm never claimed this step before its queue watchdog fired.' },
  [REASON.TIMEOUT]: { label: 'Timed out', detail: 'The step started but the farm never reported it finishing in time.' },
  [REASON.UNREACHABLE]: { label: 'Farm unreachable', detail: 'Horizon could not reach the farm to dispatch or check on this step.' },
  [REASON.TURN_CAP]: { label: 'Ran out of turns', detail: 'The agent hit its turn budget before finishing the step.' },
  [REASON.REQUIRED_INPUT_INCOMPLETE]: {
    label: 'Required input incomplete',
    detail: 'A required input could not be supplied in full — a capacity limit, not a bug. Resume once it fits, or split the step.',
  },
  [REASON.READ_ONLY_VIOLATED]: {
    label: 'Read-only step changed files',
    detail: 'A planning or review step edited the worktree. Horizon put it back and paused the item.',
  },
  [REASON.PLAN_CHANGED_SINCE_APPROVAL]: {
    label: 'Run plan changed since approval',
    detail: 'The run plan is not the one a human approved. Send it back to Run plan and approve the run again.',
  },
  [REASON.JOB_BUDGET_EXCEEDED]: {
    label: 'Run exceeded its time budget',
    detail: 'The job ran past the run plan’s time budget and was stopped. Resume to retry the remaining commands, or send it back to Run plan.',
  },
}

// Both mirror the event text server/src/store.js:1208 writes on pause/resume.
const MANUAL_PAUSE_TEXT = 'paused agent work on this item'
const RESUME_TEXT = 'resumed work'

// Matches failFarmRun's pause-event text exactly (both the exhausted-budget
// and plain-pause branches); the reason tag is absent whenever no reason was
// classified, per the frozen wording HZ-94 must not change. The cause is
// `[\s\S]+?`, not `.+?`: a check failure's cause is multi-line command output
// (HZ-343). No `m` flag, so `$` still pins the frozen suffix to the very end.
const PAUSE_EVENT_RE =
  /^agent step failed(?: \(([^)]+)\))?: ([\s\S]+?) — (?:auto-retry budget \((\d+)\) exhausted; item paused, resume to retry|item paused; resume to retry)$/

// Matches the intermediate auto-retry event failFarmRun writes just before a
// retry dispatch — used only to count attempts already used, never rendered.
const RETRY_EVENT_RE = /^transient failure \([^)]+\): [\s\S]+ — auto-retrying \(\d+\/\d+\)$/

// A cause is shown in full up to MAX_CAUSE_LINES. Longer output (a check's
// whole log) keeps its last line, up to MAX_FLAGGED_LINES lines that name the
// failure, then as much of the tail as still fits — in original order, with a
// GAP line wherever lines were dropped. GAP lines count toward the limit. This
// only shapes what the banner shows; the stored event text is never cut here.
// (Today failFarmRun already caps the cause at 200 chars, so this guards the
// day that cap is raised.)
const MAX_CAUSE_LINES = 20
const MAX_FLAGGED_LINES = 10
const FLAGGED_LINE_RE = /FAILED:|No such file|not ok/
const GAP = '…'

function trimCause(text) {
  if (text.split('\n').length <= MAX_CAUSE_LINES) return text

  const lines = text.replace(/\s+$/, '').split('\n')
  const last = lines.length - 1
  const keep = new Set([last])
  const render = () => {
    const out = []
    let prev = -1
    for (const i of [...keep].sort((a, b) => a - b)) {
      if (i !== prev + 1) out.push(GAP)
      out.push(lines[i])
      prev = i
    }
    return out
  }
  // Adds line i only if the rendered cause still fits; reports whether it did.
  const tryKeep = (i) => {
    keep.add(i)
    if (render().length <= MAX_CAUSE_LINES) return true
    keep.delete(i)
    return false
  }

  let flagged = 0
  for (let i = 0; i < last && flagged < MAX_FLAGGED_LINES; i++) {
    if (!FLAGGED_LINE_RE.test(lines[i])) continue
    if (!tryKeep(i)) break
    flagged++
  }
  for (let i = last - 1; i >= 0; i--) {
    if (!keep.has(i) && !tryKeep(i)) break
  }
  return render().join('\n')
}

const NO_DETAILS = { category: null, label: null, detail: null, cause: null, fullError: null, exhausted: false, attemptsUsed: 0 }

// Returns null when the item isn't paused, or a structured explanation:
// { category, label, detail, cause, fullError, exhausted, attemptsUsed } for a failure
// pause; { category: 'manual' } for a human-initiated pause (nothing to
// explain — not a failure); or a category: null fallback that still carries a
// non-blank message when no pause event exists since the last resume
// (legacy/corrupted data, or the pause event fell out of the events window).
export function pauseReason(item) {
  if (!item?.paused) return null

  const events = item.events || []

  for (let i = 0; i < events.length; i++) {
    const text = events[i]?.text || ''
    if (text === RESUME_TEXT) break
    if (text === MANUAL_PAUSE_TEXT) {
      return { category: 'manual', label: null, detail: null, cause: null, fullError: null, exhausted: false, attemptsUsed: 0 }
    }

    const match = text.match(PAUSE_EVENT_RE)
    if (!match) continue

    const [, reason, cause, cap] = match
    // Object.hasOwn, not a bare lookup: CATEGORY_COPY is a plain object literal,
    // so a pause tagged `constructor` or `toString` would resolve a truthy
    // Object.prototype member and render `undefined` as its title instead of
    // falling back to the raw cause. Pre-existing bug, fixed here (HZ-132).
    const known = reason != null && Object.hasOwn(CATEGORY_COPY, reason) ? CATEGORY_COPY[reason] : null

    // The retries that led to THIS pause sit just below it, not below events[0].
    let attemptsUsed = 0
    for (let j = i + 1; j < events.length && RETRY_EVENT_RE.test(events[j]?.text || ''); j++) attemptsUsed++

    return {
      category: reason || null,
      label: known ? known.label : null,
      detail: known ? known.detail : null,
      cause: trimCause(cause),
      // HZ-373: the event's `detail` — a check failure's whole message behind
      // its one-line cause, for "Show details". Null on any other pause and
      // on events written before it. Not `detail`, the category copy above.
      fullError: events[i].detail || null,
      exhausted: cap != null,
      attemptsUsed,
    }
  }

  return { ...NO_DETAILS }
}
