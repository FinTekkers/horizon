// HZ-549: the contract behind Admin's Productivity page.
//
// domain/productivity.schema.json is the 200 response of
// GET /api/admin/productivity — app.js hands it to Fastify as the route's
// response schema, so the one file is the serializer, the published OpenAPI
// entry and what the contract test validates the fixture against.
//
// HZ-550: productivityReport() aggregates Horizon's own DB — step_run (model,
// tokens, cost, durations, checks_ms), event (GitHub closes, failed reviews,
// failed steps), gate_decision (closes at a kind's last gate, approvals,
// send-backs, waits) and test_result (failed check runs). Read-only, server
// side only, a handful of indexed queries per request. Every cost and token
// figure is null when no run in it was captured (stepUsage.js) — never 0.
// domain/fixtures/productivity.json stays the design's figures for the
// contract test and the mock API.

import { readFileSync } from 'node:fs'
import { db } from './db.js'
import { hasNoProject } from './membership.js'
import { msOf as parseSqlTime } from './sqlTime.js'
import { REASON } from '../../domain/js/reasons.js'
import {
  DEPLOY_STEP_INDEX,
  ITEM_KINDS,
  STEPS,
  awaitingGate,
  endIndex,
  firstStepIndex,
  gateStepIndexes,
  isAbandoned,
  isClosed,
  itemKindInfo,
  itemKindOf,
} from '../../domain/js/lifecycle.js'

const readDomainJson = (rel) => JSON.parse(readFileSync(new URL(`../../domain/${rel}`, import.meta.url), 'utf8'))

export const PRODUCTIVITY_RESPONSE_SCHEMA = readDomainJson('productivity.schema.json')

export const PRODUCTIVITY_RANGES = ['7d', '14d', '30d']

export const PRODUCTIVITY_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    range: { type: 'string', enum: PRODUCTIVITY_RANGES, default: '14d' },
    // Any project id is echoed, not looked up: an id with no project row gets
    // an empty report, not a 404.
    project: { type: 'string', minLength: 1, maxLength: 64, default: 'all' },
  },
}

const DAY_MS = 86_400_000
const TOP_ITEMS = 5
const FIRST_KIND = ITEM_KINDS[0]

// ---- small helpers ----

const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10)
// sqlTime.js's msOf, without its string rebuild for the datetime('now') form
// every row here has — the report parses tens of thousands per request. The
// date part is parsed once per day; the clock is read digit by digit.
const SQL_DAY = /^\d{4}-\d{2}-\d{2}$/
const dayMsCache = new Map()
function dayMsOf(date) {
  let ms = dayMsCache.get(date)
  if (ms === undefined) {
    ms = SQL_DAY.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN
    dayMsCache.set(date, ms)
  }
  return ms
}
function digitAt(sql, i) {
  const d = sql.charCodeAt(i) - 48
  return d >= 0 && d <= 9 ? d : NaN
}
function msOf(sql) {
  if (sql.length === 19 && sql[10] === ' ' && sql[13] === ':' && sql[16] === ':') {
    const day = dayMsOf(sql.slice(0, 10))
    const h = digitAt(sql, 11) * 10 + digitAt(sql, 12)
    const m = digitAt(sql, 14) * 10 + digitAt(sql, 15)
    const s = digitAt(sql, 17) * 10 + digitAt(sql, 18)
    const ms = day + ((h * 60 + m) * 60 + s) * 1000
    if (!Number.isNaN(ms) && h < 24 && m < 60 && s < 60) return ms
  }
  return parseSqlTime(sql)
}
const dayOf = (sql) => sql.slice(0, 10)
const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places
const minutes = (ms) => round(ms / 60_000, 1)

// The middle value; with an even count, the mean of the two middle ones.
export function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// A sum that stays null until some value in it was captured.
function addNullable(total, value) {
  if (value == null) return total
  return (total ?? 0) + value
}

const money = (value) => (value == null ? null : round(value, 6))

