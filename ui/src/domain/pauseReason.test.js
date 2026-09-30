// pauseReason() is the only place that parses the orchestrator's free-text
// pause event (server/src/orchestrator.js's failFarmRun) into something the
// tracker banner can render — HZ-94's fix stops discarding the classified
// failure reason, this proves the UI actually reads it back out.
//
// HZ-132: every reason id below comes from domain/js/reasons.js, so a rename in
// domain/reasons.json reaches this file instead of leaving a stale literal
// asserting a banner nobody renders any more. The LABELS stay hand-typed — they
// are presentation, owned by pauseReason.js, and pinning them by hand is the
// point.

import { expect, test } from 'vitest'
import { REASON, REASON_IDS } from '../../../domain/js/reasons.js'
import { pauseReason } from './pauseReason'

function ev(text) {
  return { text, created_at: '2026-01-01 00:00:00' }
}

function pausedWith(reason, cause = 'x') {
  return { paused: true, events: [ev(`agent step failed (${reason}): ${cause} — item paused; resume to retry`)] }
}

test('a non-paused item returns null — no banner outside the paused state', () => {
  expect(pauseReason({ paused: false, events: [] })).toBeNull()
})

for (const [reason, label] of [
  [REASON.NEVER_PICKED_UP, 'Never picked up'],
  [REASON.TIMEOUT, 'Timed out'],
  [REASON.UNREACHABLE, 'Farm unreachable'],
  [REASON.TURN_CAP, 'Ran out of turns'],
]) {
  test(`a ${reason} pause resolves its own distinct label`, () => {
    const result = pauseReason(pausedWith(reason, 'something went wrong'))
    expect(result.category).toBe(reason)
    expect(result.label).toBe(label)
    expect(result.cause).toBe('something went wrong')
    expect(result.exhausted).toBe(false)
  })
}

// HZ-132 success criterion 5, driven through the real function rather than
// through an exported copy map: every reason domain/reasons.json declares must
// reach a banner with copy. This also proves PAUSE_EVENT_RE's `[^)]+` capture
// extracts each id, which a plain map lookup would not.
test('EVERY reason declared in domain/reasons.json has pause-banner copy — none is unmapped', () => {
  expect(REASON_IDS.length).toBeGreaterThan(0)
  for (const id of REASON_IDS) {
    const result = pauseReason(pausedWith(id))
    expect(result.category, `${id} did not round-trip through the pause event`).toBe(id)
    expect(result.label, `${id} has no banner title`).not.toBeNull()
    expect(result.detail, `${id} has no banner detail`).not.toBeNull()
  }
})

test('every declared reason renders a label distinct from every other', () => {
  const labels = new Set(REASON_IDS.map((id) => pauseReason(pausedWith(id)).label))
  expect(labels.size).toBe(REASON_IDS.length)
})

// HZ-105: a required artifact the budget allocator had to truncate stops
// the step from ever dispatching — server/src/orchestrator.js's
// missingRequiredInputs/failFarmRun tags this pause REQUIRED_INPUT_INCOMPLETE.
// This is the only place a human actually sees the artifact name and
// shortfall the gate names in its cause text.
test(`a ${REASON.REQUIRED_INPUT_INCOMPLETE} pause names the artifact, its size, and the shortfall`, () => {
  const item = {
    paused: true,
    events: [
      ev(
        `agent step failed (${REASON.REQUIRED_INPUT_INCOMPLETE}): required input incomplete: "Draft implementation plan" needs 40000 chars, only 20034 could be supplied (19966 short) — item paused; resume to retry`,
      ),
    ],
  }
  const result = pauseReason(item)
  expect(result.category).toBe(REASON.REQUIRED_INPUT_INCOMPLETE)
  expect(result.label).toBe('Required input incomplete')
  expect(result.detail).toMatch(/capacity limit, not a bug/)
  expect(result.cause).toMatch(/"Draft implementation plan" needs 40000 chars, only 20034 could be supplied \(19966 short\)/)
  expect(result.exhausted).toBe(false)
})

test(`a ${REASON.TURN_CAP} failure whose retry budget is exhausted is flagged exhausted, with the cause preserved`, () => {
  const item = {
    paused: true,
    events: [
      ev(
        `agent step failed (${REASON.TURN_CAP}): ran out of turns — auto-retry budget (3) exhausted; item paused, resume to retry`,
      ),
    ],
  }
  const result = pauseReason(item)
  expect(result.category).toBe(REASON.TURN_CAP)
  expect(result.exhausted).toBe(true)
  expect(result.cause).toBe('ran out of turns')
})

test('an unrecognized reason degrades to the raw cause, not a blank banner and not the raw token treated as a friendly label', () => {
  const result = pauseReason(pausedWith('not_a_real_reason', 'something odd happened'))
  expect(result.category).toBe('not_a_real_reason')
  expect(result.label).toBeNull()
  expect(result.cause).toBe('something odd happened')
})

// HZ-132: CATEGORY_COPY is a plain object literal, so a lookup by a reason that
// happens to name an Object.prototype member used to resolve truthy and render
// `undefined` as the banner title. Fixed with Object.hasOwn; pinned here.
for (const prototypeKey of ['constructor', 'toString', 'hasOwnProperty']) {
  test(`a pause tagged "${prototypeKey}" degrades like any other unknown reason, not to an undefined title`, () => {
    const result = pauseReason(pausedWith(prototypeKey, 'something odd happened'))
    expect(result.category).toBe(prototypeKey)
    expect(result.label).toBeNull()
    expect(result.detail).toBeNull()
    expect(result.cause).toBe('something odd happened')
  })
}

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
      ev(`transient failure (${REASON.UNREACHABLE}): could not reach the farm — auto-retrying (2/3)`),
      ev(`transient failure (${REASON.TIMEOUT}): step timed out — auto-retrying (1/3)`),
    ],
  }
  const result = pauseReason(item)
  expect(result.category).toBeNull()
  expect(result.attemptsUsed).toBe(2)
})

test('attempts used is 0 when the pause event has no preceding auto-retry events', () => {
  expect(pauseReason(pausedWith(REASON.TIMEOUT, 'step timed out')).attemptsUsed).toBe(0)
})

test('attempts used stops counting at the first non-retry event, not the whole history', () => {
  const item = {
    paused: true,
    events: [
      ev(
        `agent step failed (${REASON.TURN_CAP}): ran out of turns — auto-retry budget (3) exhausted; item paused, resume to retry`,
      ),
      ev(`transient failure (${REASON.TURN_CAP}): ran out of turns — auto-retrying (3/3)`),
      ev(`transient failure (${REASON.TURN_CAP}): ran out of turns — auto-retrying (2/3)`),
      ev(`transient failure (${REASON.TURN_CAP}): ran out of turns — auto-retrying (1/3)`),
      ev('resumed work'),
      ev(`transient failure (${REASON.TIMEOUT}): older episode — auto-retrying (1/3)`),
    ],
  }
  expect(pauseReason(item).attemptsUsed).toBe(3)
})
