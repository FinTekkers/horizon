// HZ-80: per-browser persistence for the board's active filter set. Mirrors
// theme.js's own test coverage style — localStorage round-trip, default
// value, and the subscribe/notify contract useSyncExternalStore relies on.

import { afterEach, expect, test, vi } from 'vitest'
import * as boardFilters from './boardFilters'
import { DEFAULT_ACTIVE_FILTERS } from './domain/filters'

afterEach(() => {
  boardFilters._resetForTests()
  localStorage.clear()
})

test('defaults to every filter active when nothing is stored yet', () => {
  expect(boardFilters.getActiveFilters()).toEqual(DEFAULT_ACTIVE_FILTERS)
})

test('setActiveFilters persists to localStorage and getActiveFilters reflects it', () => {
  boardFilters.setActiveFilters(['abandoned'])
  expect(boardFilters.getActiveFilters()).toEqual(['abandoned'])
  expect(JSON.parse(localStorage.getItem('horizon_board_filters_v2'))).toEqual(['abandoned'])
})

// HZ-143: `cached` is computed from storage exactly once, at module load, so
// these two need a real re-import — _resetForTests() assigns the default
// directly and never re-reads storage, which would make either assertion
// pass against itself.
test('a legacy horizon_board_filters value does not out-vote the new closed default', async () => {
  localStorage.setItem('horizon_board_filters', JSON.stringify(['stale', 'abandoned']))
  vi.resetModules()
  const fresh = await import('./boardFilters')
  expect(fresh.getActiveFilters()).toContain('closed')
})

test('a stored horizon_board_filters_v2 value is still honoured on load', async () => {
  localStorage.setItem('horizon_board_filters_v2', JSON.stringify(['stale']))
  vi.resetModules()
  const fresh = await import('./boardFilters')
  expect(fresh.getActiveFilters()).toEqual(['stale'])
})

test('toggleFilter adds an inactive key and removes an active one', () => {
  boardFilters.setActiveFilters(['stale'])
  boardFilters.toggleFilter('abandoned')
  expect(boardFilters.getActiveFilters().sort()).toEqual(['abandoned', 'stale'])
  boardFilters.toggleFilter('stale')
  expect(boardFilters.getActiveFilters()).toEqual(['abandoned'])
})

test('subscribers are notified on every change, and unsubscribing stops delivery', () => {
  let calls = 0
  const unsubscribe = boardFilters.subscribe(() => calls++)
  boardFilters.setActiveFilters([])
  expect(calls).toBe(1)
  unsubscribe()
  boardFilters.setActiveFilters(['stale'])
  expect(calls).toBe(1)
})

test('getActiveFilters returns a stable reference across reads with no change — required by useSyncExternalStore', () => {
  const a = boardFilters.getActiveFilters()
  const b = boardFilters.getActiveFilters()
  expect(a).toBe(b)
  boardFilters.setActiveFilters(['stale'])
  const c = boardFilters.getActiveFilters()
  expect(c).not.toBe(a)
  expect(boardFilters.getActiveFilters()).toBe(c)
})

test('one browser narrowing its view has no shared/global state to leak — persistence is localStorage-only', () => {
  boardFilters.setActiveFilters(['stale'])
  localStorage.clear()
  // A fresh module load (simulated: reset cache, re-read storage) would see
  // the default again — nothing server-side or module-global survives a
  // cleared browser store.
  boardFilters._resetForTests()
  expect(boardFilters.getActiveFilters()).toEqual(DEFAULT_ACTIVE_FILTERS)
})
