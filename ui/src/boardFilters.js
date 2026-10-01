// Per-browser board filter state (HZ-80). Mirrors ui/src/theme.js's
// localStorage + subscribe shape — proven private-browsing-safe — so that
// one person narrowing their view never changes what anyone else sees.
//
// Unlike theme.js's getTheme() (a primitive, cheap to recompute), the
// active-filter set is an array: useSyncExternalStore requires getSnapshot
// to return a stable reference when nothing changed, or React treats every
// render as a new snapshot and warns/loops. `cached` is that stable
// reference — replaced only by setActiveFilters, never by a read.

import { DEFAULT_ACTIVE_FILTERS } from './domain/filters'

// HZ-143: bumped from 'horizon_board_filters'. `cached` below prefers a
// stored array over DEFAULT_ACTIVE_FILTERS, so anyone who has ever clicked a
// chip has ['stale','abandoned'] on disk out-voting the new 'closed' default
// — their Review column would stay crowded and the item's stated outcome
// would never land for a returning browser.
//
// DELIBERATE SCOPE EXCEPTION, flagged for review. HZ-143's guardrail 5 scopes
// the change to domain/filters.js, its tests and the Board; this file is not
// on that list. Architecture review pre-approved the bump on the condition
// that its cost is stated plainly rather than discovered, so:
//   - every browser loses its saved chip toggles exactly once;
//   - that includes Stale and Abandoned — someone who had turned Stale OFF
//     gets it back ON. Guardrail 3 ("do not change how Stale or Abandoned
//     behave") is not violated at the code level — neither predicate nor
//     either default is touched — but this IS a one-time, user-visible reset
//     of those two chips, and a reviewer should weigh it as such.
// Reverting just this one line keeps the whole feature working; only
// returning browsers lose the new default.
//
// Known limitation: because we store the ACTIVE set, every future filter
// needs another bump. Storing the OFF set instead would make new filters
// default-on with no migration — worth doing if a fourth filter ever lands.
const STORAGE_KEY = 'horizon_board_filters_v2'
const listeners = new Set()

function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeStorage(keys) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys))
  } catch {
    // ignore — see readStorage
  }
}

let cached = readStorage() ?? DEFAULT_ACTIVE_FILTERS

export function getActiveFilters() {
  return cached
}

export function setActiveFilters(keys) {
  cached = keys
  writeStorage(keys)
  listeners.forEach((fn) => fn())
}

export function toggleFilter(key) {
  const current = getActiveFilters()
  setActiveFilters(current.includes(key) ? current.filter((k) => k !== key) : [...current, key])
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Test-only reset — Board.test.jsx and boardFilters.test.js run several
// scenarios in one module instance and need a clean slate between them.
export function _resetForTests() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
  cached = DEFAULT_ACTIVE_FILTERS
}
