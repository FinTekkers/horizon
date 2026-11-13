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
// HO-835: runPlanError() says why a parsed block fails; a v2 reason is the
// same text run_plan.validate() raises, from domain/runPlanContract.json.

import { criteriaLines } from './fields.js'
import dbChangesRules from '../dbChanges.json' with { type: 'json' }
import runPlanContract from '../runPlanContract.json' with { type: 'json' }
import taskMediaRules from '../taskMedia.json' with { type: 'json' }

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
  return runPlanError(block) === null ? block : null
}

const invalid = (field) => `run_plan '${field}' is not valid`

// Why a parsed block is not a run plan the card can show, or null when it
// is. The first problem wins. A v1 field reads `run_plan '<field>' is not
// valid`; a v2 one (HO-835) names its field in run_plan.validate()'s words.
// Never the value a field holds.
export function runPlanError(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return 'run_plan must be a JSON object'
  const { cwd, commands, budget_minutes: budgetMinutes } = block
  if (typeof cwd !== 'string' || !cwd.trim()) return invalid('cwd')
  if (!Array.isArray(commands) || commands.length === 0) return invalid('commands')
  if (!commands.every((c) => typeof c === 'string' && c.trim())) return invalid('commands')
  if (!Number.isInteger(budgetMinutes) || budgetMinutes < 1) return invalid('budget_minutes')
  if (block.reports !== undefined && !validReports(block.reports)) return invalid('reports')
  if (block.requires !== undefined) {
    const reason = requiresError(block.requires)
    if (reason) return reason
  }
  if (block.proof !== undefined && !validProof(block.proof, commands.length, block.reports ?? [])) return invalid('proof')
  if (block.rehearsal !== undefined) {
    const reason = rehearsalError(block.rehearsal, block.env, commands.length)
    if (reason) return reason
  }
  if (block.db_changes !== undefined && !validDbChanges(block.db_changes, block.env)) return invalid('db_changes')
  if (block.outputs !== undefined && !validOutputs(block.outputs)) return invalid('outputs')
  // HZ-416: optional; absent leaves it to effectiveRunner(). Unknown values
  // read as no plan, the same as any other malformed block.
  if (block.runner !== undefined && block.runner !== 'container' && block.runner !== 'host') return invalid('runner')
  return null
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
// relative, with no `..` part and no control character. HZ-769: an `env`
// name is a variable name with no `$`; a `file` is an absolute path with no
// control character (the farm resolves it and allows only its config roots).
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const CONTROL = /[\x00-\x1f\x7f]/

function requiresError(requires) {
  if (!Array.isArray(requires)) return invalid('requires')
  for (const original of requires) {
    if (!original || typeof original !== 'object' || Array.isArray(original)) return invalid('requires')
    let entry = original
    if (Object.hasOwn(entry, 'access')) {
      // HO-835: only a `file` may say whether the run reads or writes it.
      const keys = Object.keys(entry)
      if (keys.length !== 2 || !Object.hasOwn(entry, 'file') || !oneOf(entry.access, CONTRACT.fileAccess)) return contractReason('access')
      entry = { file: entry.file }
    }
    const keys = Object.keys(entry)
    if (keys.length !== 1) return invalid('requires')
    const [key] = keys
    const value = entry[key]
    if (key === 'service') {
      const reason = serviceError(value)
      if (reason) return reason
      continue
    }
    if (key === 'precondition') {
      const reason = preconditionError(value)
      if (reason) return reason
      continue
    }
    if (typeof value !== 'string' || !value) return invalid('requires')
    let valid = false
    if (key === 'tool') valid = TOOL_NAME.test(value)
    if (key === 'path') valid = value.trim() !== '' && !value.startsWith('/') && !value.split('/').includes('..') && !CONTROL.test(value)
    if (key === 'env') valid = ENV_NAME.test(value)
    if (key === 'file') valid = value.startsWith('/') && !CONTROL.test(value)
    if (!valid) return invalid('requires')
  }
  return null
}

// HO-835: the v2 contract — `service` and `precondition` entries in
// `requires`, a `file`'s `access`, and the top-level `rehearsal` block. The
// same rule as run_plan.validate()'s, word for word; the rules and reason
// texts are domain/runPlanContract.json, shared with the farm. Shape only:
// no `check`, `version_cmd`, `dry_run` or sample is ever run here.
export const RUN_PLAN_CONTRACT = runPlanContract
const CONTRACT = runPlanContract
const SERVICE_NAME = new RegExp(CONTRACT.serviceName)
const WRITE_SHAPES = CONTRACT.writeShapes.map((shape) => ({
  name: shape.name,
  pattern: new RegExp(shape.pattern, shape.ignoreCase ? 'i' : ''),
  unquotedOnly: shape.unquotedOnly,
}))
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g
const SLOT = /\{(\w+)\}/g

function contractReason(key, slots = {}) {
  return CONTRACT.reasons[key].replace(SLOT, (_, name) => String(slots[name]))
}

const oneOf = (value, allowed) => typeof value === 'string' && allowed.includes(value)
// Non-blank text on one line, with no control character.
const line = (value) => text(value) && !CONTROL.test(value)
const exactKeys = (value, wanted) =>
  value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === wanted.length && wanted.every((k) => Object.hasOwn(value, k))

// The NAME of the first write shape a command has, or null — never the
// command text. Best-effort: null does not prove a command read-only.
export function writeShape(command) {
  const unquoted = command.replace(QUOTED, ' ')
  const hit = WRITE_SHAPES.find((shape) => shape.pattern.test(shape.unquotedOnly ? unquoted : command))
  return hit ? hit.name : null
}

function readOnlyError(command, field) {
  const shape = writeShape(command)
  return shape ? contractReason('writeShape', { field, shape }) : null
}

function serviceError(value) {
  if (!exactKeys(value, ['name', 'version_cmd', 'expect'])) return contractReason('service')
  if (typeof value.name !== 'string' || !SERVICE_NAME.test(value.name) || !line(value.version_cmd) || !line(value.expect)) {
    return contractReason('service')
  }
  return readOnlyError(value.version_cmd, 'service version_cmd')
}

function preconditionError(value) {
  if (!exactKeys(value, ['kind', 'check']) || !oneOf(value.kind, CONTRACT.preconditionKinds) || !line(value.check)) {
    return contractReason('precondition', { kinds: CONTRACT.preconditionKinds.join(', ') })
  }
  return readOnlyError(value.check, 'precondition check')
}

// Each `env` key, and each `$NAME` an `env` value names.
function liveEnvNames(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return new Set()
  const refs = Object.values(env).filter((v) => typeof v === 'string' && ENV_REFERENCE.test(v)).map((v) => v.slice(1))
  return new Set([...Object.keys(env), ...refs])
}

function rehearsalError(rehearsal, env, commandCount) {
  if (!rehearsal || typeof rehearsal !== 'object' || Array.isArray(rehearsal)) return contractReason('rehearsal')
  const unknown = Object.keys(rehearsal).filter((key) => !CONTRACT.rehearsalKeys.includes(key)).sort()
  if (unknown.length) return contractReason('rehearsalUnknown', { fields: unknown.join(', ') })
  if (Object.hasOwn(rehearsal, 'dry_run') && !line(rehearsal.dry_run)) return contractReason('dryRun')
  if (Object.hasOwn(rehearsal, 'limit') && !whole(rehearsal.limit)) return contractReason('limit')
  if (Object.hasOwn(rehearsal, 'ro_env')) {
    const roEnv = rehearsal.ro_env
    if (!Array.isArray(roEnv) || !roEnv.every((name) => typeof name === 'string' && ENV_NAME.test(name)) || new Set(roEnv).size !== roEnv.length) {
      return contractReason('roEnv')
    }
    const live = liveEnvNames(env)
    const clash = roEnv.find((name) => live.has(name))
    if (clash !== undefined) return contractReason('roEnvLive', { name: clash })
  }
  if (Object.hasOwn(rehearsal, 'samples')) return samplesError(rehearsal.samples, commandCount)
  return null
}

function samplesError(samples, commandCount) {
  if (!Array.isArray(samples)) return contractReason('samples')
  const seen = new Set()
  for (const sample of samples) {
    if (!exactKeys(sample, ['command', 'expect'])) return contractReason('samples')
    if (!whole(sample.command) || sample.command > commandCount) return contractReason('samplesCommand')
    if (!line(sample.expect) || sample.expect.length > CONTRACT.maxSampleLength) {
      return contractReason('samplesExpect', { max: CONTRACT.maxSampleLength })
    }
    if (seen.has(sample.command)) return contractReason('samplesDoubled', { n: sample.command })
    seen.add(sample.command)
  }
  return null
}

// HZ-814: the same rule as run_plan.validate()'s `db_changes` check —
// exactly `connection` and `tables`; the connection one of the plan's `env`
// values; 1 to maxTables distinct names, each `table` or `schema.table`.
// The rule's data is domain/dbChanges.json, shared with the farm.
export const DB_CHANGES_RULES = dbChangesRules
export const TABLE_NAME = new RegExp(dbChangesRules.tableName)
const ENV_REFERENCE = /^\$[A-Z_][A-Z0-9_]*$/

export function validTableName(name) {
  return typeof name === 'string' && name.length <= dbChangesRules.maxTableNameLength && TABLE_NAME.test(name)
}

function validDbChanges(dbChanges, env) {
  if (!dbChanges || typeof dbChanges !== 'object' || Array.isArray(dbChanges)) return false
  const keys = Object.keys(dbChanges)
  if (keys.length !== 2 || !keys.includes('connection') || !keys.includes('tables')) return false
  const { connection, tables } = dbChanges
  const envValues = env && typeof env === 'object' && !Array.isArray(env) ? Object.values(env) : []
  if (typeof connection !== 'string' || !ENV_REFERENCE.test(connection) || !envValues.includes(connection)) return false
  if (!Array.isArray(tables) || tables.length < 1 || tables.length > dbChangesRules.maxTables) return false
  return new Set(tables).size === tables.length && tables.every(validTableName)
}

// HZ-815: the same rule as run_plan.validate()'s `outputs` check — at most
// maxOutputs entries of exactly `path` and `kind`; the kind one of
// domain/taskMedia.json `kinds`; the path non-blank, with no `..` part and
// no control character. Execute's realpath check owns where a file may be.
export const TASK_MEDIA_RULES = taskMediaRules

function validOutputs(outputs) {
  if (!Array.isArray(outputs) || outputs.length > taskMediaRules.maxOutputs) return false
  return outputs.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const keys = Object.keys(entry)
    if (keys.length !== 2 || !keys.includes('path') || !keys.includes('kind')) return false
    if (!taskMediaRules.kinds.includes(entry.kind)) return false
    const { path } = entry
    if (typeof path !== 'string' || !path.trim() || path.length > taskMediaRules.maxPathLength) return false
    return !path.split('/').includes('..') && !CONTROL.test(path)
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

// HO-836: Impact review's `contract_gaps` — each tool or host a plan's
// commands reach that its `requires` does not declare, as the farm's static
// scan reports them (farm/run_plan_requires.py contract_gaps()). [] for none
// (no key or an empty list), or null for a bad shape: an unknown kind, a name
// a `tool` or `service` entry could not hold (so no command text can ride
// through), or a `command` that is not a 1-based index. Sorted by command,
// then kind, then name.
const GAP_NAME = { tool: TOOL_NAME, service: SERVICE_NAME }

export function contractGaps(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const valid = value.every(
    (entry) =>
      exactKeys(entry, ['kind', 'name', 'command']) &&
      typeof entry.kind === 'string' &&
      Object.hasOwn(GAP_NAME, entry.kind) &&
      typeof entry.name === 'string' &&
      GAP_NAME[entry.kind].test(entry.name) &&
      whole(entry.command),
  )
  if (!valid) return null
  return [...value].sort((a, b) => a.command - b.command || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}
