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
export function elapsedText(since, now = Date.now()) {
  const t = Date.parse(since)
  if (Number.isNaN(t)) return ''
  const secs = Math.max(0, Math.floor((now - t) / 1000))
  const mins = Math.floor(secs / 60)
  return mins > 0 ? `${mins}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`
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
    return { tone: 'error', text: 'Not merged — click Approve again', note: action.reason }
  }
  if (action.kind === 'premerge' && (action.state === 'timed_out' || action.state === 'interrupted')) {
    return { tone: 'error', text: 'Checks did not finish — click Approve again', note: action.reason }
  }
  // Resolve outcomes keep HZ-188's own dialog and wording.
  return null
}