// Monday of the week `date` (YYYY-MM-DD) falls in.
function mondayOf(date) {
  const ms = Date.parse(`${date}T00:00:00Z`)
  return dateOf(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS)
}

// ---- the window and its projects ----

// `range` days back from today (UTC), both ends inclusive — 14d on the 22nd
// runs from the 8th, as the design's fixture does.
function windowFor(range, now) {
  const days = Number.parseInt(range, 10)
  const to = dateOf(now)
  const toMs = Date.parse(`${to}T00:00:00Z`)
  const list = []
  for (let i = days; i >= 0; i--) list.push(dateOf(toMs - i * DAY_MS))
  const loMs = toMs - days * DAY_MS
  // lo/hi bound SQLite datetime text; loMs/hiMs bound test_result's epoch ms.
  return { from: list[0], to, days: list, lo: list[0], hi: dateOf(toMs + DAY_MS), loMs, hiMs: toMs + DAY_MS }
}

const selectProjects = db.prepare('SELECT id, name FROM project ORDER BY name, id')

function projectsFor(project) {
  // HZ-654: `Unlinked items` holds the items with no project, which are in none.
  const all = selectProjects
    .all()
    .filter((row) => !hasNoProject(db, row.id))
    .map((row) => ({ id: String(row.id), name: row.name }))
  return project === 'all' ? all : all.filter((row) => row.id === project)
}

// ---- the queries ----

// Each lists the window's rows of the chosen projects (`ids`, a JSON array).
// Items with no project (the demo seed) are in none.
const IN_PROJECTS = 'w.project_id IN (SELECT value FROM json_each(@ids))'
const IN_ITEMS = 'item_id IN (SELECT value FROM json_each(@items))'

// The window's runs, grouped in SQL so a month of them is a few hundred rows,
// not tens of thousands. `agent` is 0 only for a run with no agent
// (agent_run = 0); a NULL agent_run is an agent run not captured. SUM of
// only NULLs is NULL, so an uncaptured group's figures stay null.
const selectWindowRuns = db.prepare(`
  SELECT substr(r.started_at, 1, 10) AS day, w.project_id, r.step_index, r.model, (r.agent_run IS NOT 0) AS agent,
         COUNT(*) AS n, SUM(r.cost_usd) AS cost_usd, SUM(r.input_tokens) AS input_tokens, SUM(r.output_tokens) AS output_tokens,
         SUM(CASE WHEN r.rule_blocked THEN 1 ELSE 0 END) AS rule_blocks,
         SUM(CASE WHEN r.usage_limit_hit THEN 1 ELSE 0 END) AS usage_limits,
         SUM(r.fallback_from IS NOT NULL) AS fallbacks
    FROM step_run r JOIN work_item w ON w.id = r.item_id
   WHERE r.started_at >= @lo AND r.started_at < @hi AND ${IN_PROJECTS}
   GROUP BY day, w.project_id, r.step_index, r.model, agent`)

// An item's close: an approve at its kind's last gate, or GitHub closing its
// issue (store.upsertFromGithub writes that event as `closed issue #<n>`). The
// latest one counts, and only for an item still closed and not abandoned.
const selectCloses = db.prepare(`
  SELECT c.item_id, MAX(c.at) AS closed_at, w.kind, w.cursor, w.repo, w.project_id, w.abandoned_at
    FROM (
      SELECT item_id, created_at AS at FROM gate_decision
       WHERE decision = 'approved' AND step_index IN (SELECT value FROM json_each(@lastGates))
         AND created_at >= @lo AND created_at < @hi
      UNION ALL
      SELECT item_id, created_at AS at FROM event
       WHERE who = 'GitHub' AND text LIKE 'closed issue #%' AND created_at >= @lo AND created_at < @hi
    ) c JOIN work_item w ON w.id = c.item_id
   WHERE ${IN_PROJECTS}
   GROUP BY c.item_id`)

