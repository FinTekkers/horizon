// pauseReason() is the only place that parses the orchestrator's free-text
// pause event (server/src/orchestrator.js's failFarmRun) into something the
// tracker banner can render — HZ-94's fix stops discarding the classified
// failure reason, this proves the UI actually reads it back out.

import { expect, test } from 'vitest'
import { pauseReason } from './pauseReason'

function ev(text) {
  return { text, created_at: '2026-01-01 00:00:00' }
}

test('a non-paused item returns null — no banner outside the paused state', () => {
  expect(pauseReason({ paused: false, events: [] })).toBeNull()
})

for (const [reason, label] of [
  ['never_picked_up', 'Never picked up'],
  ['timeout', 'Timed out'],
  ['unreachable', 'Farm unreachable'],
  ['turn_cap', 'Ran out of turns'],
]) {
  test(`a ${reason} pause resolves its own distinct label`, () => {
    const item = {
      paused: true,
      events: [ev(`agent step failed (${reason}): something went wrong — item paused; resume to retry`)],
    }
    const result = pauseReason(item)
    expect(result.category).toBe(reason)
    expect(result.label).toBe(label)
    expect(result.cause).toBe('something went wrong')
    expect(result.exhausted).toBe(false)
  })
}

test('the four named categories all render distinct labels from one another', () => {
  const labels = new Set(
    ['never_picked_up', 'timeout', 'unreachable', 'turn_cap'].map(
      (reason) =>
        pauseReason({
          paused: true,
          events: [ev(`agent step failed (${reason}): x — item paused; resume to retry`)],
        }).label,
    ),
  )
  expect(labels.size).toBe(4)
})

test('a turn_cap failure whose retry budget is exhausted is flagged exhausted, with the cause preserved', () => {
  const item = {
    paused: true,
    events: [ev('agent step failed (turn_cap): ran out of turns — auto-retry budget (3) exhausted; item paused, resume to retry')],
  }
  const result = pauseReason(item)
  expect(result.category).toBe('turn_cap')
  expect(result.exhausted).toBe(true)
  expect(result.cause).toBe('ran out of turns')
})

test('an unrecognized reason degrades to the raw cause, not a blank banner and not the raw token treated as a friendly label', () => {
  const item = {
    paused: true,
    events: [ev('agent step failed (not_a_real_reason): something odd happened — item paused; resume to retry')],
  }
  const result = pauseReason(item)
  expect(result.category).toBe('not_a_real_reason')
  expect(result.label).toBeNull()
  expect(result.cause).toBe('something odd happened')
})

test('a pause with no classified reason (checks-failed, or any untagged failure) has no category, but keeps the real cause', () => {
  const item = {
    paused: true,
    events: [ev('agent step failed: repo checks failed: eslint exited 1 — item paused; resume to retry')],
  }
  const result = pauseReason(item)
  expect(result.category).toBeNull()
  expect(result.label).toBeNull()
  expect(result.cause).toBe('repo checks failed: eslint exited 1')
  expect(result.exhausted).toBe(false)
})

test('a paused item whose newest event matches nothing recognizable still returns a non-null, non-throwing result', () => {
  const item = { paused: true, events: [ev('some unrelated event text')] }
  const result = pauseReason(item)
  expect(result).not.toBeNull()
  expect(result.category).toBeNull()
  expect(result.cause).toBeNull()
})

test('a paused item with no events at all still returns a non-null result, never throws', () => {
  expect(pauseReason({ paused: true, events: [] })).not.toBeNull()
  expect(pauseReason({ paused: true })).not.toBeNull()
})

test('a human-initiated manual pause is recognized as its own category, not misparsed as a failure', () => {
  const item = { paused: true, events: [ev('paused agent work on this item')] }
  const result = pauseReason(item)
  expect(result.category).toBe('manual')
  expect(result.cause).toBeNull()
})

test('attempts used counts the consecutive auto-retry events immediately preceding this pause', () => {
  const item = {
    paused: true,
    events: [
      ev('agent step failed: checks failed — item paused; resume to retry'),
      ev('transient failure (unreachable): could not reach the farm — auto-retrying (2/3)'),
      ev('transient failure (timeout): step timed out — auto-retrying (1/3)'),
    ],
  }
  const result = pauseReason(item)
  expect(result.category).toBeNull()
  expect(result.attemptsUsed).toBe(2)
})

test('attempts used is 0 when the pause event has no preceding auto-retry events', () => {
  const item = {
    paused: true,
    events: [ev('agent step failed (timeout): step timed out — item paused; resume to retry')],
  }
  expect(pauseReason(item).attemptsUsed).toBe(0)
})

test('attempts used stops counting at the first non-retry event, not the whole history', () => {
  const item = {
    paused: true,
    events: [
      ev('agent step failed (turn_cap): ran out of turns — auto-retry budget (3) exhausted; item paused, resume to retry'),
      ev('transient failure (turn_cap): ran out of turns — auto-retrying (3/3)'),
      ev('transient failure (turn_cap): ran out of turns — auto-retrying (2/3)'),
      ev('transient failure (turn_cap): ran out of turns — auto-retrying (1/3)'),
      ev('resumed work'),
      ev('transient failure (timeout): older episode — auto-retrying (1/3)'),
    ],
  }
  expect(pauseReason(item).attemptsUsed).toBe(3)
})
