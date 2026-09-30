// Board filter mechanism (HZ-80). A filter is a pure predicate over (item,
// now) that decides whether an item should be HIDDEN. The board hides an
// item when ANY active filter's predicate matches it — so turning on a
// second filter only ever hides more, never un-hides what the first caught
// (filters combine, they don't override each other).
//
// Adding a future filter (persona, tag) means appending one entry to FILTERS
// below — visibleItems/hiddenCounts never change. See filters.test.js's
// "extensibility" test for a literal proof: it appends a throwaway predicate
// and asserts these functions handle it with zero edits.
//
// `stale`, `abandoned` and `closed` are independent predicates, not one
// merged rule — an item that is both stale and closed matches both, and a
// reader can ask "what did we abandon?" separately from "what went stale?"
// and from "what did we finish?".

import { isAbandoned, isClosed } from '../../../domain/js/lifecycle.js'

export const STALE_DAYS = 30

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Mirrors Tracker.jsx's elapsedMinutes: SQLite's datetime('now') has no
// timezone marker, so a bare "YYYY-MM-DD HH:MM:SS" is UTC and needs 'Z'
// appended before Date.parse will treat it as such.
function toMillis(value) {
  if (!value) return null
  const t = Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z')
  return Number.isNaN(t) ? null : t
}

// No timestamp yet (a brand-new item) reads as "just active" — 0 days since
// — rather than crashing on NaN date math or reading as maximally stale.
export function daysSince(value, now) {
  const t = toMillis(value)
  if (t == null) return 0
  return (now.getTime() - t) / MS_PER_DAY
}

export const FILTERS = [
  {
    key: 'stale',
    label: `Stale (${STALE_DAYS}+ days)`,
    noun: 'stale',
    hides: (item, now) => daysSince(item.last_activity_at, now) >= STALE_DAYS,
  },
  {
    key: 'abandoned',
    label: 'Abandoned',
    noun: 'abandoned',
    hides: (item) => isAbandoned(item),
  },
  // HZ-143: finished work crowds the Review column. `!isAbandoned` keeps this
  // independent of the `abandoned` filter rather than double-counting an item
  // abandoned at the final gate — the same "abandoned beats closed"
  // precedence domain/status.js's itemStatus encodes for the status pill. The
  // two must not drift: change one, check the other.
  {
    key: 'closed',
    label: 'Closed',
    noun: 'closed',
    hides: (item) => isClosed(item) && !isAbandoned(item),
  },
]

// Hidden-by-default: every predicate starts active, matching the success
// metric ("hides items with no progress for 30+ days by default") plus the
// later scope additions to also hide abandoned (HZ-59) and closed (HZ-143)
// items by default.
export const DEFAULT_ACTIVE_FILTERS = FILTERS.map((f) => f.key)

// `filters` defaults to the real registry but takes an explicit param so a
// caller (or a test) can prove the mechanism works with an extended
// registry without touching this function's body.
export function visibleItems(items, activeKeys, now = new Date(), filters = FILTERS) {
  const active = filters.filter((f) => activeKeys.includes(f.key))
  return items.filter((item) => !active.some((f) => f.hides(item, now)))
}

// How many items each filter is CURRENTLY hiding — 0 for an inactive filter,
// since an inactive filter hides nothing. Buckets are independent, not
// deduped against each other: an item matching two active filters counts in
// both, so "13 stale, 4 abandoned" can describe 17 hidden slots covering
// fewer than 17 distinct items. That's intentional, not a bug — see the
// module comment.
export function hiddenCounts(items, activeKeys, now = new Date(), filters = FILTERS) {
  const counts = {}
  for (const f of filters) {
    counts[f.key] = activeKeys.includes(f.key) ? items.filter((item) => f.hides(item, now)).length : 0
  }
  return counts
}

// Total matches per filter regardless of active state — the chip label's
// count ("Stale (13)") stays stable whether or not that chip is currently
// hiding those items, so toggling a chip off doesn't make its own count
// disappear.
export function matchCounts(items, now = new Date(), filters = FILTERS) {
  const counts = {}
  for (const f of filters) counts[f.key] = items.filter((item) => f.hides(item, now)).length
  return counts
}
