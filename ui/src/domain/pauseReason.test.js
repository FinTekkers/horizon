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

// ---- HZ-343: the pause event is found under newer events, and a multi-line
// cause (every check failure) parses ----

const FORWARD_REFUSED =
  'forward to “Accept the code” refused — the review still has blocking findings; “Specialist agent implements” restarts with the review findings'
const SECRETS_LINE = 'bash: scripts/checks/secrets.sh: No such file or directory'
const LS98_CAUSE = [
  'repo checks failed: ./gradlew check exited 127',
  '> Task :compileJava UP-TO-DATE',
  '> Task :test',
  SECRETS_LINE,
  'BUILD FAILED in 4s',
].join('\n')

function failurePause(cause) {
  return ev(`agent step failed: ${cause} — item paused; resume to retry`)
}

test('a pause event under two newer forward-refused events still supplies the cause', () => {
  const item = { paused: true, events: [ev(FORWARD_REFUSED), ev(FORWARD_REFUSED), failurePause('repo checks failed: eslint exited 1')] }
  const result = pauseReason(item)
  expect(result.cause).toBe('repo checks failed: eslint exited 1')
})

test('an LS-98-style multi-line Gradle cause matches the pause event and is returned whole', () => {
  const result = pauseReason({ paused: true, events: [failurePause(LS98_CAUSE)] })
  expect(result.cause).toBe(LS98_CAUSE)
  expect(result.cause).toContain(SECRETS_LINE)
})

// HZ-366: a failed check's message starts with one headline line; failFarmRun
// keeps the first 200 characters of it.
const HZ366_HEADLINE =
  'repo checks failed: e2e: 2 failed, 71 passed: tests/31-rule-block.spec.js:131 "HZ-365: the card shows the first line o…", :154 "HZ-365: Amend the rule asks for the gat…"'

test('a check failure with a headline gives a cause whose first line is the headline', () => {
  const error = `${HZ366_HEADLINE}\n(sh -c npm run test:e2e --silent)\n      47 |      VALUES (@id, @title, @priority, @desc, @metric)`
  const result = pauseReason({ paused: true, events: [failurePause(error.slice(0, 200))] })
  expect(result.cause.split('\n')[0]).toBe(HZ366_HEADLINE)
})

test('a cause that itself contains " — " still parses whole, up to the frozen suffix', () => {
  const cause = 'repo checks failed — lint step\nline two — with a dash'
  const item = {
    paused: true,
    events: [ev(`agent step failed (${REASON.TURN_CAP}): ${cause} — auto-retry budget (3) exhausted; item paused, resume to retry`)],
  }
  const result = pauseReason(item)
  expect(result.category).toBe(REASON.TURN_CAP)
  expect(result.cause).toBe(cause)
  expect(result.exhausted).toBe(true)
})

test('a 60+ line cause is cut to at most 20 lines, keeps the last line and the "No such file" line near the top', () => {
  const lines = ['repo checks failed: ./gradlew check exited 127', '> Task :a', SECRETS_LINE]
  for (let i = 0; i < 60; i++) lines.push(`> Task :module${i}:test UP-TO-DATE`)
  lines.push('BUILD FAILED in 41s')
  const result = pauseReason({ paused: true, events: [failurePause(lines.join('\n'))] })
  const shown = result.cause.split('\n')
  expect(shown.length).toBeLessThanOrEqual(20)
  expect(shown.at(-1)).toBe('BUILD FAILED in 41s')
  expect(result.cause).toContain(SECRETS_LINE)
})

test('a 60-line cause with 15 FAILED: lines still stays within 20 lines and ends with the last input line', () => {
  const lines = []
  for (let i = 0; i < 59; i++) lines.push(i % 4 === 0 ? `FAILED: test ${i}` : `ok ${i}`)
  lines.push('BUILD FAILED in 9s')
  expect(lines.filter((l) => l.includes('FAILED:')).length).toBe(15)
  const result = pauseReason({ paused: true, events: [failurePause(lines.join('\n'))] })
  const shown = result.cause.split('\n')
  expect(shown.length).toBeLessThanOrEqual(20)
  expect(shown.at(-1)).toBe('BUILD FAILED in 9s')
})

test('a pause event older than the newest "resumed work" is never shown for a later pause', () => {
  const item = { paused: true, events: [ev('some unrelated event text'), ev('resumed work'), failurePause('old cause')] }
  const result = pauseReason(item)
  expect(result.category).toBeNull()
  expect(result.cause).toBeNull()
})

test('the cause is present exactly when a pause event exists since the last resume', () => {
  const withPause = { paused: true, events: [ev(FORWARD_REFUSED), failurePause('new cause'), ev('resumed work'), failurePause('old')] }
  expect(pauseReason(withPause).cause).toBe('new cause')
  const withoutPause = { paused: true, events: [ev(FORWARD_REFUSED), ev('resumed work'), failurePause('old')] }
  expect(pauseReason(withoutPause).cause).toBeNull()
})

test('a manual pause under newer events is still recognized as manual', () => {
  const item = { paused: true, events: [ev(FORWARD_REFUSED), ev(FORWARD_REFUSED), ev('paused agent work on this item')] }
  expect(pauseReason(item).category).toBe('manual')
})

test('a non-paused item returns null even when its events hold a pause event', () => {
  expect(pauseReason({ paused: false, events: [failurePause(LS98_CAUSE)] })).toBeNull()
})

test('attempts used counts the multi-line retry events just below a pause that is not the newest event', () => {
  const item = {
    paused: true,
    events: [
      ev(FORWARD_REFUSED),
      ev(FORWARD_REFUSED),
      failurePause(LS98_CAUSE),
      ev(`transient failure (${REASON.TIMEOUT}): ${LS98_CAUSE} — auto-retrying (2/3)`),
      ev(`transient failure (${REASON.TIMEOUT}): ${LS98_CAUSE} — auto-retrying (1/3)`),
    ],
  }
  expect(pauseReason(item).attemptsUsed).toBe(2)
})

// HZ-373: a check failure's pause event carries the whole message as its
// `detail`; pauseReason hands it on as `fullError`, never as `detail` (the
// category copy).
test('the pause event detail comes back as fullError, and detail stays the category copy', () => {
  const full = 'repo checks failed: e2e failed (exit 1): a.spec.ts: 0/1 passed\n(sh -c npm run test:e2e)\ne2e: a.spec.ts: 0/1 passed'
  const tagged = { ...ev(`agent step failed (${REASON.TURN_CAP}): repo checks failed: e2e failed (exit 1): a.spec.ts: 0/1 passed — item paused; resume to retry`), detail: full }

  const result = pauseReason({ paused: true, events: [tagged] })

  expect(result.fullError).toBe(full)
  expect(result.detail).toBe('The agent hit its turn budget before finishing the step.')
  expect(pauseReason({ paused: true, events: [ev('agent step failed: boom — item paused; resume to retry')] }).fullError).toBeNull()
})
