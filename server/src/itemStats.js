// HZ-921: one item's Effort & cost summary — what its implementation took,
// its tokens and cost by phase and in total, where its time went, and the
// clarification it needed. The item page (GET /api/items/:id/stats), the
// GitHub stats comment (statsComment.js) and the backfill script all read this
// one object, so they always show the same numbers.
//
// Read-only, built from stored rows only: step_run (HZ-550's usage columns and
// num_turns), gate_decision, feedback, ask, caretaker_ruling, event and
// work_item. Token, cost and time figures use productivity.js's own helpers,
// so this summary and Admin's Productivity page can never disagree.
//
// Everything here is public — it is posted to the item's issue. Ids, step
// keys, agent and model names, numbers and timestamps only: never a prompt,
// run output, note, ask text, ruling reason, path or secret. STATS_KEYS is the
// allowlist of every key the object may hold, at any depth.
//
// Nulls: a token or cost figure is null until some run in it was recorded
// (HZ-550's rule). A turns total is null when any agent run in it has no
// num_turns — a partial sum would under-count — and is never 0 for "unknown".

import { readFileSync } from 'node:fs'
import { db } from './db.js'
import {
  addNullable,
  gateWaitFor,
  itemClosedAt,
  itemReviewFails,
  itemTimeSplit,
  itemUsageTotals,
  money,
  msOf,
} from './productivity.js'
import {
  ACCEPT_GATE_INDEX,
  IMPLEMENT_ITEM_KIND,
  IMPLEMENT_STEP_INDEX,
  REVIEW_STEP_INDEX,
  STEPS,
  isAbandoned,
  isClosed,
  itemKindOf,
  laneOf,
  phasesFor,
  sendBackTargetOf,
  stepKeyAt,
} from '../../domain/js/lifecycle.js'

// The contract of GET /api/items/:id/stats's 200 response, every key written
// down; server/test/item-stats.test.mjs validates live responses against it.
export const ITEM_STATS_SCHEMA = JSON.parse(readFileSync(new URL('../../domain/itemStats.schema.json', import.meta.url), 'utf8'))

// The route's response schema (serializer and OpenAPI entry): the two keys,
// with `stats` an undescribed object, as server/src/openapi.js's shapes are —
// it strips nothing, and keeps the published document within its size check.
export const ITEM_STATS_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['visible', 'stats'],
  properties: {
    visible: { type: 'boolean' },
    stats: { description: 'domain/itemStats.schema.json', type: ['object', 'null'], additionalProperties: true },
  },
}

export const STATS_SCHEMA = 'horizon-stats'
export const STATS_VERSION = 1

// The event texts the orchestrator writes for an automatic retry and for a
// usage-limit fallback (orchestrator.js failFarmRun:
//   `transient failure (<reason>): <cause> — auto-retrying (n/cap)` and
//   `<provider/model> hit a usage limit until <time> — running “<step>” on
//   the next model, same attempt`). Pinned by server/test/item-stats.test.mjs.
export const STATS_EVENT_PATTERNS = Object.freeze({
  autoRetry: 'transient failure (%',
  usageLimitFallback: '% hit a usage limit until %',
})

const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']

// Every key the stats object holds, at any depth.
export const STATS_KEYS = Object.freeze(
  new Set([
    'schema',
    'version',
    'item',
    'kind',
    'repo',
    'lane',
    'priority',
    'outcome',
    'created_at',
    'closed_at',
    'steps',
    'step',
    'agent',
    'attempt',
    'model',
    'provider',
    ...TOKEN_KEYS,
    'tokens',
    'cost_usd',
    'turns',
    'wall_ms',
    'phases',
    'phase',
    'totals',
    'implementation',
    'attempts',
    'fix_rounds',
    'time',
    'elapsed_ms',
    'agent_ms',
    'waiting_ms',
    'checks_deploy_ms',
    'queued_ms',
    'clarification',
    'none',
    'total',
    'request_changes',
    'review_fails',
    'asks',
    'blocking',
    'soft',
    'by_step',
    'caretaker_rulings',
    'review_cycles',
    'auto_retries',
    'usage_limit_fallbacks',
    'count',
  ]),
)

