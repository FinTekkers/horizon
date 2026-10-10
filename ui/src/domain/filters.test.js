// HZ-80: the board's filter mechanism. Covers the success metric's four
// named cases — default hide/reveal, a boundary item, filters combining
// rather than overriding, and (separately, in Board.test.jsx) an empty
// result rendering an explanation — plus the extensibility claim itself.
// HZ-143 appended the `closed` filter and added the cases below its own
// "---- closed ----" heading; it needed no change to the three functions.

import { expect, test } from 'vitest'
import { FILTERS, DEFAULT_ACTIVE_FILTERS, STALE_DAYS, daysSince, visibleItems, hiddenCounts, matchCounts } from './filters'
// Derived, never hardcoded — requiredStepIndex's own comment sets the
// precedent: a future step insertion must not silently move this boundary.
import { endIndex } from '../../../domain/js/lifecycle.js'

const CLOSED_CURSOR = endIndex('change')

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
  return { id, cursor: 0, last_activity_at: daysAgo(0), ...overrides }
}

// ---- default active set ----

test('stale, abandoned and closed are all active by default', () => {
  expect([...DEFAULT_ACTIVE_FILTERS].sort()).toEqual(['abandoned', 'closed', 'stale'])
})

// HZ-143 metric 6: the whole feature is one appended registry entry, so the
// registry's shape — and its order, which Board.jsx renders chips in — is
// what's worth pinning. See the extensibility test at the bottom for the
// other half: visibleItems/hiddenCounts needed no edit to support it.
test('FILTERS is exactly three entries, in chip order', () => {
  expect(FILTERS.map((f) => f.key)).toEqual(['stale', 'abandoned', 'closed'])
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
  expect(counts).toEqual({ stale: 1, abandoned: 1, closed: 0 })

  // Turning off just 'stale' — it's still caught by 'abandoned'.
  expect(visibleItems([both], ['abandoned'], NOW)).toEqual([])
  // Turning off just 'abandoned' — it's still caught by 'stale'.
  expect(visibleItems([both], ['stale'], NOW)).toEqual([])
  // Turning off both — it reappears.
  expect(visibleItems([both], [], NOW)).toEqual([both])
})

test('hiddenCounts is 0 for a filter that is not active, even though items still match its predicate', () => {
  const stale = item('S', { last_activity_at: daysAgo(45) })
  expect(hiddenCounts([stale], [], NOW)).toEqual({ stale: 0, abandoned: 0, closed: 0 })
  expect(matchCounts([stale], NOW)).toEqual({ stale: 1, abandoned: 0, closed: 0 })
})

// ---- closed (HZ-143) ----

test('a closed item is hidden by default and reappears once the closed filter is toggled off', () => {
  const closed = item('C', { cursor: CLOSED_CURSOR })
  expect(visibleItems([closed], DEFAULT_ACTIVE_FILTERS, NOW)).toEqual([])
  expect(visibleItems([closed], DEFAULT_ACTIVE_FILTERS.filter((k) => k !== 'closed'), NOW)).toEqual([closed])
})

test('the final gate is visible; exactly past the last step, and beyond, are hidden', () => {
  const atFinalGate = item('GATE', { cursor: CLOSED_CURSOR - 1 })
  const justClosed = item('CLOSED', { cursor: CLOSED_CURSOR })
  const overrun = item('OVER', { cursor: CLOSED_CURSOR + 3 })

  expect(visibleItems([atFinalGate], ['closed'], NOW)).toEqual([atFinalGate])
  expect(visibleItems([justClosed], ['closed'], NOW)).toEqual([])
  expect(visibleItems([overrun], ['closed'], NOW)).toEqual([])
})

test('an in-progress item is not hidden by the closed filter', () => {
  const inFlight = item('WIP', { cursor: 5 })
  expect(visibleItems([inFlight], ['closed'], NOW)).toEqual([inFlight])
  expect(matchCounts([inFlight], NOW).closed).toBe(0)
})

test('the closed filter counts what it hides, so the header can say "Hiding N closed"', () => {
  const items = [item('C1', { cursor: CLOSED_CURSOR }), item('C2', { cursor: CLOSED_CURSOR }), item('WIP')]
  expect(hiddenCounts(items, DEFAULT_ACTIVE_FILTERS, NOW)).toEqual({ stale: 0, abandoned: 0, closed: 2 })
})

// Closed and abandoned stay independent predicates: an item abandoned at the
// final gate is abandoned, full stop — never counted in both buckets. Mirrors
// the precedence in domain/status.js's itemStatus.
test('an item abandoned at the final gate counts as abandoned only, never closed', () => {
  const abandonedAtEnd = item('AF', { cursor: CLOSED_CURSOR, abandoned_at: daysAgo(1) })
  expect(matchCounts([abandonedAtEnd], NOW)).toEqual({ stale: 0, abandoned: 1, closed: 0 })
  expect(hiddenCounts([abandonedAtEnd], ['closed'], NOW).closed).toBe(0)
  expect(visibleItems([abandonedAtEnd], ['closed'], NOW)).toEqual([abandonedAtEnd])
})

test('an item both closed and stale counts in both buckets and needs both filters off to reappear', () => {
  const both = item('CS', { cursor: CLOSED_CURSOR, last_activity_at: daysAgo(45) })
  expect(hiddenCounts([both], DEFAULT_ACTIVE_FILTERS, NOW)).toEqual({ stale: 1, abandoned: 0, closed: 1 })
  expect(visibleItems([both], ['stale'], NOW)).toEqual([])
  expect(visibleItems([both], ['closed'], NOW)).toEqual([])
  expect(visibleItems([both], [], NOW)).toEqual([both])
})

// isClosed is `item.cursor >= endIndex(kind)`, so a cursor-less object leans on
// `undefined >= N` being false. Load-bearing for every caller that hands this
// module a partially-hydrated item — make it explicit, not incidental.
test('an item with no cursor field is not treated as closed and does not throw', () => {
  const noCursor = { id: 'NC', last_activity_at: daysAgo(0) }
  expect(visibleItems([noCursor], ['closed'], NOW)).toEqual([noCursor])
  expect(matchCounts([noCursor], NOW).closed).toBe(0)
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
  expect(hiddenCounts(items, ['persona:eng'], NOW, extended)).toEqual({
    stale: 0,
    abandoned: 0,
    closed: 0,
    'persona:eng': 1,
  })
})

// ---- HZ-335: no default filter hides an item because it is blocked ----

test('a blocked item with recent activity stays visible under the default filters and counts as hidden by none', () => {
  const blocked = item('B-1', { cursor: 11, blocked: true, blockedBy: [{ id: 'B-0', title: 'Blocker', abandoned: false }] })
  const items = [blocked, item('B-2')]
  expect(visibleItems(items, DEFAULT_ACTIVE_FILTERS, NOW).map((it) => it.id)).toEqual(['B-1', 'B-2'])
  expect(Object.values(hiddenCounts(items, DEFAULT_ACTIVE_FILTERS, NOW)).every((n) => n === 0)).toBe(true)
})
