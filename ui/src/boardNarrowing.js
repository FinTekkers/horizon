// Per-browser board narrowing state (HZ-443): Waiting on me and its sort
// direction, Priority and Kind. The same localStorage + subscribe shape as
// boardFilters.js, under its own key, so the hide filters' stored choices are
// untouched and need no version bump. Every read goes through validView: bad
// JSON, a wrong type or an unknown value falls back to nothing selected.

import { DEFAULT_VIEW, validView } from './domain/narrowing'

const STORAGE_KEY = 'horizon.boardView'
const listeners = new Set()

function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return validView(raw ? JSON.parse(raw) : null)
  } catch {
    return validView(null)
  }
}

function writeStorage(view) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(view))
  } catch {
    // ignore — private browsing; the choice lasts for this page only
  }
}

// A stable reference for useSyncExternalStore, replaced only by a write.
let cached = readStorage()

export function getBoardView() {
  return cached
}

export function setBoardView(patch) {
  cached = validView({ ...cached, ...patch })
  writeStorage(cached)
  listeners.forEach((fn) => fn())
}

export function clearBoardView() {
  setBoardView(DEFAULT_VIEW)
}

export function toggleIn(field, key) {
  const current = cached[field]
  setBoardView({ [field]: current.includes(key) ? current.filter((k) => k !== key) : [...current, key] })
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Test-only: a clean slate, and a re-read of storage as a page reload does.
export function _resetForTests() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
  cached = validView(null)
}

export function _reloadForTests() {
  cached = readStorage()
}
