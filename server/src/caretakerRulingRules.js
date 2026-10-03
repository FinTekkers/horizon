// The Autopilot caretaker's ruling checks (HZ-273). Pure: no I/O, no clock,
// no store — like caretakerRules.js.
//
// A ruling is the caretaker's answer to an `Operator must decide:` line: it
// rewords named lines of the item's `metric` or `guardrails`. The model only
// PROPOSES one; validateRuling() decides, in code, before anything is written.
// Every check fails closed: a ruling this cannot prove safe is rejected and the
// item is left for the human. spliceIssueBody() is the one place an accepted
// ruling's lines are swapped into the GitHub issue body; github.js calls it.
//
// lineKey() is the ONE line comparison, used both against the parsed field
// text (validateRuling) and against the raw issue body (spliceIssueBody), so
// the two can never disagree on CRLF or surrounding whitespace.

import { FIELDS, fieldByName } from '../../domain/js/fields.js'

// 273-2 adds 'defer'. Until then a defer proposal is rejected, fail closed.
export const RULING_KINDS = ['narrow', 'clarify', 'restore']
export const RULING_FIELDS = ['metric', 'guardrails']
// The issue-body heading each field lives under, as store.parseIssueBody reads it.
const FIELD_HEADINGS = { metric: 'success metric', guardrails: 'guardrails' }
export const MAX_EDITS = 5
// A narrow/clarify may add at most this many characters to a line.
export const CLARIFY_GROWTH_MAX = 120

// Words whose loss weakens a rule. Each one's count may never drop.
const MODALS = ['never', 'must', 'always', 'only', 'do not', "don't", 'cannot', 'shall']
// A line that touches any of these is never ruled on (guardrail: fail closed).
const SECURITY_LINE =
  /\b(auth\w*|oauth\w*|secrets?|tokens?|sudo\w*|pins?|passwords?|passphrases?|credentials?|deploy\w*|gate[ -]?keys?|webhooks?|api[ -]?keys?|ssh|private[ -]keys?|security)\b/i
const GH_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/
const SECRET_ENV = ['GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'WA_APPROVAL_SECRET']
const LIST_MARKER = /^([-*+]|\d+[.)])(\s+|$)/
const TRUNCATION = /\s*(…|\.\.\.)$/

// Byte-exact: '\r' stays on its line, so a CRLF body joins back unchanged.
export const fieldLines = (text) => String(text ?? '').split('\n')
export const lineKey = (line) => String(line ?? '').trim()

export const isSecurityLine = (line) => SECURITY_LINE.test(String(line ?? ''))

const countOf = (text, word) => (String(text).match(new RegExp(`(^|[^a-z'])${word}(?![a-z])`, 'gi')) || []).length
const markerOf = (line) => LIST_MARKER.exec(line)?.[1] ?? ''
const contentOf = (line) => line.replace(LIST_MARKER, '').trim()
const containsSecret = (text, env) =>
  GH_TOKEN.test(text) || SECRET_ENV.some((key) => env[key] && env[key].length >= 4 && text.includes(env[key]))

const reject = (code, detail) => ({ ok: false, code, detail })

