// HZ-803: domain/js/runTime.js, the "5 Nov 20:06 · 20 h ago" text on step
// cards and the artifact/output pages. Every case passes its own clock and
// timezone, so the host's zone never changes the result.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseStoredUtc, runTimeText } from '../../domain/js/runTime.js'

const NOW = Date.parse('2026-11-06T16:06:00Z')

test('parseStoredUtc reads the stored "YYYY-MM-DD HH:MM:SS" as UTC, and ISO as given', () => {
  assert.equal(parseStoredUtc('2026-11-05 20:06:00'), Date.parse('2026-11-05T20:06:00Z'))
  assert.equal(parseStoredUtc('2026-11-05T20:06:00Z'), Date.parse('2026-11-05T20:06:00Z'))
})

test('parseStoredUtc is null for a missing or unreadable value', () => {
  for (const value of [null, undefined, '', 'not a time', 42]) assert.equal(parseStoredUtc(value), null)
})

test('runTimeText gives the absolute time in the given zone plus a relative time', () => {
  assert.equal(runTimeText('2026-11-05 20:06:00', NOW, 'UTC'), '5 Nov 20:06 · 20 h ago')
  // 6 Nov is after the UK's clocks went back, so London is UTC+0 …
  assert.equal(runTimeText('2026-11-05 20:06:00', NOW, 'Europe/London'), '5 Nov 20:06 · 20 h ago')
  // … New York is UTC-5. The relative part does not depend on the zone.
  assert.equal(runTimeText('2026-11-05 20:06:00', NOW, 'America/New_York'), '5 Nov 15:06 · 20 h ago')
  // Summer time: London is UTC+1.
  assert.equal(runTimeText('2026-07-01 08:00:00', NOW, 'Europe/London'), '1 Jul 09:00 · 128 d ago')
})

test('runTimeText relative bands: just now, minutes, hours, days', () => {
  const at = (msAgo) => new Date(NOW - msAgo).toISOString()
  const rel = (msAgo) => runTimeText(at(msAgo), NOW, 'UTC').split(' · ')[1]
  assert.equal(rel(30_000), 'just now')
  assert.equal(rel(60_000), '1 min ago')
  assert.equal(rel(59 * 60_000), '59 min ago')
  assert.equal(rel(60 * 60_000), '1 h ago')
  assert.equal(rel(23 * 3600_000 + 59 * 60_000), '23 h ago')
  assert.equal(rel(24 * 3600_000), '1 d ago')
  // Clock skew: a time ahead of the viewer's clock reads "just now".
  assert.equal(rel(-5 * 60_000), 'just now')
})

test('runTimeText adds the year only when it is not the current one', () => {
  assert.equal(runTimeText('2025-11-05 20:06:00', NOW, 'UTC'), '5 Nov 2025 20:06 · 365 d ago')
})

test('runTimeText is null with no stored time', () => {
  assert.equal(runTimeText(null, NOW, 'UTC'), null)
  assert.equal(runTimeText('garbage', NOW, 'UTC'), null)
})