const selectApprovals = db.prepare(`
  SELECT g.item_id, g.step_index, g.created_at
    FROM gate_decision g JOIN work_item w ON w.id = g.item_id
   WHERE g.decision = 'approved' AND g.created_at >= @lo AND g.created_at < @hi AND ${IN_PROJECTS}`)

const selectItemRuns = db.prepare(`
  SELECT item_id, step_index, started_at, agent_started_at, ended_at, checks_ms, agent_run, input_tokens, output_tokens, cost_usd
    FROM step_run WHERE ${IN_ITEMS}`)

const selectItemDecisions = db.prepare(`
  SELECT item_id, step_index, decision, created_at FROM gate_decision WHERE ${IN_ITEMS} ORDER BY created_at, id`)

// orchestrator.finalizeReviewStep's two failing-review events: sent back to
// implement, or forwarded to the gate at the cap.
const selectReviewFails = db.prepare(`
  SELECT item_id, COUNT(*) AS n FROM event
   WHERE ${IN_ITEMS} AND (text LIKE 'automated review failed%' OR text LIKE 'automated review cap%')
   GROUP BY item_id`)

// orchestrator.failFarmRun's pause event, `agent step failed (<reason>): ...`.
const selectStepFailures = db.prepare(`
  SELECT e.text, e.created_at FROM event e JOIN work_item w ON w.id = e.item_id
   WHERE e.created_at >= @lo AND e.created_at < @hi AND e.who = 'Horizon' AND e.text LIKE 'agent step failed (%'
     AND ${IN_PROJECTS}`)

// A check run that finished failing: a fail on its last attempt, so a flake
// the farm's rerun cleared is not counted.
const selectFailedChecks = db.prepare(`
  SELECT t.check_run, MIN(t.created_at_ms) AS at
    FROM test_result t JOIN work_item w ON w.id = t.item_id
   WHERE t.created_at_ms >= @loMs AND t.created_at_ms < @hiMs AND t.status = 'fail' AND ${IN_PROJECTS}
     AND t.attempt = (SELECT MAX(u.attempt) FROM test_result u WHERE u.check_run = t.check_run)
   GROUP BY t.check_run`)

const selectAtGates = db.prepare(`
  SELECT w.id, w.kind, w.cursor, w.rejected, w.abandoned_at, w.project_id FROM work_item w
   WHERE w.cursor IN (SELECT value FROM json_each(@gates)) AND ${IN_PROJECTS}`)

const SCOPE_REASONS = [REASON.READ_ONLY_VIOLATED, REASON.JOB_CWD_REFUSED].map((reason) => `agent step failed (${reason})`)

// ---- the model x step matrix rows ----

// One row per agent step of the first kind, then one grouped row per later
// kind, named from its first and last agent rows.
const MATRIX_ROWS = (() => {
  const rows = []
  const rowOf = new Map()
  for (const kind of ITEM_KINDS) {
    const agentRows = STEPS.flatMap((step, index) => (step.kind === 'agent' && itemKindOf({ kind: step.itemKind }) === kind ? [index] : []))
    if (agentRows.length === 0) continue
    if (kind === FIRST_KIND) {
      for (const index of agentRows) {
        rowOf.set(index, rows.length)
        rows.push(STEPS[index].label)
      }
    } else {
      const label = `${itemKindInfo(kind).label} steps (${STEPS[agentRows[0]].label} → ${STEPS[agentRows.at(-1)].label})`
      for (const index of agentRows) rowOf.set(index, rows.length)
      rows.push(label)
    }
  }
  return { labels: rows, rowOf }
})()

// The gates in lifecycle order: the first kind's by step number (as the
// board numbers them), every later kind's by name.
const GATES = ITEM_KINDS.flatMap((kind) =>
  gateStepIndexes(STEPS, kind).map((index) => ({
    index,
    name: kind === FIRST_KIND ? String(index - firstStepIndex(kind)) : `${itemKindInfo(kind).label}: ${STEPS[index].label}`,
  })),
)
const LAST_GATES = ITEM_KINDS.map((kind) => endIndex(kind) - 1)

