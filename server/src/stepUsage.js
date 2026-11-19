// HZ-550: a run's token usage and cost, as the provider reported them, on its
// step_run row. The farm sends them as artifacts.usage (farm/agent_runner.py's
// UsageMeter, summed over every call the run made — retries, re-prompts and
// fix-loop turns included):
//
//   {agent_run: true, input_tokens, output_tokens, cache_read_tokens,
//    cache_write_tokens, cost_usd, num_turns}
//
// agent_run false is a run with no agent call (a deploy that only read its
// log), whose figures are 0. agent_run true with every figure null is an
// agent run the provider reported no usage for (Muse, or a call that raised).
// HZ-921: num_turns is the run's agent turns, kept apart from the figures — a
// non-negative integer, else NULL (not reported, no agent, or malformed).
//
// Capture never changes how a step runs: a malformed report stores NULL, and a
// failed write is swallowed. Nothing here logs a figure. The columns are read
// by GET /api/admin/productivity and (HZ-921) server/src/itemStats.js.

import { db } from './db.js'

const FIGURES = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd']
const TOKEN_FIGURES = new Set(FIGURES.filter((key) => key !== 'cost_usd'))

const NOT_RECORDED = Object.freeze({
  agentRun: null,
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  cost_usd: null,
  num_turns: null,
})
const UNKNOWN_AGENT = Object.freeze({ ...NOT_RECORDED, agentRun: 1 })
export const NON_AGENT = Object.freeze({
  agentRun: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
  num_turns: null,
})

// Steps that never call an agent: a job's commands and Horizon's own server
// steps. A farm too old to send usage still labels them correctly.
const NON_AGENT_RUNS_IN = new Set(['job', 'server'])

const validFigure = (key, value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!TOKEN_FIGURES.has(key) || Number.isInteger(value))

const turnsOf = (usage) => {
  const value = Object.hasOwn(usage, 'num_turns') ? usage.num_turns : null
  return Number.isInteger(value) && value >= 0 ? value : null
}

// The row values for one run's report. `step` is its domain/steps.json row.
export function cleanUsage(usage, step) {
  if (usage == null) return NON_AGENT_RUNS_IN.has(step?.runsIn) ? NON_AGENT : NOT_RECORDED
  if (typeof usage !== 'object' || Array.isArray(usage) || !Object.hasOwn(usage, 'agent_run')) return NOT_RECORDED
  if (usage.agent_run === false) return NON_AGENT
  if (usage.agent_run !== true) return NOT_RECORDED
  const num_turns = turnsOf(usage)
  const figures = FIGURES.map((key) => (Object.hasOwn(usage, key) ? usage[key] : undefined))
  if (figures.every((value) => value === null)) return { ...UNKNOWN_AGENT, num_turns }
  if (!FIGURES.every((key, i) => validFigure(key, figures[i]))) return { ...UNKNOWN_AGENT, num_turns }
  return { agentRun: 1, ...Object.fromEntries(FIGURES.map((key, i) => [key, figures[i]])), num_turns }
}

const updateUsage = db.prepare(
  `UPDATE step_run SET agent_run = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
     cache_write_tokens = ?, cost_usd = ?, num_turns = ? WHERE id = ?`,
)

// One write. Returns whether it landed; a failure leaves the columns NULL and
// the run carries on.
export function recordRunUsage(runId, cleaned) {
  try {
    updateUsage.run(cleaned.agentRun, ...FIGURES.map((key) => cleaned[key]), cleaned.num_turns ?? null, runId)
    return true
  } catch {
    return false
  }
}
