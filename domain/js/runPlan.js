// The JS reader for a Task's Run plan block (HZ-384). farm/step_agent.py
// validates the Run plan step's `run_plan` reply and appends it to the
// artifact as a ```json run-plan fenced block; domain/py/run_plan.py's
// extract() reads it back for the farm. The server reads it here to show the
// plan on the Approve the run gate card and to refuse an approval with no plan.
//
// Same rule as extract(): the LAST fenced block wins. Unlike extract(), a
// missing or malformed block is not an error here — it reads as null, and the
// card says the plan was not found. The full contract is
// domain/runPlan.schema.json; only the fields a reader relies on are checked.

import { criteriaLines } from './fields.js'

const FENCED = /```json run-plan\n([\s\S]*?)\n```/g

export function extractRunPlan(artifact) {
  if (typeof artifact !== 'string') return null
  const found = [...artifact.matchAll(FENCED)]
  if (found.length === 0) return null
  let block
  try {
    block = JSON.parse(found[found.length - 1][1])
  } catch {
    return null
  }
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null
  const { cwd, commands, budget_minutes: budgetMinutes } = block
  if (typeof cwd !== 'string' || !cwd.trim()) return null
  if (!Array.isArray(commands) || commands.length === 0) return null
  if (!commands.every((c) => typeof c === 'string' && c.trim())) return null
  if (!Number.isInteger(budgetMinutes) || budgetMinutes < 1) return null
  if (block.reports !== undefined && !validReports(block.reports)) return null
  if (block.requires !== undefined && !validRequires(block.requires)) return null
  if (block.proof !== undefined && !validProof(block.proof, commands.length, block.reports ?? [])) return null
  // HZ-416: optional; absent leaves it to effectiveRunner(). Unknown values
  // read as no plan, the same as any other malformed block.
  if (block.runner !== undefined && block.runner !== 'container' && block.runner !== 'host') return null
  return block
}

// HZ-491: where Execute runs a plan. The plan's own `runner` wins; with none,
// the container only when the repo pins an image, else the host. The server
// works this out (store.js currentRunPlan) and the farm takes it as sent.
export function effectiveRunner(block, imagePinned) {
  return block.runner ?? (imagePinned ? 'container' : 'host')
}

// HZ-434: the same shape-only rule as run_plan.validate() — non-empty paths,
// none with a `..` part. Execute's realpath check owns where a report may be.
function validReports(reports) {
  if (!Array.isArray(reports)) return false
  return reports.every((p) => typeof p === 'string' && p.trim() && !p.split('/').includes('..'))
}

// HZ-502: the same rule as run_plan.validate()'s `requires` check — one
// `tool` or `path` key per item; a tool name never starts with `-`; a path is
// relative, with no `..` part and no control character.
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const CONTROL = /[\x00-\x1f\x7f]/

function validRequires(requires) {
  if (!Array.isArray(requires)) return false
  return requires.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const keys = Object.keys(entry)
    if (keys.length !== 1) return false
    const [key] = keys
    const value = entry[key]
    if (typeof value !== 'string' || !value) return false
    if (key === 'tool') return TOOL_NAME.test(value)
    if (key === 'path') return value.trim() !== '' && !value.startsWith('/') && !value.split('/').includes('..') && !CONTROL.test(value)
    return false
  })
}

// HZ-503: the same shape rule as run_plan.validate()'s `proof` check — a
// whole `line` and exactly one source: `command`, a 1-based index into
// `commands`; `report`, `<path>#<field>` with both parts non-empty and the
// path listed in `reports`; or HZ-770's `manual`, the owner check, as
// non-blank text.
const PROOF_SOURCES = ['command', 'report', 'manual']
const PROOF_KEYS = new Set(['line', ...PROOF_SOURCES])
const whole = (n) => Number.isInteger(n) && n >= 1
const text = (s) => typeof s === 'string' && s.trim() !== ''

function validProof(proof, commandCount, reports) {
  if (!Array.isArray(proof)) return false
  return proof.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    if (!Object.keys(entry).every((key) => PROOF_KEYS.has(key)) || !whole(entry.line)) return false
    const sources = PROOF_SOURCES.filter((key) => Object.hasOwn(entry, key))
    if (sources.length !== 1) return false
    if (sources[0] === 'command') return whole(entry.command) && entry.command <= commandCount
    if (sources[0] === 'manual') return text(entry.manual)
    if (typeof entry.report !== 'string') return false
    const at = entry.report.indexOf('#')
    if (at < 0) return false
    const reportPath = entry.report.slice(0, at)
    return reportPath.trim() !== '' && entry.report.slice(at + 1).trim() !== '' && reports.includes(reportPath)
  })
}

const numbers = (lines) => `${lines.length === 1 ? 'line' : 'lines'} ${lines.join(', ')}`

function proofGaps(block, metric) {
  const total = criteriaLines(metric).length
  const named = (block.proof ?? []).map((entry) => entry.line)
  const missing = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !named.includes(n))
  const doubled = [...new Set(named.filter((n, i) => named.indexOf(n) !== i))].sort((a, b) => a - b)
  const beyond = [...new Set(named.filter((n) => n > total))].sort((a, b) => a - b)
  return { total, missing, doubled, beyond }
}

// HZ-770: the same coverage rule as run_plan.unproven_lines() — every metric
// line an extracted block's `proof` leaves uncovered (missing, doubled or out
// of range), sorted. The Approve the run card shows them; it never refuses.
export function unprovenLines(block, metric) {
  const { missing, doubled, beyond } = proofGaps(block, metric)
  return [...new Set([...missing, ...doubled, ...beyond])].sort((a, b) => a - b)
}

// HZ-770: run_plan.unproven()'s reason, word for word, or null.
export function unprovenReason(block, metric) {
  const { total, missing, doubled, beyond } = proofGaps(block, metric)
  const gaps = []
  if (missing.length) gaps.push(`proof has no entry for metric ${numbers(missing)}`)
  if (doubled.length) gaps.push(`proof names metric ${numbers(doubled)} more than once`)
  if (beyond.length) gaps.push(`proof names metric ${numbers(beyond)}, but the metric has ${total} line${total === 1 ? '' : 's'}`)
  return gaps.join('; ') || null
}

// HZ-770: the same rule as run_plan.check_circular() for Impact review's
// `circular_proofs` — the flagged entries sorted by line, [] for none (no key
// or an empty list), or null for a bad shape, a blank reason or a line the
// metric does not have.
export function circularProofs(value, metric) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const total = criteriaLines(metric).length
  const valid = value.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const keys = Object.keys(entry)
    return keys.length === 2 && keys.includes('line') && keys.includes('reason') && whole(entry.line) && entry.line <= total && text(entry.reason)
  })
  return valid ? [...value].sort((a, b) => a.line - b.line) : null
}