// ---- the report ----

// The report for one range and project at `now`. Read-only.
export function productivityReport({ range, project }, { now = Date.now() } = {}) {
  const win = windowFor(range, now)
  const projects = projectsFor(project)
  const ids = JSON.stringify(projects.map((p) => Number(p.id)))
  const bounds = { lo: win.lo, hi: win.hi, ids }

  const runs = selectWindowRuns.all(bounds)
  const closes = selectCloses
    .all({ ...bounds, lastGates: JSON.stringify(LAST_GATES) })
    .filter((row) => isClosed(row) && !isAbandoned(row))
  const approvals = selectApprovals.all(bounds)

  const itemIds = JSON.stringify([...new Set([...closes.map((c) => c.item_id), ...approvals.map((a) => a.item_id)])])
  const runsByItem = groupBy(selectItemRuns.all({ items: itemIds }), 'item_id')
  const decisionsByItem = groupBy(selectItemDecisions.all({ items: itemIds }), 'item_id')
  const reviewFails = new Map(selectReviewFails.all({ items: itemIds }).map((row) => [row.item_id, row.n]))
  const gateWait = gateWaitFor(runsByItem, decisionsByItem)

  const closed = closes.map((row) =>
    closedItem(row, runsByItem.get(row.item_id) ?? [], decisionsByItem.get(row.item_id) ?? [], reviewFails, gateWait),
  )

  const agentRuns = runs.filter((run) => run.agent)
  const count = (groups) => groups.reduce((sum, run) => sum + run.n, 0)
  const agentCount = count(agentRuns)
  let cost = null
  for (const run of runs) cost = addNullable(cost, run.cost_usd)

  return {
    source: 'live',
    range,
    project,
    from: win.from,
    to: win.to,
    projects,
    summary: {
      closed: closed.length,
      steps: count(runs),
      // Of the runs that could name a model: a run with no agent has none.
      modelCoverage: agentCount ? round(count(agentRuns.filter((run) => run.model != null)) / agentCount, 4) : 0,
      cost: money(cost),
      costPerItem: money(median(closed.map((item) => item.cost).filter((value) => value != null))),
    },
    closedPerDay: closedPerDay(win, projects, closed),
    costPerDay: costPerDay(win, projects, runs),
    topItems: topItems(closed),
    models: modelMatrix(agentRuns),
    cycleTime: { byKind: cycleTime(closed) },
    rework: rework(closed),
    failures: failures(win, runs, bounds),
    approvals: { gates: approvalGates(win, approvals, gateWait, ids) },
  }
}

function groupBy(rows, key) {
  const map = new Map()
  for (const row of rows) {
    const list = map.get(row[key])
    if (list) list.push(row)
    else map.set(row[key], [row])
  }
  return map
}

// Minutes from a gate opening to a decision on it. The gate opened when the
// item's last run before the decision ended, or at its previous decision when
// that came later (two gates in a row). null when neither exists.
function gateWaitFor(runsByItem, decisionsByItem) {
  // Each item's run ends and decision times, parsed once.
  const times = new Map()
  const timesOf = (itemId) => {
    let entry = times.get(itemId)
    if (!entry) {
      entry = {
        ended: (runsByItem.get(itemId) ?? []).flatMap((run) => (run.ended_at == null ? [] : [msOf(run.ended_at)])),
        decided: (decisionsByItem.get(itemId) ?? []).map((decision) => msOf(decision.created_at)),
      }
      times.set(itemId, entry)
    }
    return entry
  }
  return (itemId, decidedAt) => {
    const decided = msOf(decidedAt)
    const { ended, decided: decisions } = timesOf(itemId)
    let opened = null
    for (const at of ended) if (at <= decided && (opened == null || at > opened)) opened = at
    for (const at of decisions) if (at < decided && (opened == null || at > opened)) opened = at
    return opened == null ? null : (decided - opened) / 60_000
  }
}