const selectItem = db.prepare(
  'SELECT id, kind, repo, lane, priority, cursor, created_at, updated_at, abandoned_at FROM work_item WHERE id = ?',
)

const selectRuns = db.prepare(`
  SELECT id, item_id, step_index, attempt, agent, model, provider, started_at, agent_started_at, ended_at, checks_ms,
         agent_run, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, num_turns
    FROM step_run WHERE item_id = ? ORDER BY id`)

const selectDecisions = db.prepare(
  'SELECT item_id, step_index, decision, created_at FROM gate_decision WHERE item_id = ? ORDER BY created_at, id',
)

// store.requestChanges writes a rejected gate_decision and the feedback row
// naming the step it sent back to (HZ-709's step_key) in one transaction, so
// both carry the same created_at.
const selectRequestChanges = db.prepare(`
  SELECT g.step_index,
         (SELECT f.step_key FROM feedback f
           WHERE f.item_id = g.item_id AND f.step_key IS NOT NULL AND f.created_at = g.created_at
           ORDER BY f.id LIMIT 1) AS target_key
    FROM gate_decision g WHERE g.item_id = ? AND g.decision = 'rejected' ORDER BY g.id`)

const selectAsks = db.prepare(
  "SELECT step_index, kind FROM ask WHERE item_id = ? AND kind IN ('blocking', 'soft') ORDER BY id",
)

const selectRulings = db.prepare(
  "SELECT gate_index FROM caretaker_ruling WHERE item_id = ? AND outcome = 'applied' ORDER BY id",
)

const countEvents = db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = ? AND who = 'Horizon' AND text LIKE ?")

const isoOf = (sql) => (sql == null ? null : new Date(msOf(sql)).toISOString().replace('.000Z', 'Z'))
const isAgentRun = (run) => run.agent_run !== 0
const wallMs = (run) => (run.ended_at == null ? null : Math.max(msOf(run.ended_at) - msOf(run.started_at), 0))

// Token figures by type and cost, by HZ-550's null rule, plus Productivity's
// own `tokens` (input + output) and cost from itemUsageTotals.
function usageOf(runs) {
  const sums = Object.fromEntries(TOKEN_KEYS.map((key) => [key, null]))
  for (const run of runs) for (const key of TOKEN_KEYS) sums[key] = addNullable(sums[key], run[key])
  const { cost, tokens } = itemUsageTotals(runs)
  return { ...sums, tokens, cost_usd: money(cost) }
}

// null when any agent run in `runs` has no recorded turns, or none ran.
function turnsOf(runs) {
  const agentRuns = runs.filter(isAgentRun)
  if (agentRuns.length === 0 || agentRuns.some((run) => run.num_turns == null)) return null
  return agentRuns.reduce((sum, run) => sum + run.num_turns, 0)
}

// [{ step, count }] in first-seen order.
function countBy(keys) {
  const counts = new Map()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  return [...counts].map(([step, count]) => ({ step, count }))
}

function clarificationOf(item, kind, runs) {
  const request_changes = countBy(
    selectRequestChanges
      .all(item.id)
      .map((row) => row.target_key ?? stepKeyAt(sendBackTargetOf(row.step_index)) ?? stepKeyAt(row.step_index)),
  )
  // Productivity's reviewFails: sent back to implement, or forwarded to the
  // Accept gate at the cap. (Productivity's sendBacks are request_changes.)
  const review_fails = countBy(
    itemReviewFails(item.id).map((how) => stepKeyAt(how === 'at_cap' ? ACCEPT_GATE_INDEX : IMPLEMENT_STEP_INDEX)),
  )
  const askRows = selectAsks.all(item.id)
  const byStep = new Map()
  for (const ask of askRows) {
    const step = stepKeyAt(ask.step_index)
    const row = byStep.get(step) ?? { step, blocking: 0, soft: 0 }
    row[ask.kind] += 1
    byStep.set(step, row)
  }
  const asks = {
    blocking: askRows.filter((ask) => ask.kind === 'blocking').length,
    soft: askRows.filter((ask) => ask.kind === 'soft').length,
    by_step: [...byStep.values()],
  }
  const caretaker_rulings = countBy(selectRulings.all(item.id).map((row) => stepKeyAt(row.gate_index)))
  const auto_retries = countEvents.get(item.id, STATS_EVENT_PATTERNS.autoRetry).n
  const usage_limit_fallbacks = countEvents.get(item.id, STATS_EVENT_PATTERNS.usageLimitFallback).n
  const sum = (rows) => rows.reduce((total, row) => total + row.count, 0)
  // Review cycles are how often the review step ran; a first review is not a
  // clarification, and every later one follows a review fail counted above.
  const total =
    sum(request_changes) +
    sum(review_fails) +
    asks.blocking +
    asks.soft +
    sum(caretaker_rulings) +
    auto_retries +
    usage_limit_fallbacks
  return {
    none: total === 0,
    total,
    request_changes,
    review_fails,
    asks,
    caretaker_rulings,
    review_cycles: kind === IMPLEMENT_ITEM_KIND ? runs.filter((run) => run.step_index === REVIEW_STEP_INDEX).length : 0,
    auto_retries,
    usage_limit_fallbacks,
  }
}

