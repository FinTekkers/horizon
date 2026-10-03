// HZ-216: what the Accept gate shows about its long actions — the pre-merge
// checks + merge (HZ-183) and conflict resolution (HZ-188). Everything here
// reads the server's item.gateAction (and HZ-188's item.conflictRun), never
// the clicking tab's own state, so a reload, another tab and an approval from
// WhatsApp all show the same thing. App.jsx adds this tab's in-flight request
// on top, for the gap before the first push.

// The action to show for an item, or null. A running conflictRun stands in
// for a payload that has no gateAction key.
export function gateActionOf(item) {
  if (item?.gateAction) return item.gateAction
  if (item?.conflictRun?.state === 'running') {
    return { kind: 'resolve', state: 'running', since: item.conflictRun.since, detail: null }
  }
  return null
}

// True while the gate's buttons must stay disabled: an action is running.
// Any finished row re-enables them — a merge whose gate never advanced (the
// advance was refused) must not leave the gate disabled for good.
export function gateActionBusy(item) {
  return gateActionOf(item)?.state === 'running'
}

// "3m 12s" from a server ISO timestamp. Clock skew never shows a negative.
// HZ-228: { seconds: false } is the Board card's coarser form — "<1m", "12m",
// and "1h 05m" from an hour up — for a label that ticks once a minute.
export function elapsedText(since, now = Date.now(), { seconds = true } = {}) {
  const t = Date.parse(since)
  if (Number.isNaN(t)) return ''
  const secs = Math.max(0, Math.floor((now - t) / 1000))
  const mins = Math.floor(secs / 60)
  if (!seconds) {
    if (mins < 1) return '<1m'
    if (mins < 60) return `${mins}m`
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
  }
  return mins > 0 ? `${mins}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`
}

// HZ-231: the pre-merge runs that ended with no answer or broke, where the
// gate offers Retry — Accept's own action, relabelled. A blocked run is not
// here: a conflict keeps Resolve conflicts. Nothing retries on its own.
export const RETRY_STATES = ['timed_out', 'interrupted', 'failed']
export const RETRY_LABEL = 'Retry'

export function isRetryable(action) {
  return action?.kind === 'premerge' && RETRY_STATES.includes(action.state)
}

// { tone: 'running' | 'ok' | 'error', text, note? } for the status line.
export function gateActionView(action, pr) {
  if (!action) return null
  if (action.state === 'running') {
    const text =
      action.kind === 'resolve'
        ? `Resolving conflicts on PR #${pr}`
        : `Merging: ${action.detail || `running checks on PR #${pr}`}`
    const note = action.startedBeforeRestart
      ? `Started before Horizon restarted — if it never reports back, the gate re-opens by ${new Date(action.deadline).toLocaleTimeString()}.`
      : null
    return { tone: 'running', text, note }
  }
  if (action.state === 'merged') return { tone: 'ok', text: `Merged PR #${pr}` }
  if (action.state === 'blocked') {
    return {
      tone: 'error',
      text: action.failingCheck ? `Blocked: pre-merge check ${action.failingCheck} failed` : `Blocked: ${action.reason || 'the pre-merge checks did not pass'}`,
      note: 'The PR was not merged. See the activity log, then approve again.',
    }
  }
  if (action.kind === 'premerge' && action.state === 'failed') {
    return { tone: 'error', text: `Not merged — press ${RETRY_LABEL}`, note: action.reason }
  }
  if (action.kind === 'premerge' && (action.state === 'timed_out' || action.state === 'interrupted')) {
    return { tone: 'error', text: `Checks did not finish — press ${RETRY_LABEL}`, note: action.reason }
  }
  // Resolve outcomes keep HZ-188's own dialog and wording.
  return null
}
