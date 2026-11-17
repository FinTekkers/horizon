// HO-851: the design verdict "Define how we measure success" records for an
// item whose snapshot has a design sub-step, and the what-changed note a later
// design round writes — the contract between the farm, which asks for them
// (farm/roles/design_verdict_addendum.md, farm/step_agent.py), and the
// server, which reads them (server/src/designRounds.js).
//
// The verdict is one line of the step's artifact:
//
//   design_needed: no — backend only, no screen changes
//
// `yes` or `no`, then a one-line reason after `—`, `–`, `-` or `:`. A list
// marker, a quote marker or bold markup around the line is ignored, since
// agents format their output. Anything else is unreadable: no line, two or
// more lines, no reason, or a reason over VERDICT_REASON_MAX_CHARS. The
// caller never skips on an unreadable verdict.
//
// Pure: no I/O. The server and the tests import it.

export const VERDICT_KEY = 'design_needed'
export const WHAT_CHANGED_KEY = 'what_changed'
export const VERDICT_REASON_MAX_CHARS = 200
export const WHAT_CHANGED_MAX_CHARS = 500

// A line with its list or quote marker and bold/italic markup removed.
function plainLine(line) {
  return line
    .replace(/\r$/, '')
    .trim()
    .replace(/^(?:[-*+>]\s+)+/, '')
    .replace(/\*\*|__/g, '')
    .trim()
}

const VERDICT_LINE = new RegExp(`^${VERDICT_KEY}\\s*:\\s*(.*)$`, 'i')
const VERDICT_BODY = /^(yes|no)\b\s*(?:[—–:-]\s*(.*))?$/i

// { needed: boolean, reason: string, line: string } or { unreadable: string }.
export function parseDesignVerdict(artifactMd) {
  if (typeof artifactMd !== 'string') return { unreadable: 'no step artifact' }
  const lines = artifactMd
    .split('\n')
    .map(plainLine)
    .filter((line) => VERDICT_LINE.test(line))
  if (lines.length === 0) return { unreadable: `no ${VERDICT_KEY} line` }
  if (lines.length > 1) return { unreadable: `${lines.length} ${VERDICT_KEY} lines` }
  const body = VERDICT_BODY.exec(VERDICT_LINE.exec(lines[0])[1].trim())
  if (!body) return { unreadable: `${VERDICT_KEY} is not yes or no` }
  const reason = (body[2] ?? '').trim()
  if (!reason) return { unreadable: `${VERDICT_KEY} has no reason` }
  if (reason.length > VERDICT_REASON_MAX_CHARS) return { unreadable: `${VERDICT_KEY} reason is over ${VERDICT_REASON_MAX_CHARS} characters` }
  return { needed: body[1].toLowerCase() === 'yes', reason, line: lines[0] }
}

const WHAT_CHANGED_LINE = new RegExp(`^${WHAT_CHANGED_KEY}\\s*:\\s*(.+)$`, 'i')

// The first `what_changed: <line>` of a design round's artifact, or null.
export function parseWhatChanged(artifactMd) {
  if (typeof artifactMd !== 'string') return null
  for (const raw of artifactMd.split('\n')) {
    const match = WHAT_CHANGED_LINE.exec(plainLine(raw))
    const text = match?.[1].trim()
    if (text) return text.slice(0, WHAT_CHANGED_MAX_CHARS)
  }
  return null
}