// proposal: { kind, reason, edits: [{ field, before, after }] } as the model
// returned it, or { unsure: true }. current: the item's { metric, guardrails }
// as parsed from the issue body. Returns { ok: true, kind, reason, edits, next }
// — edits carry the matched current line as `before` and the trimmed `after`,
// next is each field's full text with the edits applied — or
// { ok: false, code, detail }, in which case nothing may be written.
export function validateRuling(proposal, current, fields = FIELDS, env = process.env) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return reject('bad_proposal', 'not an object')
  if (proposal.unsure === true) return reject('unsure', 'the caretaker was not sure')
  if (proposal.kind === 'defer') return reject('defer_not_enabled', 'deferring scope is not enabled yet')
  if (!RULING_KINDS.includes(proposal.kind)) return reject('bad_kind', `kind must be one of ${RULING_KINDS.join(', ')}`)
  const reason = typeof proposal.reason === 'string' ? proposal.reason.trim() : ''
  if (!reason) return reject('no_reason', 'a ruling needs a reason')
  const edits = proposal.edits
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > MAX_EDITS) {
    return reject('bad_edits', `a ruling edits 1 to ${MAX_EDITS} lines`)
  }

  const next = {}
  for (const field of RULING_FIELDS) next[field] = fieldLines(current?.[field])
  const touched = new Set()
  const accepted = []
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') return reject('bad_edits', 'an edit is not an object')
    const { field, before, after } = edit
    if (!RULING_FIELDS.includes(field)) return reject('bad_field', 'a ruling edits only metric or guardrails')
    if (typeof before !== 'string' || typeof after !== 'string') return reject('bad_edits', 'before and after must be text')
    if (/[\r\n]/.test(after)) return reject('adds_lines', 'a ruling may not add lines')
    const lines = next[field]
    const matches = lineKey(before) ? lines.flatMap((line, i) => (lineKey(line) === lineKey(before) ? [i] : [])) : []
    if (matches.length === 0) return reject('before_not_found', `no ${field} line reads "${before}"`)
    if (matches.length > 1) return reject('before_ambiguous', `more than one ${field} line reads "${before}"`)
    const at = matches[0]
    if (touched.has(`${field}:${at}`)) return reject('before_ambiguous', 'one line is edited twice')
    touched.add(`${field}:${at}`)
    const was = lineKey(lines[at])
    const now = lineKey(after)
    if (now === was) return reject('no_change', 'the edit changes nothing')
    if (!contentOf(now)) return reject(field === 'guardrails' ? 'removes_guardrail' : 'removes_line', `a ruling may not empty a ${field} line`)
    if (markerOf(now) !== markerOf(was)) return reject('marker_changed', 'a ruling keeps the line\'s list marker')
    for (const word of MODALS) {
      if (countOf(now, word) < countOf(was, word)) return reject('weakens_rule', `the edit drops "${word}"`)
    }
    if (isSecurityLine(was) || isSecurityLine(now)) return reject('security_line', 'a line about auth, secrets, sudoers, deploys or the PIN is left for the human')
    if (proposal.kind === 'restore') {
      const base = was.replace(TRUNCATION, '')
      if (!base || now.length <= base.length || !now.startsWith(base)) return reject('not_a_restore', 'a restore must extend the cut line')
    } else if (now.length > was.length + CLARIFY_GROWTH_MAX) {
      return reject('too_long_for_clarify', `a ${proposal.kind} may add at most ${CLARIFY_GROWTH_MAX} characters to a line`)
    }
    if (containsSecret(now, env)) return reject('secret_in_text', 'the edit contains a token')
    // The line keeps its own indentation; only its text changes.
    lines[at] = lines[at].match(/^[ \t]*/)[0] + now
    accepted.push({ field, before: was, after: now })
  }

  const result = {}
  for (const field of RULING_FIELDS) {
    result[field] = next[field].join('\n')
    // Never truncated to fit: an over-budget ruling is rejected whole.
    const { maxLength } = fieldByName(field, fields)
    if (result[field].length > maxLength) return reject('over_budget', `${field} would be ${result[field].length} characters (budget ${maxLength})`)
  }
  return { ok: true, kind: proposal.kind, reason, edits: accepted, next: result }
}

// The issue body with each edit's line swapped, every other byte unchanged —
// line endings included. Each `before` must match exactly one line inside its
// own field's `## ` section; anything else (the body changed since the ruling
// was checked, a heading appears twice) is { ok: false, code: 'stale_body' }.
export function spliceIssueBody(body, edits) {
  const lines = fieldLines(body)
  const sections = {}
  let open = null
  lines.forEach((line, i) => {
    const heading = /^##\s/.test(line) ? line.replace(/^##\s+/, '').trim().toLowerCase() : null
    if (heading === null) return
    if (open) open.end = i
    const field = Object.keys(FIELD_HEADINGS).find((f) => FIELD_HEADINGS[f] === heading)
    open = null
    if (!field) return
    if (Object.hasOwn(sections, field)) sections[field].duplicate = true
    else sections[field] = open = { start: i + 1, end: lines.length }
  })
  for (const edit of edits) {
    const section = Object.hasOwn(sections, edit.field) ? sections[edit.field] : null
    if (!section || section.duplicate) return reject('stale_body', `the issue body has no single ${edit.field} section`)
    const matches = []
    for (let i = section.start; i < section.end; i++) if (lineKey(lines[i]) === lineKey(edit.before)) matches.push(i)
    if (matches.length !== 1) return reject('stale_body', `the ${edit.field} line "${edit.before}" is no longer in the issue body`)
    const raw = lines[matches[0]]
    lines[matches[0]] = raw.match(/^[ \t]*/)[0] + lineKey(edit.after) + (raw.endsWith('\r') ? '\r' : '')
  }
  return { ok: true, body: lines.join('\n') }
}
