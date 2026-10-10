// HZ-373: a failed check's message, as farm/checks.py builds it, starts with
// one headline line saying what failed; the command and the digest follow.
// The step's event, the pause banner and the Autopilot ping show only that
// line. A leaf module, so orchestrator.js and caretakerActor.js can both read
// it without importing each other.

// farm/checks.py HEADLINE_PREFIX — keep the two in step.
export const CHECK_HEADLINE_PREFIX = 'repo checks failed: '
// HZ-387: farm/read_only_guard.py HEADLINE_PREFIX — a read-only step that
// changed the worktree. Its first line names the provider; every changed
// file follows. farm/tests/test_read_only_guard.py compares the two.
export const READ_ONLY_HEADLINE_PREFIX = 'read-only step changed the worktree'
// The failures whose first line is a headline and the rest its details.
const HEADLINE_PREFIXES = [CHECK_HEADLINE_PREFIX, READ_ONLY_HEADLINE_PREFIX]
const CAUSE_MAX = 200

// One line of at most `max` chars, cut at a word boundary and ending in "…" —
// never mid-word, unless the text has no space to cut at. The same rule as
// _cap_words() in farm/checks.py.
export function capWords(text, max) {
  const line = String(text).replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  let cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  if (space > 0) cut = cut.slice(0, space)
  return cut.replace(/[ ,;:.\-—]+$/, '') + '…'
}

// What failFarmRun writes for a failure: `cause` goes in the event text,
// `detail` (the whole error, unchanged) is stored beside it for "Show
// details". A check failure's (or HZ-387's read-only violation's) cause is
// its headline line only; any other error keeps today's first 200 chars and
// has no detail.
export function splitCheckError(error) {
  const text = String(error)
  if (!HEADLINE_PREFIXES.some((prefix) => text.startsWith(prefix))) return { cause: text.slice(0, CAUSE_MAX), detail: null }
  return { cause: capWords(text.split('\n')[0], CAUSE_MAX), detail: text }
}
