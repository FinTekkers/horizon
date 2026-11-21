// HZ-921 metrics 2-4: an item's Effort & cost summary (server/src/itemStats.js).
// A seeded item with known step runs, a Request changes, a review fail, asks,
// caretaker rulings, a retry, a usage-limit fallback and gate waits gets a
// summary whose every figure below was worked out by hand from the seed, and
// whose token and cost totals equal Productivity's for the same runs. A quiet
// item reads "No clarification needed"; null turns stay null, never 0. Nothing
// private reaches the summary, the route or the comment.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { REPO_ROOT } from './helpers/repoFiles.mjs'
import { loginFixtureUser } from './helpers/session.mjs'
import { validate } from '../../domain/validate.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'horizon-item-stats-'))
process.env.HORIZON_DB = join(scratch, 'test.db')
process.env.HOME = join(scratch, 'home')
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { productivityReport, itemTimeSplit, gateWaitFor } = await import('../src/productivity.js')
const { ITEM_STATS_SCHEMA, STATS_EVENT_PATTERNS, STATS_KEYS, itemStats } = await import('../src/itemStats.js')
const { renderStatsComment, statsSummaryLine } = await import('../src/statsComment.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { statsVisible } = await import('../../domain/js/itemStats.js')
const { REASON } = await import('../../domain/js/reasons.js')
const { ITEM_KINDS, STEPS, endIndex, stepsFor, stepIndexOf, kindStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
await app.ready()
after(() => app.close())
const admin = loginFixtureUser(auth, config, { email: config.ADMIN_EMAIL, name: 'Admin' })

const NOW = Date.parse('2026-11-12T12:00:00Z')
const at = (key) => stepIndexOf(key)
const PLAN_OPTIONS = at('change.plan-options')
const APPROVE_DESIGN = at('change.approve-design')
const IMPLEMENT = at('change.implement')
const REVIEW = at('change.auto-review')
const ACCEPT = at('change.accept-code')
const DEPLOY = at('change.deploy')
const CLOSE_GATE = at('change.review-close')

const SENTINELS = ['PROMPT-SENTINEL', 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', '/home/ubuntu/']
const SECRET_TEXT = SENTINELS.join(' ')

// ---- the seed ----

const project = (name) => db.prepare('INSERT INTO project (name) VALUES (?)').run(name).lastInsertRowid
const STATS_PROJECT = project('Stats')
const QUIET_PROJECT = project('Quiet')

let issueSeq = 0
function item(id, { projectId, cursor, kind = 'change', repo = 'acme/stats', created = '2026-11-10 09:00:00' }) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo, issue, created_at, lane) VALUES (?, ?, 'High', ?, ?, ?, ?, ?, ?, NULL)",
  ).run(id, id, cursor, kind, projectId, repo, ++issueSeq, created)
}

