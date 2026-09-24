// HZ-80: per-browser persistence for the board's active filter set. Mirrors
// theme.js's own test coverage style — localStorage round-trip, default
// value, and the subscribe/notify contract useSyncExternalStore relies on.

import { afterEach, expect, test } from 'vitest'
import * as boardFilters from './boardFilters'
import { DEFAULT_ACTIVE_FILTERS } from './domain/filters'

afterEach(() => {
  boardFilters._resetForTests()
})

test('defaults to both filters active when nothing is stored yet', () => {
  expect(boardFilters.getActiveFilters()).toEqual(DEFAULT_ACTIVE_FILTERS)
})

test('setActiveFilters persists to localStorage and getActiveFilters reflects it', () => {
  boardFilters.setActiveFilters(['abandoned'])
  expect(boardFilters.getActiveFilters()).toEqual(['abandoned'])
  expect(JSON.parse(localStorage.getItem('horizon_board_filters'))).toEqual(['abandoned'])
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
