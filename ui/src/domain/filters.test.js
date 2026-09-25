// HZ-80: the board's filter mechanism. Covers the success metric's four
// named cases — default hide/reveal, a boundary item, filters combining
// rather than overriding, and (separately, in Board.test.jsx) an empty
// result rendering an explanation — plus the extensibility claim itself.

import { expect, test } from 'vitest'
import { FILTERS, DEFAULT_ACTIVE_FILTERS, STALE_DAYS, daysSince, visibleItems, hiddenCounts, matchCounts } from './filters'

const NOW = new Date('2026-09-24T00:00:00Z')

const MS_PER_DAY = 24 * 60 * 60 * 1000

// SQLite datetime format ("YYYY-MM-DD HH:MM:SS", no timezone marker,
// implicitly UTC) — matches what the server actually sends.
function sqliteTimestamp(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

function daysAgo(n) {
  return sqliteTimestamp(NOW.getTime() - n * MS_PER_DAY)
}

function item(id, overrides = {}) {
  return { id, last_activity_at: daysAgo(0), ...overrides }
}

// ---- default active set ----

test('both stale and abandoned are active by default', () => {
  expect(DEFAULT_ACTIVE_FILTERS.sort()).toEqual(['abandoned', 'stale'])
})

// ---- staleness boundary ----

test('29d23h59m is visible; exactly 30d, and 30d0h0m1s past, are hidden', () => {
  const justUnder = item('A', { last_activity_at: sqliteTimestamp(NOW.getTime() - (STALE_DAYS * MS_PER_DAY - 60_000)) })
  const exactly30 = item('B', { last_activity_at: sqliteTimestamp(NOW.getTime() - STALE_DAYS * MS_PER_DAY) })
  const past30 = item('C', { last_activity_at: sqliteTimestamp(NOW.getTime() - (STALE_DAYS * MS_PER_DAY + 1000)) })

  expect(daysSince(justUnder.last_activity_at, NOW)).toBeLessThan(STALE_DAYS)
  expect(visibleItems([justUnder], ['stale'], NOW).map((i) => i.id)).toEqual(['A'])

  expect(daysSince(exactly30.last_activity_at, NOW)).toBeGreaterThanOrEqual(STALE_DAYS)
  expect(visibleItems([exactly30], ['stale'], NOW)).toEqual([])

  expect(visibleItems([past30], ['stale'], NOW)).toEqual([])
})

test('an item with no last_activity_at yet (brand new) does not crash and is not stale', () => {
  const fresh = { id: 'FRESH', last_activity_at: null }
  expect(daysSince(fresh.last_activity_at, NOW)).toBe(0)
  expect(visibleItems([fresh], ['stale'], NOW)).toEqual([fresh])
})

// ---- default hiding and revealing ----

test('a stale item is hidden by default and reappears once the stale filter is toggled off', () => {
  const stale = item('S', { last_activity_at: daysAgo(45) })
  expect(visibleItems([stale], DEFAULT_ACTIVE_FILTERS, NOW)).toEqual([])
  expect(visibleItems([stale], DEFAULT_ACTIVE_FILTERS.filter((k) => k !== 'stale'), NOW)).toEqual([stale])
})

test('an abandoned item is hidden by default and reappears once the abandoned filter is toggled off', () => {
  const abandoned = item('AB', { abandoned_at: daysAgo(1) })
  expect(visibleItems([abandoned], DEFAULT_ACTIVE_FILTERS, NOW)).toEqual([])
  expect(visibleItems([abandoned], DEFAULT_ACTIVE_FILTERS.filter((k) => k !== 'abandoned'), NOW)).toEqual([abandoned])
})

// ---- filters combine, they don't override each other ----

test('an item that is both stale and abandoned counts in both buckets, and toggling only one filter off leaves it hidden', () => {
  const both = item('BOTH', { last_activity_at: daysAgo(60), abandoned_at: daysAgo(60) })
  const counts = hiddenCounts([both], DEFAULT_ACTIVE_FILTERS, NOW)
  expect(counts).toEqual({ stale: 1, abandoned: 1 })

  // Turning off just 'stale' — it's still caught by 'abandoned'.
  expect(visibleItems([both], ['abandoned'], NOW)).toEqual([])
  // Turning off just 'abandoned' — it's still caught by 'stale'.
  expect(visibleItems([both], ['stale'], NOW)).toEqual([])
  // Turning off both — it reappears.
  expect(visibleItems([both], [], NOW)).toEqual([both])
})

test('hiddenCounts is 0 for a filter that is not active, even though items still match its predicate', () => {
  const stale = item('S', { last_activity_at: daysAgo(45) })
  expect(hiddenCounts([stale], [], NOW)).toEqual({ stale: 0, abandoned: 0 })
  expect(matchCounts([stale], NOW)).toEqual({ stale: 1, abandoned: 0 })
})

// ---- extensibility: appending a predicate requires no change to
// visibleItems/hiddenCounts, only a new registry entry ----

test('a persona-style predicate can be appended without touching visibleItems or hiddenCounts', () => {
  const extended = [...FILTERS, { key: 'persona:eng', label: 'Eng', noun: 'Eng persona', hides: (it) => it.persona === 'eng' }]
  const items = [
    { id: 'ENG-1', persona: 'eng', last_activity_at: daysAgo(0) },
    { id: 'QA-1', persona: 'qa', last_activity_at: daysAgo(0) },
  ]

  expect(visibleItems(items, ['persona:eng'], NOW, extended).map((i) => i.id)).toEqual(['QA-1'])
  expect(hiddenCounts(items, ['persona:eng'], NOW, extended)).toEqual({ stale: 0, abandoned: 0, 'persona:eng': 1 })
})