// usage: [input, output, cache read, cache write, cost, turns], or 'none' for
// a run with no agent (0s, turns NULL).
function run(itemId, stepIndex, { attempt = 1, agent, started, agentStarted = null, ended, checksMs = 0, usage, model = 'claude-opus-5-5' }) {
  const none = usage === 'none'
  const [input, output, cacheRead, cacheWrite, cost, turns] = none ? [0, 0, 0, 0, 0, null] : usage
  return db
    .prepare(
      `INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, started_at, agent_started_at, ended_at, checks_ms, model, provider,
         agent_run, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, num_turns)
       VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, 'claude', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(itemId, stepIndex, attempt, agent, SECRET_TEXT, started, agentStarted, ended, checksMs, none ? null : model, none ? 0 : 1, input, output, cacheRead, cacheWrite, cost, turns)
    .lastInsertRowid
}

const decide = (itemId, stepIndex, decision, created) =>
  db.prepare('INSERT INTO gate_decision (item_id, step_index, decision, notes, created_at) VALUES (?, ?, ?, ?, ?)').run(itemId, stepIndex, decision, SECRET_TEXT, created)
const event = (itemId, who, text, created) =>
  db.prepare("INSERT INTO event (item_id, who, text, color, initials, created_at) VALUES (?, ?, ?, '#000', 'X', ?)").run(itemId, who, text, created)
const ask = (itemId, runId, stepIndex, kind) =>
  db.prepare("INSERT INTO ask (item_id, step_run_id, step_index, kind, draft_json, why) VALUES (?, ?, ?, ?, '{}', ?)").run(itemId, runId, stepIndex, kind, SECRET_TEXT)
function ruling(itemId, gateIndex, outcome, runId) {
  const evalId = db
    .prepare("INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, reason) VALUES (?, ?, ?, 'on', 'send_back', ?)")
    .run(itemId, gateIndex, runId, SECRET_TEXT).lastInsertRowid
  db.prepare(
    "INSERT INTO caretaker_ruling (eval_id, project_id, item_id, gate_index, kind, outcome, reason, created_at_ms) VALUES (?, ?, ?, ?, 'narrow', ?, ?, 0)",
  ).run(evalId, STATS_PROJECT, itemId, gateIndex, outcome, SECRET_TEXT)
}

// IS-1: a change, created 09:00 on the 10th, closed at its last gate at 17:40.
item('IS-1', { projectId: STATS_PROJECT, cursor: endIndex('change') })
run('IS-1', PLAN_OPTIONS, { agent: 'Ensemble', started: '2026-11-10 09:00:00', agentStarted: '2026-11-10 09:01:00', ended: '2026-11-10 09:11:00', usage: [100, 50, 1000, 200, 0.1, 5] })
// Request changes at Approve the design, back to Plan options (store.requestChanges' rows).
decide('IS-1', APPROVE_DESIGN, 'rejected', '2026-11-10 10:11:00')
db.prepare("INSERT INTO feedback (item_id, target, message, step_key, created_at) VALUES ('IS-1', 'Ensemble', ?, 'change.plan-options', '2026-11-10 10:11:00')").run(SECRET_TEXT)
run('IS-1', PLAN_OPTIONS, { attempt: 2, agent: 'Ensemble', started: '2026-11-10 10:20:00', ended: '2026-11-10 10:30:00', usage: [120, 60, 1100, 0, 0.12, 4] })
decide('IS-1', APPROVE_DESIGN, 'approved', '2026-11-10 11:30:00')
const impl1 = run('IS-1', IMPLEMENT, { agent: 'Eng', started: '2026-11-10 12:00:00', agentStarted: '2026-11-10 12:00:00', ended: '2026-11-10 13:00:00', checksMs: 600_000, usage: [1000, 400, 20000, 3000, 1.0, 30] })
const review1 = run('IS-1', REVIEW, { agent: 'Review', started: '2026-11-10 13:00:00', ended: '2026-11-10 13:20:00', usage: [500, 100, 0, 0, 0.25, 8] })
event('IS-1', 'Horizon', `automated review failed: 2 blocking findings ${SECRET_TEXT}`, '2026-11-10 13:20:00')
event('IS-1', 'Horizon', `transient failure (${REASON[Object.keys(REASON)[0]]}): farm hiccup — auto-retrying (1/2)`, '2026-11-10 13:25:00')
event('IS-1', 'Horizon', 'Claude Opus 5.5 hit a usage limit until 18:00 — running “Specialist agent implements” on the next model, same attempt', '2026-11-10 13:28:00')
run('IS-1', IMPLEMENT, { attempt: 2, agent: 'Eng', started: '2026-11-10 13:30:00', agentStarted: '2026-11-10 13:40:00', ended: '2026-11-10 14:10:00', usage: [800, 300, 10000, 1000, 0.75, 20] })
run('IS-1', REVIEW, { attempt: 2, agent: 'Review', started: '2026-11-10 14:10:00', ended: '2026-11-10 14:20:00', usage: [400, 80, 0, 0, 0.2, 6] })
decide('IS-1', ACCEPT, 'approved', '2026-11-10 15:20:00')
run('IS-1', DEPLOY, { agent: 'DevOps', started: '2026-11-10 15:30:00', ended: '2026-11-10 15:40:00', usage: 'none' })
decide('IS-1', CLOSE_GATE, 'approved', '2026-11-10 17:40:00')
ask('IS-1', impl1, IMPLEMENT, 'blocking')
ask('IS-1', review1, REVIEW, 'soft')
ask('IS-1', impl1, IMPLEMENT, 'split') // not a clarification
ruling('IS-1', ACCEPT, 'applied', impl1)
ruling('IS-1', ACCEPT, 'rejected', review1) // not applied: not counted

// IS-2: a quiet closed change. One implement run reported no turns.
item('IS-2', { projectId: QUIET_PROJECT, cursor: endIndex('change') })
run('IS-2', IMPLEMENT, { agent: 'Eng', started: '2026-11-11 10:00:00', ended: '2026-11-11 10:30:00', usage: [10, 5, 0, 0, 0.01, null] })
run('IS-2', REVIEW, { agent: 'Review', started: '2026-11-11 10:30:00', ended: '2026-11-11 10:40:00', usage: [10, 5, 0, 0, 0.01, 7] })
decide('IS-2', CLOSE_GATE, 'approved', '2026-11-11 11:00:00')

const USAGE = (input, output, cacheRead, cacheWrite, cost) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_tokens: cacheRead,
  cache_write_tokens: cacheWrite,
  tokens: input == null ? null : input + output,
  cost_usd: cost,
})
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} vs ${expected}`)

// ---- metric 2 ----

test('metric 2: the seeded item’s summary matches the seed exactly', () => {
  const stats = itemStats('IS-1', { now: NOW })
  assert.deepEqual(validate(ITEM_STATS_SCHEMA, { visible: true, stats }), [])

  assert.equal(stats.item, 'IS-1')
  assert.equal(stats.kind, 'change')
  assert.equal(stats.repo, 'acme/stats')
  assert.equal(stats.priority, 'High')
  assert.equal(stats.outcome, 'closed')
  assert.equal(stats.created_at, '2026-11-10T09:00:00Z')
  assert.equal(stats.closed_at, '2026-11-10T17:40:00Z')

  // Implementation: both implement runs.
  const { cost_usd: implCost, ...impl } = stats.implementation
  assert.deepEqual(impl, { attempts: 2, fix_rounds: 1, input_tokens: 1800, output_tokens: 700, cache_read_tokens: 30000, cache_write_tokens: 4000, tokens: 2500, turns: 50, wall_ms: 6_000_000 })
  near(implCost, 1.75, 'implementation cost')

  // Whole item, by phase and in total.
  const { cost_usd: totalCost, ...totals } = stats.totals
  assert.deepEqual(totals, { input_tokens: 2920, output_tokens: 990, cache_read_tokens: 32100, cache_write_tokens: 4200, tokens: 3910, turns: 73 })
  near(totalCost, 2.42, 'total cost')
  const phase = (name) => stats.phases.find((p) => p.phase === name)
  assert.deepEqual(stats.phases.map((p) => p.phase), ['Plan', 'Technical Plan', 'Execute', 'Deploy', 'Review'])
  assert.deepEqual(phase('Plan'), { phase: 'Plan', ...USAGE(null, null, null, null, null) })
  assert.deepEqual(phase('Technical Plan'), { phase: 'Technical Plan', ...USAGE(220, 110, 2100, 200, 0.22) })
  assert.deepEqual({ ...phase('Execute'), cost_usd: null }, { phase: 'Execute', ...USAGE(2700, 880, 30000, 4000, null) })
  near(phase('Execute').cost_usd, 2.2, 'Execute cost')
  assert.deepEqual(phase('Deploy'), { phase: 'Deploy', ...USAGE(0, 0, 0, 0, 0) })

  // Per-step rows: one per run, in order.
  assert.deepEqual(
    stats.steps.map((s) => [s.step, s.agent, s.attempt, s.turns, s.wall_ms]),
    [
      ['change.plan-options', 'Ensemble', 1, 5, 660_000],
      ['change.plan-options', 'Ensemble', 2, 4, 600_000],
      ['change.implement', 'Eng', 1, 30, 3_600_000],
      ['change.auto-review', 'Review', 1, 8, 1_200_000],
      ['change.implement', 'Eng', 2, 20, 2_400_000],
      ['change.auto-review', 'Review', 2, 6, 600_000],
      ['change.deploy', 'DevOps', 1, null, 600_000],
    ],
  )
  assert.deepEqual(stats.steps[2], {
    step: 'change.implement',
    agent: 'Eng',
    attempt: 1,
    model: 'claude-opus-5-5',
    provider: 'claude',
    input_tokens: 1000,
    output_tokens: 400,
    cache_read_tokens: 20000,
    cache_write_tokens: 3000,
    cost_usd: 1,
    turns: 30,
    wall_ms: 3_600_000,
  })

  // Time: 8h40m elapsed; agents 7.8M ms; three 1h gate waits and one 2h.
  assert.deepEqual(stats.time, {
    elapsed_ms: 31_200_000,
    agent_ms: 7_800_000,
    waiting_ms: 18_000_000,
    checks_deploy_ms: 1_200_000,
    queued_ms: 4_200_000,
  })
  const t = stats.time
  assert.equal(t.agent_ms + t.waiting_ms + t.checks_deploy_ms + t.queued_ms, t.elapsed_ms)

  // Clarification: every signal, with the steps it hit.
  assert.deepEqual(stats.clarification, {
    none: false,
    total: 7,
    request_changes: [{ step: 'change.plan-options', count: 1 }],
    review_fails: [{ step: 'change.implement', count: 1 }],
    asks: {
      blocking: 1,
      soft: 1,
      by_step: [
        { step: 'change.implement', blocking: 1, soft: 0 },
        { step: 'change.auto-review', blocking: 0, soft: 1 },
      ],
    },
    caretaker_rulings: [{ step: 'change.accept-code', count: 1 }],
    review_cycles: 2,
    auto_retries: 1,
    usage_limit_fallbacks: 1,
  })
})

test('metric 2: agent and waiting time are Productivity’s itemTimeSplit for the same rows', () => {
  const runs = db.prepare('SELECT * FROM step_run WHERE item_id = ? ORDER BY id').all('IS-1')
  const decisions = db.prepare('SELECT * FROM gate_decision WHERE item_id = ? ORDER BY created_at, id').all('IS-1')
  const split = itemTimeSplit(runs, decisions, gateWaitFor(new Map([['IS-1', runs]]), new Map([['IS-1', decisions]])), 'IS-1')
  const { time } = itemStats('IS-1', { now: NOW })
  assert.equal(time.agent_ms, split.agentsWorking)
  assert.equal(time.waiting_ms, split.waitingOnYou)
  assert.equal(time.checks_deploy_ms, split.checksAndDeploy)
})

test('metric 2: cost and input + output tokens equal the Productivity report’s for the same runs', () => {
  // Productivity has no cache-token figures, so only cost and its `tokens`
  // (input + output) have a twin there. Cache read and write are summed by the
  // same null rule (addNullable) but have nothing to compare against.
  const report = productivityReport({ range: '14d', project: String(STATS_PROJECT) }, { now: NOW })
  const top = report.topItems.find((row) => row.id === 'IS-1')
  const stats = itemStats('IS-1', { now: NOW })
  assert.ok(top, 'IS-1 is in the report')
  assert.equal(stats.totals.cost_usd, top.cost)
  assert.equal(stats.totals.tokens, top.tokens)
  assert.equal(stats.totals.input_tokens + stats.totals.output_tokens, top.tokens)
  // The only change closed in the project, so its split is the kind's median.
  const minutes = report.cycleTime.byKind.find((row) => row.kind === 'change').medianMinutes
  assert.equal(minutes.agentsWorking, stats.time.agent_ms / 60_000)
  assert.equal(minutes.waitingOnYou, stats.time.waiting_ms / 60_000)
  assert.equal(report.rework.sendBacksPerItem, stats.clarification.request_changes.reduce((sum, row) => sum + row.count, 0))
  assert.equal(report.rework.reviewFailCyclesPerItem, stats.implementation.fix_rounds)
})

test('metric 2: the retry and usage-limit patterns still match the text the orchestrator writes', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'server/src/orchestrator.js'), 'utf8')
  const template = (needle) => {
    const found = [...source.matchAll(/text: `([^`]*)`/g)].map((m) => m[1]).find((text) => text.includes(needle))
    assert.ok(found, `no orchestrator event text contains "${needle}"`)
    return found.replace(/\$\{[^}]*\}/g, 'X')
  }
  const likes = (text, pattern) => db.prepare('SELECT ? LIKE ? AS hit').get(text, pattern).hit === 1
  assert.ok(likes(template('auto-retrying'), STATS_EVENT_PATTERNS.autoRetry), 'the auto-retry event no longer matches')
  assert.ok(likes(template('hit a usage limit'), STATS_EVENT_PATTERNS.usageLimitFallback), 'the usage-limit event no longer matches')
  assert.ok(!likes('automated review failed: x', STATS_EVENT_PATTERNS.autoRetry))
})

// ---- metric 3 ----

test('metric 3: a quiet item reads “No clarification needed”; null turns stay null in totals and per step, never 0', () => {
  const stats = itemStats('IS-2', { now: NOW })
  assert.equal(stats.clarification.none, true)
  assert.equal(stats.clarification.total, 0)
  assert.equal(stats.implementation.turns, null)
  assert.equal(stats.totals.turns, null)
  assert.ok(Object.hasOwn(stats.steps[0], 'turns'), 'the key is present')
  assert.equal(stats.steps[0].turns, null)
  assert.equal(stats.steps[1].turns, 7)
  const block = JSON.parse(renderStatsComment(stats).match(/```json\n([\s\S]*?)\n```/)[1])
  assert.equal(block.implementation.turns, null)
  assert.equal(block.steps[0].turns, null)
  const line = statsSummaryLine(stats)
  assert.match(line, /turns not recorded/)
  assert.match(line, /No clarification needed/)
})

// ---- metric 4: visibility ----

test('metric 4: statsVisible holds at every kind’s last step and once closed or abandoned, never before', () => {
  for (const kind of ITEM_KINDS) {
    const last = endIndex(kind) - 1
    for (const { index } of stepsFor(kind)) {
      assert.equal(statsVisible({ kind, cursor: index }), index === last, `${kind} at ${STEPS[index].label}`)
      assert.equal(statsVisible({ kind, cursor: index, abandoned_at: '2026-11-10 10:00:00' }), true, `${kind} abandoned at ${index}`)
    }
    assert.equal(statsVisible({ kind, cursor: endIndex(kind) }), true, `${kind} closed`)
  }
})

test('metric 4: the route answers visible:false before the last step, and the summary at it', async () => {
  item('IS-3', { projectId: QUIET_PROJECT, cursor: IMPLEMENT })
  item('IS-4', { projectId: QUIET_PROJECT, cursor: CLOSE_GATE })
  const get = (id) => app.inject({ method: 'GET', url: `/api/items/${id}/stats`, headers: { cookie: admin.cookie } })
  const early = await get('IS-3')
  assert.equal(early.statusCode, 200, early.body)
  assert.deepEqual(early.json(), { visible: false, stats: null })
  const atLast = await get('IS-4')
  assert.equal(atLast.statusCode, 200, atLast.body)
  assert.equal(atLast.json().visible, true)
  assert.equal(atLast.json().stats.outcome, null)
  assert.equal(atLast.json().stats.closed_at, null)
  const closed = await get('IS-1')
  assert.deepEqual(closed.json(), JSON.parse(JSON.stringify({ visible: true, stats: itemStats('IS-1') })))
  assert.deepEqual(validate(ITEM_STATS_SCHEMA, closed.json()), [])
  assert.equal((await get('IS-NOPE')).statusCode, 404)
})

test('a Task (no implement step) gets a summary with implementation null', () => {
  const taskClose = endIndex('task')
  item('IS-T', { projectId: QUIET_PROJECT, cursor: taskClose, kind: 'task' })
  run('IS-T', kindStepIndex('Assess', 'task'), { agent: 'Eng', started: '2026-11-11 10:00:00', ended: '2026-11-11 10:10:00', usage: [1, 1, 0, 0, 0.01, 2] })
  const stats = itemStats('IS-T', { now: NOW })
  assert.equal(stats.implementation, null)
  assert.equal(stats.clarification.review_cycles, 0)
  assert.match(statsSummaryLine(stats), /no implement step/)
  assert.deepEqual(validate(ITEM_STATS_SCHEMA, { visible: true, stats }), [])
})

// ---- guardrail 4: nothing private, only allowlisted keys ----

function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out)
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) keysOf(v, out.add(k))
  return out
}

test('guardrail 4: no prompt, output, note, ask or ruling text, path or token reaches the summary, the route or the comment', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/items/IS-1/stats', headers: { cookie: admin.cookie } })
  const surfaces = { stats: JSON.stringify(itemStats('IS-1')), route: res.body, comment: renderStatsComment(itemStats('IS-1')) }
  for (const [name, text] of Object.entries(surfaces)) {
    for (const sentinel of SENTINELS) assert.ok(!text.includes(sentinel), `${name} carries ${sentinel}`)
  }
  const extra = [...keysOf(itemStats('IS-1'))].filter((key) => !STATS_KEYS.has(key))
  assert.deepEqual(extra, [], 'every key is in STATS_KEYS')
})
