// The caretaker's decision rules (HZ-270). Pure: no I/O, no clock, no store.
//
// THE POLICY IS farm/roles/caretaker.md, NOT THIS FILE. Its fenced
// `caretaker-rules` block names each rule, its gate, its decision and every
// marker or pattern it matches on. This file holds one evaluator per rule id
// and nothing else: an evaluator reads its markers off the rule it is handed,
// so editing a marker in the role file changes behaviour with no code edit.
// A rule with no evaluator fails parsePolicy; an evaluator with no rule fails
// the parity test.

import { requiredStepIndex } from '../../domain/js/lifecycle.js'

export const DECISIONS = {
  approve: 'approve',
  send_back: 'send back with comment',
  resolve_conflicts: 'resolve conflicts',
  wait: 'wait',
  ping_human: 'ping the human',
}

// Who the caretaker's gate actions are decided_by (HZ-271). Lives here, not in
// caretakerActor.js, so caretaker.js can read it without an import cycle.
export const ACTOR = 'Caretaker'

const REASON_MAX = 200

// The non-blank lines of one `## Heading` section, up to the next heading of
// the same or higher level, indentation kept. [] when the section is absent.
function section(text, heading) {
  if (typeof text !== 'string' || !heading) return []
  const lines = text.split('\n').map((l) => l.trimEnd())
  const start = lines.findIndex((l) => l.trim() === heading || l.trim().startsWith(`${heading} `))
  if (start === -1) return []
  const level = heading.match(/^#+/)[0].length
  const end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l.trim()) && l.trim().match(/^#+/)[0].length <= level)
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((l) => l.trim())
}

// Top-level list items (`- x`, `* x`, `1. x`) with the marker stripped.
const LIST_ITEM = /^([-*]|\d+\.)\s+/
const bullets = (lines) => lines.filter((l) => LIST_ITEM.test(l)).map((l) => l.replace(LIST_ITEM, ''))

const firstSentence = (s) => s.replace(/\*\*/g, '').trim()

// Quoted spans are examples, not recommendations. Each is matched on one line
// only, so an unclosed quote cannot swallow the text after it. A `'` opens a
// span only at a word start, so the apostrophe in "don't" survives.
const QUOTED = [/`[^`\n]*`/g, /"[^"\n]*"/g, /“[^”\n]*”/g, /‘[^’\n]*’/g, /(?<!\w)'[^'\n]*'/g]

// HZ-299: the sentences of some section lines, bold, quotes and leading list
// markers stripped. A line that is wholly one code span is unwrapped first, so
// `Recommended option: A` written as code still counts.
function sentences(lines) {
  return lines
    .map((l) => l.replace(/\*\*/g, '').trim().replace(/^(?:(?:[-*+>]|\d+[.)])\s+)+/, ''))
    .map((l) => l.replace(/^`([^`]*)`$/, '$1'))
    .map((l) => QUOTED.reduce((s, re) => s.replace(re, ' '), l))
    .flatMap((l) => l.split(/(?<=[.!?;])\s+/))
    .map((s) => s.trim())
    .filter(Boolean)
}

