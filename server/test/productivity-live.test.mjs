// HZ-550 metrics 2 and 3: GET /api/admin/productivity aggregates Horizon's own
// DB. A seeded DB with known runs, closes, gate decisions, events and check
// results gives a report that validates against HZ-549's schema and whose every
// figure below was computed by hand from the seed. Runs from before capture
// read null cost (never 0) and count against model coverage. The journey test
// completes one run with the farm's stub usage and finds its cost in the report.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'
import { loginFixtureUser } from './helpers/session.mjs'
import { validate } from '../../domain/validate.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'horizon-productivity-live-'))
process.env.HORIZON_DB = join(scratch, 'test.db')
process.env.HOME = join(scratch, 'home')
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { productivityReport, median } = await import('../src/productivity.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { STEPS, endIndex, kindStepIndex, DEPLOY_STEP_INDEX, IMPLEMENT_STEP_INDEX, EXECUTE_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { OPTIONS_STEP_INDEX } = await import('../src/split.js')

const readJson = (rel) => JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
const schema = readJson('domain/productivity.schema.json')
const STUB = readJson('farm/tests/fixtures/usage_stub.json')

store.purgeDemoItems()
const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())
const admin = loginFixtureUser(auth, config, { email: config.ADMIN_EMAIL, name: 'Admin' })

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const NOW = Date.parse('2026-10-24T12:00:00Z')
const PLAN_OPTIONS = OPTIONS_STEP_INDEX
const DRAFT_PLAN = STEPS.findIndex((s) => s.agent === 'Eng' && (s.itemKind ?? 'change') === 'change')
const ASSESS = kindStepIndex('Assess', 'task')
const APPROVE_RUN = kindStepIndex('Approve the run', 'task')
const CHANGE_DONE = endIndex('change')
const TASK_DONE = endIndex('task')

// ---- the seed ----

const project = (name) => db.prepare('INSERT INTO project (name) VALUES (?)').run(name).lastInsertRowid
const ALPHA = project('Alpha')
const BETA = project('Beta')

function item(id, { projectId, kind = 'change', cursor, repo = null, abandoned = false }) {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo, abandoned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    id,
    'Medium',
    cursor,
    kind,
    projectId,
    repo,
    abandoned ? '2026-10-18 13:00:00' : null,
  )
}

