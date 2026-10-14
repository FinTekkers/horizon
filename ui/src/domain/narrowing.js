// Board narrowing (HZ-443). Unlike domain/filters.js's HIDE predicates, these
// controls NARROW the board to what matches: Waiting on me, Priority and Kind.
// Within one control the selections are OR'd (High or Critical); across
// controls, AND'd. Nothing selected narrows nothing, so the default board is
// exactly what filters.js leaves.
//
// "Waiting on me" is the server's call, not a second copy of its rule: an item
// is waiting when its payload carries a waiting_since (store.js waitingSince —
// at a human gate, rule-blocked or paused).

import { PRIORITIES } from '../../../domain/js/priorities.js'
import { ITEM_KIND_INFO, LANES, laneOf, itemKindOf, isItemKind } from '../../../domain/js/lifecycle.js'

export const SORT_DIRS = ['oldest', 'newest']
export const SORT_LABELS = { oldest: 'Longest wait', newest: 'Most recent' }

export const DEFAULT_VIEW = Object.freeze({ waiting: false, sortDir: SORT_DIRS[0], priorities: [], kinds: [] })

// Every item kind, then every lane — a lane names a narrower slice of its kind
// (Trivial is a change with the `trivial` label), so a laned item matches only
// its lane's key, never its kind's.
export const KIND_OPTIONS = [
  ...ITEM_KIND_INFO.map(({ kind, label }) => ({ key: kind, label })),
  ...LANES.map((lane) => ({ key: lane, label: lane.charAt(0).toUpperCase() + lane.slice(1) })),
]

const KIND_KEYS = KIND_OPTIONS.map((o) => o.key)

// Null for a kind the domain does not declare, which no Kind chip matches —
// itemKindOf would throw on it.
export function kindKey(item) {
  if (item.kind != null && item.kind !== '' && !isItemKind(item.kind)) return null
  return laneOf(item) ?? itemKindOf(item)
}

export function isWaitingOnMe(item) {
  return typeof item.waiting_since === 'string' && !Number.isNaN(Date.parse(item.waiting_since))
}

// 'waiting 12m', 'waiting 3h', 'waiting 2d'; '' when `since` is missing or bad.
export function waitText(since, now = Date.now()) {
  const t = Date.parse(since)
  if (typeof since !== 'string' || Number.isNaN(t)) return ''
  const mins = Math.max(0, Math.floor((now - t) / 60_000))
  if (mins < 60) return `waiting ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `waiting ${hours}h`
  return `waiting ${Math.floor(hours / 24)}d`
}

function pick(raw, key) {
  return raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined
}

function validList(value, allowed) {
  if (!Array.isArray(value) || !value.every((v) => allowed.includes(v))) return []
  return [...new Set(value)]
}

// Any input → a safe view. Each field that is missing, the wrong type or holds
// an unknown value falls back to DEFAULT_VIEW's, never throws.
export function validView(raw) {
  const waiting = pick(raw, 'waiting')
  const sortDir = pick(raw, 'sortDir')
  return {
    waiting: waiting === true,
    sortDir: SORT_DIRS.includes(sortDir) ? sortDir : DEFAULT_VIEW.sortDir,
    priorities: validList(pick(raw, 'priorities'), PRIORITIES),
    kinds: validList(pick(raw, 'kinds'), KIND_KEYS),
  }
}

export function isNarrowing(view) {
  return view.waiting || view.priorities.length > 0 || view.kinds.length > 0
}

export function narrowItems(items, view) {
  return items.filter(
    (item) =>
      (!view.waiting || isWaitingOnMe(item)) &&
      (view.priorities.length === 0 || view.priorities.includes(item.priority)) &&
      (view.kinds.length === 0 || view.kinds.includes(kindKey(item))),
  )
}

// Stable: equal waits keep their order. An item with no wait sorts last in
// either direction.
export function sortByWait(items, sortDir) {
  const sign = sortDir === 'newest' ? -1 : 1
  const at = (item) => (isWaitingOnMe(item) ? Date.parse(item.waiting_since) : null)
  return items
    .map((item, i) => ({ item, i, t: at(item) }))
    .sort((a, b) => {
      if (a.t == null || b.t == null) return a.t == null && b.t == null ? a.i - b.i : a.t == null ? 1 : -1
      return (a.t - b.t) * sign || a.i - b.i
    })
    .map(({ item }) => item)
}