// Every line of `text` that starts with the rule's linePrefix, list markers
// and bold stripped. HZ-273's ruling step reads the whole request through this.
export function operatorDecideLines(rule, text) {
  const prefix = rule.linePrefix.toLowerCase()
  return String(text || '')
    .split('\n')
    .map((raw) => raw.trim().replace(/^[-*>#\s]+/, '').replace(/\*\*/g, '').trim())
    .filter((line) => line.toLowerCase().startsWith(prefix))
}

export const EVALUATORS = {
  'any.operator_decide': (rule, facts) => {
    const [line] = operatorDecideLines(rule, facts.artifact)
    return line ? { reason: `ruling needed: ${line.slice(rule.linePrefix.length).trim()}` } : null
  },
  'g5.blocker': (rule, facts) => {
    const open = bullets(section(facts.artifact, rule.section)).filter(
      (b) => !/^\[x\]/i.test(b) && !/^none\b/i.test(firstSentence(b)),
    )
    if (open.length === 0) return null
    return { reason: `open blocker: ${firstSentence(open[0])}`, comment: open.map((b) => `- ${b}`).join('\n') }
  },
  // Exactly one option letter, from non-negated sentences, approves. None or
  // two different letters fall through to ping_human: never guess.
  'g5.approve': (rule, facts) => {
    const negations = rule.negations.map((n) => new RegExp(n, 'i'))
    const letters = new Set()
    for (const sentence of sentences(section(facts.artifact, rule.section))) {
      if (negations.some((re) => re.test(sentence))) continue
      for (const pattern of rule.patterns) {
        for (const m of sentence.matchAll(new RegExp(pattern, 'g'))) letters.add(m[1])
      }
    }
    return letters.size === 1 ? { reason: `recommended option ${[...letters][0]}` } : null
  },
  'g10.send_back': (rule, facts) => {
    const verdict = section(facts.artifact, rule.section).join('\n')
    const marker = rule.markers.find((m) => verdict.includes(m))
    if (!marker) return null
    // The whole action list verbatim, sub-bullets included, is the comment.
    const actions = section(facts.artifact, rule.commentSection)
    return {
      reason: `PM said ${marker.replace(/\*\*/g, '')}; ${bullets(actions).length} action(s), full comment stored with this decision`,
      comment: actions.join('\n') || null,
    }
  },
  'g10.approve': (rule, facts) => {
    const verdict = section(facts.artifact, rule.section).join('\n')
    const marker = rule.markers.find((m) => verdict.includes(m))
    return marker ? { reason: `PM said ${marker.replace(/\*\*/g, '')}` } : null
  },
  // Advisory only (the "would …" event). What the caretaker DOES at gate 13 is
  // decideAcceptGate() in caretakerAccept.js — keep the two in step.
  'g13.wait': (rule, facts) => {
    const kind = rule.kinds.find((k) => (facts.runningKinds || []).includes(k))
    return kind ? { reason: `a ${kind} run is in progress` } : null
  },
  'g13.conflicts': (rule, facts) =>
    facts.mergeable === rule.mergeable ? { reason: 'the PR does not merge cleanly' } : null,
  'g13.approve': (rule, facts) =>
    facts.review === rule.review && facts.mergeable === rule.mergeable
      ? { reason: 'automated review passed and the PR merges cleanly' }
      : null,
  // HZ-333: a deploy queue batch went live with this item's merge in it. A
  // later batch moving last-good-tag does not undo that.
  'g15.approve': (rule, facts) =>
    facts.batch?.live
      ? {
          reason: `release ${facts.batch.tag} at ${facts.batch.commit.slice(0, 7)} is live; merge ${facts.batch.mergeSha.slice(0, 7)} is an ancestor of it`,
        }
      : facts.releaseTag && facts.releaseTag === facts.lastGoodTag
        ? { reason: `release ${facts.releaseTag} is the target's last-good deploy` }
        : null,
  'g15.ping': () => ({ reason: 'no last-good deploy of this release on record' }),
}

// Text of the role file -> { rules }. Throws on anything malformed; the
// caller turns that into a 'wait' decision rather than a crash.
export function parsePolicy(text) {
  const block = /```caretaker-rules\n([\s\S]*?)\n```/.exec(String(text ?? ''))
  if (!block) throw new Error('caretaker policy has no caretaker-rules block')
  const { rules } = JSON.parse(block[1])
  if (!Array.isArray(rules) || rules.length === 0) throw new Error('caretaker policy has no rules')
  return {
    rules: rules.map((rule) => {
      if (!Object.hasOwn(EVALUATORS, rule.id)) throw new Error(`caretaker rule ${rule.id} has no evaluator`)
      if (!Object.hasOwn(DECISIONS, rule.decision)) throw new Error(`caretaker rule ${rule.id} has an unknown decision`)
      return { ...rule, gateIndex: rule.gate === 'any' ? null : requiredStepIndex(rule.gate) }
    }),
  }
}

// HZ-298: every env var whose NAME looks secret ($GOOGLE_CLIENT_SECRET, any
// *_TOKEN, …) is redacted too. The names are scanned once, on first use;
// their values are still read at call time. Short values (under 8 chars)
// would redact ordinary words, so they are left alone.
const SECRET_ENV_NAME = /SECRET|TOKEN|KEY|PASSWORD/i
const SECRET_ENV_MIN = 8
let secretEnvNames = null

// For the tests: rescan the env names on the next redact().
export function resetSecretEnvCache() {
  secretEnvNames = null
}

// Strips secrets and collapses to one capped line. The token values are read
// from the environment at call time, so a rotated token is still caught.
export function redact(text, { oneLine = true } = {}) {
  let out = String(text ?? '')
  for (const key of ['GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'WA_APPROVAL_SECRET']) {
    const secret = process.env[key]
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]')
  }
  secretEnvNames ??= Object.keys(process.env).filter((name) => SECRET_ENV_NAME.test(name))
  for (const name of secretEnvNames) {
    const secret = process.env[name]
    if (secret && secret.length >= SECRET_ENV_MIN) out = out.split(secret).join('[redacted]')
  }
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted]')
  if (!oneLine) return out
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > REASON_MAX ? out.slice(0, REASON_MAX - 1) + '…' : out
}

// First matching rule for this gate wins; no match is 'ping_human'.
export function decide(gateIndex, facts, policy) {
  for (const rule of policy.rules) {
    if (rule.gateIndex !== null && rule.gateIndex !== gateIndex) continue
    const match = EVALUATORS[rule.id](rule, facts)
    if (!match) continue
    const comment = match.comment ? redact(match.comment, { oneLine: false }) : null
    return { decision: rule.decision, ruleId: rule.id, reason: redact(match.reason), comment }
  }
  return { decision: 'ping_human', ruleId: null, reason: 'no rule matched; a human needs to look', comment: null }
}