// One run. `usage` is [input, output, cost] for a captured agent run, 'none'
// for a run with no agent (0s), or omitted for a row from before capture.
function run(itemId, stepIndex, { started, agentStarted = null, ended, model = null, usage, checksMs = 0, flags = {} }) {
  const [input, output, cost, agentRun] =
    usage === 'none' ? [0, 0, 0, 0] : usage ? [...usage, 1] : [null, null, null, null]
  db.prepare(
    `INSERT INTO step_run (item_id, step_index, attempt, agent, status, started_at, agent_started_at, ended_at, model, checks_ms,
       agent_run, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, rule_blocked, usage_limit_hit, fallback_from)
     VALUES (?, ?, 1, 'X', 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    itemId,
    stepIndex,
    started,
    agentStarted,
    ended,
    model,
    checksMs,
    agentRun,
    input,
    output,
    input == null ? null : 7,
    input == null ? null : 3,
    cost,
    flags.ruleBlocked ? 1 : 0,
    flags.usageLimit ? 1 : 0,
    flags.fallbackFrom ?? null,
  )
}

const decide = (itemId, stepIndex, decision, at) =>
  db.prepare('INSERT INTO gate_decision (item_id, step_index, decision, created_at) VALUES (?, ?, ?, ?)').run(itemId, stepIndex, decision, at)
const event = (itemId, who, text, at) =>
  db.prepare("INSERT INTO event (item_id, who, text, color, initials, created_at) VALUES (?, ?, ?, '#000', 'X', ?)").run(itemId, who, text, at)
const checkRow = (itemId, checkRun, status, attempt, at) =>
  db
    .prepare(
      "INSERT INTO test_result (repo, item_id, source, check_run, command, test, status, attempt, created_at_ms) VALUES ('acme/x', ?, 'implement', ?, 'npm test', 't', ?, ?, ?)",
    )
    .run(itemId, checkRun, status, attempt, Date.parse(at))

// A1 (Alpha, change): three captured runs, closed at gate 15 on the 20th.
item('A1', { projectId: ALPHA, cursor: CHANGE_DONE, repo: 'acme/alpha' })
run('A1', PLAN_OPTIONS, { started: '2026-10-19 10:00:00', agentStarted: '2026-10-19 10:05:00', ended: '2026-10-19 10:35:00', model: OPUS, usage: [1000, 100, 0.5] })
run('A1', IMPLEMENT_STEP_INDEX, {
  started: '2026-10-19 12:00:00',
  agentStarted: '2026-10-19 12:10:00',
  ended: '2026-10-19 13:10:00',
  model: OPUS,
  usage: [3000, 300, 1.25],
  checksMs: 20 * 60_000,
})
run('A1', DEPLOY_STEP_INDEX, { started: '2026-10-20 09:00:00', agentStarted: '2026-10-20 09:00:00', ended: '2026-10-20 09:15:00', model: OPUS, usage: [500, 50, 0.25] })
decide('A1', 5, 'approved', '2026-10-19 11:00:00') // waited 25 min (10:35 →)
decide('A1', 13, 'rejected', '2026-10-19 14:10:00') // waited 60 min (13:10 →), a send-back
decide('A1', 15, 'approved', '2026-10-20 15:00:00') // waited 345 min (09:15 →), the close
checkRow('A1', 'cr-flake', 'fail', 1, '2026-10-19T12:30:00Z') // cleared by its rerun: not counted
checkRow('A1', 'cr-flake', 'pass', 2, '2026-10-19T12:31:00Z')

// A2 (Alpha, change): one run from before capture, closed on GitHub on the 22nd.
item('A2', { projectId: ALPHA, cursor: CHANGE_DONE, repo: 'acme/alpha' })
run('A2', DRAFT_PLAN, { started: '2026-10-21 08:00:00', agentStarted: '2026-10-21 08:00:00', ended: '2026-10-21 08:30:00', model: SONNET, flags: { usageLimit: true } })
decide('A2', 10, 'approved', '2026-10-21 09:00:00') // waited 30 min
event('A2', 'Review', 'automated review failed (cycle 1/3) — sent back', '2026-10-21 10:00:00')
event('A2', 'GitHub', 'closed issue #12', '2026-10-22 09:00:00')

// B1 (Beta, task): Assess, then a job, closed at the task's last gate on the 22nd.
item('B1', { projectId: BETA, kind: 'task', cursor: TASK_DONE, repo: 'acme/beta' })
run('B1', ASSESS, {
  started: '2026-10-22 10:00:00',
  agentStarted: '2026-10-22 10:02:00',
  ended: '2026-10-22 10:12:00',
  model: OPUS,
  usage: [200, 20, 0.125],
  flags: { fallbackFrom: 'muse:muse-spark-1.3' },
})
run('B1', EXECUTE_STEP_INDEX, { started: '2026-10-22 11:00:00', ended: '2026-10-22 11:30:00', usage: 'none' })
decide('B1', APPROVE_RUN, 'approved', '2026-10-22 10:52:00') // waited 40 min
decide('B1', TASK_DONE - 1, 'approved', '2026-10-22 18:00:00') // waited 390 min (11:30 →), the close

// B2 (Beta, change): open, waiting at gate 10.
item('B2', { projectId: BETA, cursor: 10, repo: 'acme/beta' })
run('B2', 0, { started: '2026-10-23 07:00:00', ended: '2026-10-23 07:30:00', model: OPUS, usage: [100, 10, 0.0625] })
run('B2', DRAFT_PLAN, { started: '2026-10-23 09:00:00', ended: '2026-10-23 09:20:00', flags: { ruleBlocked: true } })
decide('B2', 3, 'approved', '2026-10-23 08:00:00') // waited 30 min
event('B2', 'Horizon', 'agent step failed (read_only_violated): wrote outside its scope — item paused; resume to retry', '2026-10-23 09:30:00')
checkRow('B2', 'cr-red', 'fail', 1, '2026-10-23T09:10:00Z')

// X1 (Alpha): approved at gate 15 in the window, then abandoned — not a close.
item('X1', { projectId: ALPHA, cursor: CHANGE_DONE, repo: 'acme/alpha', abandoned: true })
run('X1', PLAN_OPTIONS, { started: '2026-10-18 10:00:00', ended: '2026-10-18 10:10:00', model: OPUS, usage: [50, 5, 0.03125] })
decide('X1', 15, 'approved', '2026-10-18 12:00:00') // waited 110 min

// O1 (Alpha): closed before the window — in nothing.
item('O1', { projectId: ALPHA, cursor: CHANGE_DONE, repo: 'acme/alpha' })
run('O1', PLAN_OPTIONS, { started: '2026-10-09 10:00:00', ended: '2026-10-09 10:10:00', model: OPUS, usage: [9, 9, 9] })
decide('O1', 15, 'approved', '2026-10-10 12:00:00')

const DAYS = ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']
const A = String(ALPHA)
const B = String(BETA)
const report = productivityReport({ range: '7d', project: 'all' }, { now: NOW })
const byDate = (series, date) => series.find((d) => d.date === date).byProject

// ---- metric 2 ----

test('the seeded report validates against HZ-549’s schema and says it is live', () => {
  assert.deepEqual(validate(schema, report), [])
  assert.equal(report.source, 'live')
  assert.deepEqual([report.range, report.project, report.from, report.to], ['7d', 'all', '2026-10-17', '2026-10-24'])
  assert.ok(report.projects.some((p) => p.id === A && p.name === 'Alpha'))
  assert.ok(report.projects.some((p) => p.id === B && p.name === 'Beta'))
})

test('summary: 3 closed, 9 runs, 7 of 8 agent runs with a model, the captured cost and the median item cost', () => {
  // X1 is abandoned and O1 closed before the window.
  assert.deepEqual(report.summary, { closed: 3, steps: 9, modelCoverage: 0.875, cost: 2.21875, costPerItem: 1.0625 })
})

test('closed per day by project', () => {
  assert.deepEqual(report.closedPerDay.map((d) => d.date), DAYS)
  const count = (date, id) => byDate(report.closedPerDay, date).find((p) => p.project === id).count
  assert.equal(count('2026-10-20', A), 1)
  assert.equal(count('2026-10-22', A), 1)
  assert.equal(count('2026-10-22', B), 1)
  const total = report.closedPerDay.flatMap((d) => d.byProject.map((p) => p.count)).reduce((a, b) => a + b, 0)
  assert.equal(total, 3)
})

test('cost per day by project: captured runs summed, a day of only old rows null', () => {
  const cell = (date, id) => byDate(report.costPerDay, date).find((p) => p.project === id)
  assert.deepEqual(cell('2026-10-18', A), { project: A, cost: 0.03125, inputTokens: 50, outputTokens: 5 })
  assert.deepEqual(cell('2026-10-19', A), { project: A, cost: 1.75, inputTokens: 4000, outputTokens: 400 })
  assert.deepEqual(cell('2026-10-20', A), { project: A, cost: 0.25, inputTokens: 500, outputTokens: 50 })
  // A2's run is from before capture: not captured, not free.
  assert.deepEqual(cell('2026-10-21', A), { project: A, cost: null, inputTokens: null, outputTokens: null })
  // The job's 0 is a captured 0.
  assert.deepEqual(cell('2026-10-22', B), { project: B, cost: 0.125, inputTokens: 200, outputTokens: 20 })
  assert.deepEqual(cell('2026-10-23', B), { project: B, cost: 0.0625, inputTokens: 100, outputTokens: 10 })
  assert.deepEqual(cell('2026-10-17', A), { project: A, cost: null, inputTokens: null, outputTokens: null })
})

test('top items: most expensive first, an uncaptured item last with null cost', () => {
  assert.deepEqual(report.topItems, [
    { id: 'A1', kind: 'change', project: A, steps: 3, tokens: 4950, cost: 2 },
    { id: 'B1', kind: 'task', project: B, steps: 2, tokens: 220, cost: 0.125 },
    { id: 'A2', kind: 'change', project: A, steps: 1, tokens: null, cost: null },
  ])
})

test('the model matrix: counts per step and model, and the runs with no model recorded', () => {
  assert.deepEqual(report.models.columns, [OPUS, SONNET])
  const rowFor = (index) => report.models.rows.find((r) => r.step === STEPS[index].label)
  const counts = (r) => Object.fromEntries(r.runs.map((c) => [c.model, c.count]))
  assert.deepEqual(counts(rowFor(0)), { [OPUS]: 1, [SONNET]: 0 })
  assert.deepEqual(counts(rowFor(PLAN_OPTIONS)), { [OPUS]: 2, [SONNET]: 0 })
  assert.deepEqual({ ...counts(rowFor(DRAFT_PLAN)), notRecorded: rowFor(DRAFT_PLAN).notRecorded }, { [OPUS]: 0, [SONNET]: 1, notRecorded: 1 })
  assert.deepEqual(counts(rowFor(IMPLEMENT_STEP_INDEX)), { [OPUS]: 1, [SONNET]: 0 })
  assert.deepEqual(counts(rowFor(DEPLOY_STEP_INDEX)), { [OPUS]: 1, [SONNET]: 0 })
  // The Task row holds Assess; its job is no agent, so in no column and not "not recorded".
  const taskRow = report.models.rows.find((r) => r.step.startsWith('Task steps'))
  assert.deepEqual({ ...counts(taskRow), notRecorded: taskRow.notRecorded }, { [OPUS]: 1, [SONNET]: 0, notRecorded: 0 })
  const all = report.models.rows.flatMap((r) => r.runs.map((c) => c.count)).reduce((a, b) => a + b, 0)
  const unrecorded = report.models.rows.reduce((a, r) => a + r.notRecorded, 0)
  assert.equal(all + unrecorded, 8)
})

test('median gate wait: an even number of waits takes the mean of the middle two', () => {
  const gate = (name) => report.approvals.gates.find((g) => g.gate === name)
  // Gate 15: X1 waited 110 min, A1 345 min.
  assert.equal(gate('15').medianWaitMinutes, 227.5)
  assert.equal(gate('5').medianWaitMinutes, 25)
  assert.equal(gate('10').medianWaitMinutes, 30)
  assert.equal(gate('3').medianWaitMinutes, 30)
  // A send-back is not an approval.
  assert.equal(gate('13').medianWaitMinutes, null)
  const counts = (name) => Object.fromEntries(gate(name).approvedPerDay.filter((d) => d.count).map((d) => [d.date, d.count]))
  assert.deepEqual(counts('15'), { '2026-10-18': 1, '2026-10-20': 1 })
  assert.equal(gate('10').queue, 1) // B2 is waiting there
  const task = report.approvals.gates.filter((g) => g.medianWaitMinutes != null && g.gate.startsWith('Task'))
  assert.deepEqual(task.map((g) => g.medianWaitMinutes).sort((a, b) => a - b), [40, 390])
  assert.equal(median([1, 2, 3, 4]), 2.5)
})

test('cycle time split per kind: median minutes of each part', () => {
  assert.deepEqual(report.cycleTime.byKind, [
    // A1: 70 working, 430 waiting, 15 queued, 35 checks+deploy. A2: 30, 30, 0, 0.
    { kind: 'change', medianMinutes: { agentsWorking: 50, waitingOnYou: 230, queued: 7.5, checksAndDeploy: 17.5 } },
    { kind: 'task', medianMinutes: { agentsWorking: 10, waitingOnYou: 430, queued: 2, checksAndDeploy: 30 } },
  ])
})

test('rework: send-backs and failed review cycles per closed item, by repo', () => {
  assert.deepEqual(report.rework, {
    firstPassYield: 0.3333,
    sendBacksPerItem: 0.33,
    reviewFailCyclesPerItem: 0.33,
    byRepo: [
      { repo: 'acme/alpha', sendBacksPerItem: 0.5, reviewFailCyclesPerItem: 0.5 },
      { repo: 'acme/beta', sendBacksPerItem: 0, reviewFailCyclesPerItem: 0 },
    ],
  })
})

test('failure reasons per week', () => {
  assert.deepEqual(report.failures, [
    { week: '2026-10-12', checksFailed: 0, ruleBlocks: 0, scopeViolations: 0, usageLimits: 0, providerFallbacks: 0 },
    { week: '2026-10-19', checksFailed: 1, ruleBlocks: 1, scopeViolations: 1, usageLimits: 1, providerFallbacks: 1 },
  ])
})

test('one project narrows every series to it', () => {
  const beta = productivityReport({ range: '7d', project: B }, { now: NOW })
  assert.deepEqual(validate(schema, beta), [])
  assert.deepEqual(beta.projects, [{ id: B, name: 'Beta' }])
  assert.deepEqual([beta.summary.closed, beta.summary.steps, beta.summary.cost], [1, 4, 0.1875])
  assert.ok(beta.closedPerDay.every((d) => d.byProject.length === 1 && d.byProject[0].project === B))
  const unknown = productivityReport({ range: '7d', project: 'no-such-project' }, { now: NOW })
  assert.deepEqual(validate(schema, unknown), [])
  assert.deepEqual([unknown.projects, unknown.summary.closed, unknown.summary.cost], [[], 0, null])
})

// ---- metric 3: old rows are null, and count against coverage ----

test('3 runs from before capture and 7 after: coverage 0.7, and the old rows’ day costs null', () => {
  const gamma = project('Gamma')
  item('G1', { projectId: gamma, cursor: PLAN_OPTIONS })
  for (let i = 0; i < 3; i++) run('G1', PLAN_OPTIONS, { started: `2026-10-17 0${i}:00:00`, ended: `2026-10-17 0${i}:30:00` })
  for (let i = 0; i < 7; i++) run('G1', PLAN_OPTIONS, { started: `2026-10-24 0${i}:00:00`, ended: `2026-10-24 0${i}:30:00`, model: OPUS, usage: [10, 1, 0.01] })
  const res = productivityReport({ range: '7d', project: String(gamma) }, { now: NOW })
  assert.deepEqual(validate(schema, res), [])
  assert.equal(res.summary.modelCoverage, 0.7)
  assert.equal(res.summary.cost, 0.07)
  assert.deepEqual(byDate(res.costPerDay, '2026-10-17')[0], { project: String(gamma), cost: null, inputTokens: null, outputTokens: null })
  assert.doesNotMatch(JSON.stringify(res), /"(cost|costPerItem|tokens|inputTokens|outputTokens)":0[,}]/)
})

// ---- the journey: a run completes, the report shows its cost ----

test('a run completed with the stub’s usage shows up in that day’s cost and the summary', async () => {
  const delta = project('Delta')
  item('D1', { projectId: delta, cursor: PLAN_OPTIONS })
  const runId = db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)')
    .run('D1', PLAN_OPTIONS, STEPS[PLAN_OPTIONS].agent).lastInsertRowid
  const done = await orchestrator.completeFarmRun(runId, {
    summary: 'proposed three options',
    artifacts: { artifact_md: '## Options', provider: STUB.provider, model: STUB.model, usage: STUB.usage },
  })
  assert.deepEqual(done, { ok: true })

  const res = await app.inject({ method: 'GET', url: `/api/admin/productivity?range=7d&project=${delta}`, headers: { cookie: admin.cookie } })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.deepEqual(validate(schema, body), [])
  assert.equal(body.source, 'live')
  assert.equal(body.summary.cost, STUB.usage.cost_usd)
  assert.equal(body.summary.modelCoverage, 1)
  const today = body.costPerDay.at(-1).byProject[0]
  assert.deepEqual(today, {
    project: String(delta),
    cost: STUB.usage.cost_usd,
    inputTokens: STUB.usage.input_tokens,
    outputTokens: STUB.usage.output_tokens,
  })
  assert.deepEqual(body.models.columns, [STUB.model])
  // Guardrail 1: the report carries figures, never the run's text or a prompt.
  assert.ok(!res.body.includes('proposed three options'))
  assert.ok(!res.body.includes(STUB.prompt_marker))
})