// The summary for item `itemId` at `now`, or null for an unknown id.
export function itemStats(itemId, { now = Date.now() } = {}) {
  const item = selectItem.get(itemId)
  if (!item) return null
  const kind = itemKindOf(item)
  const runs = selectRuns.all(itemId)
  const decisions = selectDecisions.all(itemId)

  const abandoned = isAbandoned(item)
  const closed = !abandoned && isClosed(item)
  const closedAt = abandoned ? item.abandoned_at : closed ? (itemClosedAt(itemId, kind) ?? item.updated_at) : null

  const gateWait = gateWaitFor(new Map([[itemId, runs]]), new Map([[itemId, decisions]]))
  const split = itemTimeSplit(runs, decisions, gateWait, itemId)
  const elapsed = Math.max((closedAt == null ? now : msOf(closedAt)) - msOf(item.created_at), 0)
  const agent_ms = Math.round(split.agentsWorking)
  const waiting_ms = Math.round(split.waitingOnYou)
  const checks_deploy_ms = Math.round(split.checksAndDeploy)

  const steps = runs.map((run) => ({
    step: stepKeyAt(run.step_index),
    agent: run.agent,
    attempt: run.attempt,
    model: run.model ?? null,
    provider: run.provider ?? null,
    ...Object.fromEntries(TOKEN_KEYS.map((key) => [key, run[key] ?? null])),
    cost_usd: money(run.cost_usd ?? null),
    turns: isAgentRun(run) ? (run.num_turns ?? null) : null,
    wall_ms: wallMs(run),
  }))

  const phaseNames = phasesFor(kind)
  const phases = phaseNames.map((phase, index) => ({ phase, ...usageOf(runs.filter((run) => STEPS[run.step_index]?.phase === index)) }))

  let implementation = null
  if (kind === IMPLEMENT_ITEM_KIND) {
    const implementRuns = runs.filter((run) => run.step_index === IMPLEMENT_STEP_INDEX)
    const walls = implementRuns.map(wallMs).filter((ms) => ms != null)
    implementation = {
      attempts: implementRuns.length,
      fix_rounds: itemReviewFails(itemId).length,
      ...usageOf(implementRuns),
      turns: turnsOf(implementRuns),
      wall_ms: walls.length ? walls.reduce((sum, ms) => sum + ms, 0) : null,
    }
  }

  return {
    schema: STATS_SCHEMA,
    version: STATS_VERSION,
    item: item.id,
    kind,
    repo: item.repo ?? null,
    lane: laneOf(item),
    priority: item.priority,
    outcome: abandoned ? 'abandoned' : closed ? 'closed' : null,
    created_at: isoOf(item.created_at),
    closed_at: isoOf(closedAt),
    steps,
    phases,
    totals: { ...usageOf(runs), turns: turnsOf(runs) },
    implementation,
    time: {
      elapsed_ms: elapsed,
      agent_ms,
      waiting_ms,
      checks_deploy_ms,
      // Everything else: slot waits (Productivity's `queued`), dispatch, and
      // time the item sat with nothing running and no gate open.
      queued_ms: Math.max(elapsed - agent_ms - waiting_ms - checks_deploy_ms, 0),
    },
    clarification: clarificationOf(item, kind, runs),
  }
}
