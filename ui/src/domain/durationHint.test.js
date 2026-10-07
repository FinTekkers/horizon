// HZ-230: which estimate a card reads, and when it shows none.

import { expect, test } from 'vitest'
import { usualDurationHint } from './durationHint'
import { ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX, gateStepIndexes } from '../../../domain/js/lifecycle.js'

const NOW = Date.parse('2026-10-02T12:00:00Z')
const ago = (mins) => new Date(NOW - mins * 60_000).toISOString()
const est = (medianSec) => ({ medianSec, count: 5 })

function item(extra = {}) {
  return {
    id: 'D-1',
    cursor: IMPLEMENT_STEP_INDEX,
    paused: false,
    rejected: false,
    abandoned_at: null,
    gateAction: null,
    conflictRun: null,
    state_since: ago(12),
    ...extra,
  }
}

const running = (kind) => ({ kind, state: 'running', since: ago(12), detail: null })

// Every key populated, so a hint's absence is the card's rule, not missing data.
const ALL = {
  ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String(i), est(1200)])),
  premerge: est(300),
  resolve: est(600),
}

test('an agent step reads its own step index', () => {
  expect(usualDurationHint(item(), { [IMPLEMENT_STEP_INDEX]: est(1200) }, NOW)).toEqual({ text: 'usually ~20m', long: false })
  expect(usualDurationHint(item(), { [IMPLEMENT_STEP_INDEX]: null }, NOW)).toBeNull()
})

test('a running pre-merge or resolve at the Accept gate reads that key', () => {
  const premerge = item({ cursor: ACCEPT_GATE_INDEX, gateAction: running('premerge'), state_since: ago(3) })
  const resolve = item({ cursor: ACCEPT_GATE_INDEX, gateAction: running('resolve'), state_since: ago(3) })
  expect(usualDurationHint(premerge, ALL, NOW)).toEqual({ text: 'usually ~5m', long: false })
  expect(usualDurationHint(resolve, ALL, NOW)).toEqual({ text: 'usually ~10m', long: false })
  expect(usualDurationHint(premerge, { ...ALL, premerge: null }, NOW)).toBeNull()
  expect(usualDurationHint(resolve, { ...ALL, resolve: null }, NOW)).toBeNull()
  // A resolve standing in from conflictRun reads the same key.
  const fromConflictRun = item({ cursor: ACCEPT_GATE_INDEX, conflictRun: { state: 'running', since: ago(12) } })
  expect(usualDurationHint(fromConflictRun, ALL, NOW)).toEqual({ text: 'usually ~10m', long: false })
})

test('hours use the elapsed label form', () => {
  expect(usualDurationHint(item(), { [IMPLEMENT_STEP_INDEX]: est(3900) }, NOW)).toEqual({ text: 'usually ~1h 05m', long: false })
})

test('past twice the usual time it reads running long', () => {
  const e = { [IMPLEMENT_STEP_INDEX]: est(600) }
  expect(usualDurationHint(item({ state_since: ago(20) }), e, NOW)).toEqual({ text: 'usually ~10m', long: false })
  expect(usualDurationHint(item({ state_since: ago(21) }), e, NOW)).toEqual({ text: 'running long', long: true })
})

test('the human gates are 3, 5, 10, 13 and 15', () => {
  expect(gateStepIndexes()).toEqual([3, 5, 10, 13, 15])
})

test.each([3, 5, 10, 13, 15])('a gate waiting on a human (%i) never shows a hint', (cursor) => {
  expect(usualDurationHint(item({ cursor, state_since: ago(500) }), ALL, NOW)).toBeNull()
})

test('a gate action that is queued, finished or of an unknown kind shows no hint', () => {
  for (const gateAction of [
    { kind: 'premerge', state: 'queued', since: ago(1) },
    { kind: 'premerge', state: 'failed', since: ago(1) },
    { kind: 'resolve', state: 'resolved', since: ago(1) },
    { kind: 'constructor', state: 'running', since: ago(1) },
    { kind: '13', state: 'running', since: ago(1) },
  ]) {
    expect(usualDurationHint(item({ cursor: ACCEPT_GATE_INDEX, gateAction }), ALL, NOW)).toBeNull()
  }
})

test('malformed estimates degrade to no hint and never throw', () => {
  const k = String(IMPLEMENT_STEP_INDEX)
  for (const estimates of [
    undefined,
    null,
    'nope',
    42,
    {},
    { [k]: 'x' },
    { [k]: {} },
    { [k]: { medianSec: '1200' } },
    { [k]: { medianSec: NaN } },
    { [k]: { medianSec: Infinity } },
    { [k]: { medianSec: 0 } },
    { [k]: { medianSec: -60 } },
    { [k]: { medianSec: 30 } },
  ]) {
    expect(usualDurationHint(item(), estimates, NOW)).toBeNull()
  }
  expect(usualDurationHint(item({ state_since: 'not a date' }), ALL, NOW)).toBeNull()
  expect(usualDurationHint(item({ state_since: null }), ALL, NOW)).toBeNull()
  // An inherited key is not an estimate.
  expect(usualDurationHint(item(), Object.create({ [k]: est(1200) }), NOW)).toBeNull()
})

test('paused, rejected, abandoned and closed items show no hint', () => {
  expect(usualDurationHint(item({ paused: true }), ALL, NOW)).toBeNull()
  expect(usualDurationHint(item({ rejected: true }), ALL, NOW)).toBeNull()
  expect(usualDurationHint(item({ abandoned_at: '2026-10-02 11:00:00' }), ALL, NOW)).toBeNull()
  expect(usualDurationHint(item({ cursor: 99 }), ALL, NOW)).toBeNull()
})

// HZ-335: nothing runs while a dependency holds the item up.
test('a dependency-blocked item gets no hint, even long past its usual time', () => {
  expect(usualDurationHint(item({ blocked: true }), ALL, NOW)).toBeNull()
  expect(usualDurationHint(item({ blocked: true, state_since: ago(600) }), ALL, NOW)).toBeNull()
  expect(usualDurationHint(item({ blocked: false }), ALL, NOW)).not.toBeNull()
})
