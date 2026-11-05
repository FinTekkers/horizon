// HZ-713: why an item has stopped on its step, and the one action that
// continues it — or null when nothing holds it. The one place the order
// lives: an item can carry several holds at once, and the board shows only
// the first of these.
//
//   ruleBlocked  a rule stopped the run       → Release with PIN
//   runFailed    a run failed and paused it   → Retry
//   paused       you paused it                → Resume
//   isolation    its project refuses dispatch → Open project settings
//   usageLimit   every model is usage-limited → Release now
//   dependency   an open item blocks it       → Open <blocker>
//
// A rule block ranks above a pause: Resume on a blocked item needs the gate
// PIN (the /pause route), so a paused, blocked item must offer the release.
// Read straight off the item, so isRuleBlocked's "paused wins" is not used.
// Nothing here sets or clears a hold; the server owns every one.

import { isAbandoned, isClosed } from '../../../domain/js/lifecycle.js'
import { pauseReason } from './pauseReason'
import { isDependencyBlocked } from './status'

export const HOLD_REASONS = Object.freeze(['ruleBlocked', 'runFailed', 'paused', 'isolation', 'usageLimit', 'dependency'])

// The blocker the dependency hold opens: the first one still holding, else
// the first listed.
function blockerOf(item) {
  const blockers = item.blockedBy ?? []
  return blockers.find((b) => !b.merged && !b.abandoned) ?? blockers[0] ?? null
}

export function holdFor(item) {
  if (!item || isClosed(item) || isAbandoned(item)) return null

  if (item.ruleBlock && !item.rejected) {
    return { reason: 'ruleBlocked', title: 'Blocked by a rule', action: { key: 'releaseRuleBlock', label: 'Release with PIN' } }
  }

  const paused = pauseReason(item)
  if (paused && paused.category !== 'manual') {
    return { reason: 'runFailed', title: paused.label || 'Paused', action: { key: 'retry', label: 'Retry' } }
  }
  if (paused) {
    return { reason: 'paused', title: 'Paused by you', detail: 'No agent work runs until you resume it.', action: { key: 'resume', label: 'Resume' } }
  }

  if (item.isolationRefusal) {
    return { reason: 'isolation', title: item.isolationRefusal, action: { key: 'openProjectSettings', label: 'Open project settings' } }
  }

  // The server builds the text, so every client shows the same time (HZ-422).
  if (item.usageWait) {
    return { reason: 'usageLimit', title: item.usageWait.text, action: { key: 'releaseUsageWait', label: 'Release now' } }
  }

  if (isDependencyBlocked(item)) {
    const blocker = blockerOf(item)
    if (blocker) {
      return {
        reason: 'dependency',
        title: `Waiting on ${blocker.id}`,
        detail: blocker.title,
        action: { key: 'openBlocker', label: `Open ${blocker.id}`, target: blocker.id },
      }
    }
  }
  return null
}
