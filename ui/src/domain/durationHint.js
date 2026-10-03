// HZ-230: the "usually ~20m" hint after a Board card's elapsed label, from the
// snapshot's durationEstimates (HZ-229). It is a typical duration, never a
// countdown: past twice the usual time it reads 'running long' instead.
// Cards waiting on a human never get one — only active agent steps and a
// running Accept/Resolve action do.

import { isClosed, isAbandoned, curStep } from '../../../domain/js/lifecycle.js'
import { gateActionOf, elapsedText } from './gateAction'

// The gate actions durationEstimates carries an entry for.
const GATE_ESTIMATE_KINDS = new Set(['premerge', 'resolve'])
// Under a minute would read 'usually ~<1m': not worth showing.
const MIN_ESTIMATE_SEC = 60

function estimateKey(item) {
  const cur = curStep(item)
  if (!cur) return null
  if (cur.kind === 'gate') {
    const action = gateActionOf(item)
    if (action?.state !== 'running' || !GATE_ESTIMATE_KINDS.has(action.kind)) return null
    return action.kind
  }
  return String(item.cursor)
}

// { text, long } for the card, or null for elapsed only. Never throws on a
// missing, null or malformed estimate.
export function usualDurationHint(item, estimates, now) {
  if (!item?.state_since || !estimates || typeof estimates !== 'object') return null
  if (isClosed(item) || isAbandoned(item) || item.rejected || item.paused) return null
  const since = Date.parse(item.state_since)
  if (Number.isNaN(since)) return null
  const key = estimateKey(item)
  if (key == null || !Object.hasOwn(estimates, key)) return null
  const entry = estimates[key]
  const medianSec = entry && typeof entry === 'object' ? entry.medianSec : undefined
  if (typeof medianSec !== 'number' || !Number.isFinite(medianSec) || medianSec < MIN_ESTIMATE_SEC) return null
  if (now - since > 2 * medianSec * 1000) return { text: 'running long', long: true }
  // elapsedText's minute form, fed a start medianSec ago — no second formatter.
  return { text: `usually ~${elapsedText(new Date(now - medianSec * 1000).toISOString(), now, { seconds: false })}`, long: false }
}