function closedItem(row, runs, decisions, reviewFails, gateWait) {
  let cost = null
  let tokens = null
  const split = { agentsWorking: 0, waitingOnYou: 0, queued: 0, checksAndDeploy: 0 }
  for (const run of runs) {
    cost = addNullable(cost, run.cost_usd)
    if (run.input_tokens != null && run.output_tokens != null) tokens = addNullable(tokens, run.input_tokens + run.output_tokens)
    if (run.ended_at == null) continue
    const started = msOf(run.started_at)
    const working = run.agent_started_at ? msOf(run.agent_started_at) : started
    const ran = Math.max(msOf(run.ended_at) - working, 0)
    split.queued += Math.max(working - started, 0)
    if (run.step_index === DEPLOY_STEP_INDEX || run.agent_run === 0) {
      split.checksAndDeploy += ran
    } else {
      const checks = Math.min(run.checks_ms || 0, ran)
      split.checksAndDeploy += checks
      split.agentsWorking += ran - checks
    }
  }
  for (const decision of decisions) {
    const wait = gateWait(row.item_id, decision.created_at)
    if (wait != null) split.waitingOnYou += wait * 60_000
  }
  return {
    id: row.item_id,
    kind: itemKindOf(row),
    project: String(row.project_id),
    repo: row.repo,
    day: dayOf(row.closed_at),
    steps: runs.length,
    tokens,
    cost,
    split,
    sendBacks: decisions.filter((d) => d.decision === 'rejected').length,
    reviewFails: reviewFails.get(row.item_id) ?? 0,
  }
}

function closedPerDay(win, projects, closed) {
  const counts = new Map()
  for (const item of closed) counts.set(`${item.day}|${item.project}`, (counts.get(`${item.day}|${item.project}`) ?? 0) + 1)
  return win.days.map((date) => ({
    date,
    byProject: projects.map((p) => ({ project: p.id, count: counts.get(`${date}|${p.id}`) ?? 0 })),
  }))
}

function costPerDay(win, projects, runs) {
  const cells = new Map()
  for (const run of runs) {
    const key = `${run.day}|${run.project_id}`
    const cell = cells.get(key) ?? { cost: null, inputTokens: null, outputTokens: null }
    cell.cost = addNullable(cell.cost, run.cost_usd)
    cell.inputTokens = addNullable(cell.inputTokens, run.input_tokens)
    cell.outputTokens = addNullable(cell.outputTokens, run.output_tokens)
    cells.set(key, cell)
  }
  return win.days.map((date) => ({
    date,
    byProject: projects.map((p) => {
      const cell = cells.get(`${date}|${p.id}`)
      return { project: p.id, cost: money(cell?.cost ?? null), inputTokens: cell?.inputTokens ?? null, outputTokens: cell?.outputTokens ?? null }
    }),
  }))
}

function topItems(closed) {
  return [...closed]
    .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.steps - a.steps || a.id.localeCompare(b.id))
    .slice(0, TOP_ITEMS)
    .map((item) => ({ id: item.id, kind: item.kind, project: item.project, steps: item.steps, tokens: item.tokens, cost: money(item.cost) }))
}

// Columns: every model that ran, most runs first. A run with no agent is in
// no column and is not "not recorded" either.
function modelMatrix(agentRuns) {
  const totals = new Map()
  const cells = MATRIX_ROWS.labels.map(() => ({ counts: new Map(), notRecorded: 0 }))
  for (const run of agentRuns) {
    const row = MATRIX_ROWS.rowOf.get(run.step_index)
    if (row == null) continue
    if (run.model == null) {
      cells[row].notRecorded += run.n
      continue
    }
    totals.set(run.model, (totals.get(run.model) ?? 0) + run.n)
    cells[row].counts.set(run.model, (cells[row].counts.get(run.model) ?? 0) + run.n)
  }
  const columns = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a) || a.localeCompare(b))
  return {
    columns,
    rows: MATRIX_ROWS.labels.map((step, i) => ({
      step,
      runs: columns.map((model) => ({ model, count: cells[i].counts.get(model) ?? 0 })),
      notRecorded: cells[i].notRecorded,
    })),
  }
}

