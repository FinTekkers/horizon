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

const STORAGE_KEY = 'horizon_board_filters'
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