// Median minutes per closed item, each part on its own, for each kind that
// closed something in the window.
function cycleTime(closed) {
  return ITEM_KINDS.flatMap((kind) => {
    const items = closed.filter((item) => item.kind === kind)
    if (items.length === 0) return []
    const part = (key) => minutes(median(items.map((item) => item.split[key])))
    return [
      {
        kind,
        medianMinutes: {
          agentsWorking: part('agentsWorking'),
          waitingOnYou: part('waitingOnYou'),
          queued: part('queued'),
          checksAndDeploy: part('checksAndDeploy'),
        },
      },
    ]
  })
}

function rework(closed) {
  const mean = (items, key) => (items.length ? round(items.reduce((sum, item) => sum + item[key], 0) / items.length, 2) : 0)
  const repos = [...new Set(closed.map((item) => item.repo).filter(Boolean))].sort()
  return {
    firstPassYield: closed.length ? round(closed.filter((item) => item.sendBacks === 0 && item.reviewFails === 0).length / closed.length, 4) : 0,
    sendBacksPerItem: mean(closed, 'sendBacks'),
    reviewFailCyclesPerItem: mean(closed, 'reviewFails'),
    byRepo: repos.map((repo) => {
      const items = closed.filter((item) => item.repo === repo)
      return { repo, sendBacksPerItem: mean(items, 'sendBacks'), reviewFailCyclesPerItem: mean(items, 'reviewFails') }
    }),
  }
}

function failures(win, runs, bounds) {
  const weeks = new Map()
  for (let week = mondayOf(win.from); week <= win.to; week = dateOf(Date.parse(`${week}T00:00:00Z`) + 7 * DAY_MS)) {
    weeks.set(week, { week, checksFailed: 0, ruleBlocks: 0, scopeViolations: 0, usageLimits: 0, providerFallbacks: 0 })
  }
  const bump = (date, key, by = 1) => {
    const week = weeks.get(mondayOf(date))
    if (week) week[key] += by
  }
  for (const run of runs) {
    bump(run.day, 'ruleBlocks', run.rule_blocks)
    bump(run.day, 'usageLimits', run.usage_limits)
    bump(run.day, 'providerFallbacks', run.fallbacks)
  }
  for (const event of selectStepFailures.all(bounds)) {
    if (SCOPE_REASONS.some((prefix) => event.text.startsWith(prefix))) bump(dayOf(event.created_at), 'scopeViolations')
  }
  for (const check of selectFailedChecks.all({ ids: bounds.ids, loMs: win.loMs, hiMs: win.hiMs })) bump(dateOf(check.at), 'checksFailed')
  return [...weeks.values()]
}

function approvalGates(win, approvals, gateWait, ids) {
  const queue = new Map()
  for (const item of selectAtGates.all({ ids, gates: JSON.stringify(GATES.map((g) => g.index)) })) {
    if (awaitingGate(item)) queue.set(item.cursor, (queue.get(item.cursor) ?? 0) + 1)
  }
  const byGate = groupBy(approvals, 'step_index')
  return GATES.map((gate) => {
    const mine = byGate.get(gate.index) ?? []
    const perDay = new Map()
    for (const a of mine) perDay.set(dayOf(a.created_at), (perDay.get(dayOf(a.created_at)) ?? 0) + 1)
    const waits = mine.map((a) => gateWait(a.item_id, a.created_at)).filter((wait) => wait != null)
    const wait = median(waits)
    return {
      gate: gate.name,
      approvedPerDay: win.days.map((date) => ({ date, count: perDay.get(date) ?? 0 })),
      medianWaitMinutes: wait == null ? null : round(wait, 1),
      queue: queue.get(gate.index) ?? 0,
    }
  })
}
