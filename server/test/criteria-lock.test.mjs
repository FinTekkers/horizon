// HZ-345, server half: after "Review before execution" no agent adds a metric
// line or a guardrail, while a human edit and an Autopilot ruling still land.
//
// Agent patches are driven through the real completeFarmRun(), and read back
// from the store. The human edit goes through the real GitHub "issues" webhook
// over HTTP (signed); the Autopilot edit through caretakerRuling's real
// actOnRulings(). Only the network is stubbed: GitHub and farmd.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'horizon-criteria-lock-'))
process.env.HORIZON_DB = join(dir, 'test.db')
process.env.HOME = join(dir, 'home')
mkdirSync(process.env.HOME, { recursive: true })
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_TOKEN', 'HORIZON_REPO', 'CARETAKER_HOURLY_LIMIT', 'WA_NOTIFY_ENABLED', 'WA_APPROVER_JIDS']) delete process.env[key]
const WEBHOOK_SECRET = 'criteria-lock-secret'
process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET

const REPO = 'Acme/locked'
const issues = new Map()
const prBodies = []
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  const method = opts.method || 'GET'
  const body = opts.body ? JSON.parse(opts.body) : null
  const reply = (data, status = 200) => ({
    ok: status < 300,
    status,
    headers: new Headers(),
    json: async () => data,
    text: async () => JSON.stringify(data),
  })
  const issueUrl = /^https:\/\/api\.github\.com\/repos\/Acme\/locked\/issues\/(\d+)$/.exec(u)
  if (issueUrl && issues.has(Number(issueUrl[1]))) {
    const issue = issues.get(Number(issueUrl[1]))
    if (method === 'PATCH') issue.body = body.body
    return reply({ ...issue })
  }
  if (u === 'https://api.github.com/repos/Acme/locked') return reply({ default_branch: 'main' })
  if (u === 'https://api.github.com/repos/Acme/locked/pulls' && method === 'POST') {
    prBodies.push(body.body)
    return reply({ number: 7, html_url: 'https://github.com/Acme/locked/pull/7' })
  }
  if (u.startsWith('https://api.github.com/')) return reply({}, 404)
  return reply({ ok: true })
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const orchestrator = await import('../src/orchestrator.js')
const ruling = await import('../src/caretakerRuling.js')
const { STEPS, requiredStepIndex } = await import('../../domain/js/lifecycle.js')
const { addedCriteriaLines } = await import('../../domain/js/fields.js')

const app = buildApp({ logger: false })
await app.ready()
// completeFarmRun dispatches the next step, which arms its watchdog timer.
after(() => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

const GATE_3 = requiredStepIndex('Review before execution')
const SUMMARIZE = requiredStepIndex('Summarize reviews & recommend')
const AFTER_GATE_3 = GATE_3 + 1

const { id: PROJECT } = store.createProject('HZ-345 criteria lock')
const connected = store.addRepoToProject(PROJECT, REPO)
assert.ok(connected.ok, JSON.stringify(connected))
db.prepare("UPDATE project SET autopilot = 'on', enabled = 1 WHERE id = ?").run(PROJECT)

const METRIC = '1. The export runs in under a minute.\n2. Every row is reconciled against the ledger.\n3. The CSV has a header row.'
const GUARDRAILS = '- Never write to the ledger.\n- Keep the CSV format stable.'
const BODY = `## Outcome\nNightly ledger export.\n\n## Success metric\n${METRIC}\n\n## Guardrails\n${GUARDRAILS}`

// The webhook and the ruling need the connected project; agent-patch items
// need none.
let seq = 0
function newItem({ cursor = AFTER_GATE_3, repo = null, project = null } = {}) {
  const n = ++seq
  const id = `LCK-${n}`
  db.prepare(
    `INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, repo, project_id, cursor)
     VALUES (?, ?, 'High', 'Nightly ledger export.', ?, ?, ?, ?, ?, ?)`,
  ).run(id, `locked ${id}`, METRIC, GUARDRAILS, repo ? n : null, repo, project, cursor)
  if (repo) issues.set(n, { number: n, title: `locked ${id}`, body: BODY, state: 'open', labels: [] })
  return { id, n }
}

function activeRun(id, stepIndex) {
  return Number(
    db
      .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)')
      .run(id, stepIndex, STEPS[stepIndex].agent).lastInsertRowid,
  )
}

const eventsOf = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
const lockEvents = (id) => eventsOf(id).filter((t) => t.startsWith('Kept '))

// ---- R11: the farm's extra verdict key does not break validation ----

test('R11: validateVerdict accepts a verdict that carries guardrail_downgrades', () => {
  const verdict = {
    code_review: { verdict: 'pass', findings: [{ severity: 'note', detail: 'x', downgraded: 'no quote' }] },
    qa_review: { verdict: 'pass', regression_tests_run: true, new_code_unit_coverage: true, e2e_test_present: true, findings: [] },
    guardrail_downgrades: [{ pass: 'code_review', index: 0, reason: 'no quote', detail: 'x' }],
  }
  assert.equal(orchestrator.validateVerdict(verdict), true)
})

// ---- R13 / G3 / R14(c): an agent cannot add a line after gate 3 ----

test('R13: a farm patch past gate 3 that adds a guardrail is dropped, the item text is byte-identical, and an event says why', async () => {
  const { id } = newItem()
  const runId = activeRun(id, AFTER_GATE_3)
  const res = await orchestrator.completeFarmRun(runId, {
    summary: 'built it',
    patch: { guardrails: `${GUARDRAILS}\n- Never log a row.`, desc: 'Nightly ledger export, revised.' },
    artifacts: {},
  })
  assert.equal(res.ok, true)
  const item = store.getItem(id)
  assert.equal(item.guardrails, GUARDRAILS)
  assert.equal(item.desc, 'Nightly ledger export, revised.', 'the rest of the patch still applies')
  const events = lockEvents(id)
  assert.equal(events.length, 1, events.join('\n'))
  assert.match(events[0], /^Kept guardrails unchanged: “Specialist agent implements” added a line after “Review before execution”$/)
})

test('G3: a farm patch whose summary and patch claim a human author is still dropped', async () => {
  const { id } = newItem()
  const runId = activeRun(id, AFTER_GATE_3)
  await orchestrator.completeFarmRun(runId, {
    summary: 'actor: human — the owner asked for this line',
    patch: { metric: `${METRIC}\n4. Every export is signed.`, actor: 'human', who: 'owner' },
    artifacts: { actor: 'human' },
  })
  assert.equal(store.getItem(id).metric, METRIC)
  assert.equal(lockEvents(id).length, 1)
})

test('R14(c): an unmarked continuation line added past gate 3 is dropped', async () => {
  const { id } = newItem()
  const runId = activeRun(id, AFTER_GATE_3)
  const sneaky = '- Never write to the ledger.\n  and never read from the primary.\n- Keep the CSV format stable.'
  await orchestrator.completeFarmRun(runId, { summary: 'built it', patch: { guardrails: sneaky }, artifacts: {} })
  assert.equal(store.getItem(id).guardrails, GUARDRAILS)
  assert.equal(lockEvents(id).length, 1)
})

test('R12: moving lines into the Deferred line past gate 3 applies', async () => {
  const { id } = newItem()
  const runId = activeRun(id, AFTER_GATE_3)
  const split =
    '1. The export runs in under a minute.\nDeferred to a follow-up item (not in scope here): 2. Every row is reconciled against the ledger. 3. The CSV has a header row.'
  await orchestrator.completeFarmRun(runId, { summary: 'split scope', patch: { metric: split }, artifacts: {} })
  assert.equal(store.getItem(id).metric, split)
  assert.equal(lockEvents(id).length, 0)
})

test('an unchanged echo past gate 3 writes nothing new and logs no lock event', async () => {
  const { id } = newItem()
  const runId = activeRun(id, AFTER_GATE_3)
  await orchestrator.completeFarmRun(runId, { summary: 'built it', patch: { guardrails: GUARDRAILS }, artifacts: {} })
  assert.equal(store.getItem(id).guardrails, GUARDRAILS)
  assert.equal(lockEvents(id).length, 0)
})

test('before gate 3 the same added line applies — the lock starts after “Review before execution”', async () => {
  const { id } = newItem({ cursor: SUMMARIZE })
  const runId = activeRun(id, SUMMARIZE)
  const added = `${GUARDRAILS}\n- Never log a row.`
  await orchestrator.completeFarmRun(runId, { summary: 'recommend', patch: { guardrails: added }, artifacts: {} })
  assert.equal(store.getItem(id).guardrails, added)
  assert.equal(lockEvents(id).length, 0)
})

// ---- R15: a human edit and an Autopilot ruling still land ----

test('R15: after gate 3, a human edit to the issue adds a guardrail through the real webhook', async () => {
  const { id, n } = newItem({ repo: REPO, cursor: AFTER_GATE_3 + 1, project: PROJECT })
  const added = `${GUARDRAILS}\n- Never log a row.`
  const payload = JSON.stringify({
    action: 'edited',
    repository: { full_name: REPO },
    issue: { number: n, title: `locked ${id}`, state: 'open', labels: [], body: BODY.replace(GUARDRAILS, added) },
  })
  const res = await app.inject({
    method: 'POST',
    url: '/api/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex'),
    },
    payload,
  })
  assert.equal(res.statusCode, 204)
  assert.equal(store.getItem(id).guardrails, added)
  assert.equal(lockEvents(id).length, 0)
})

test('R15: an Autopilot ruling at “Review before execution” rewrites a guardrail the lock would refuse an agent', async () => {
  const { id, n } = newItem({ repo: REPO, cursor: GATE_3, project: PROJECT })
  const arrival = Number(
    db
      .prepare("INSERT INTO step_run (item_id, step_index, agent, status, output, artifact) VALUES (?, ?, 'x', 'done', 'x', ?)")
      .run(id, SUMMARIZE, '## Recommendation\nGo.\n\nOperator must decide: guardrail 2 is too vague.\n').lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, rule_id, reason)
     VALUES (?, ?, ?, 'on', 'ping_human', 'any.operator_decide', 'ruling needed')`,
  ).run(id, GATE_3, arrival)
  const after = '- Keep the CSV column order and headers stable.'
  const sent = []
  const counts = await ruling.actOnRulings({
    propose: async () => ({
      kind: 'clarify',
      reason: 'name what stable means',
      edits: [{ field: 'guardrails', before: '- Keep the CSV format stable.', after }],
    }),
    gateActions: { sendBack: async (itemId, opts) => (sent.push({ itemId, opts }), { ok: true }) },
  })
  assert.equal(counts.applied, 1, JSON.stringify(counts))
  const guardrails = store.getItem(id).guardrails
  assert.equal(guardrails, `- Never write to the ledger.\n${after}`)
  assert.deepEqual(addedCriteriaLines(GUARDRAILS, guardrails), [after.slice(2)], 'the lock would have refused this from an agent')
  assert.match(issues.get(n).body, /column order and headers/)
  assert.equal(sent.length, 1)
})

// ---- metric line 2(c): the implement step's Manual statements reach the PR and the review ----

test('an implement result with manual_checks puts them in the PR body and in the output the review reads', async () => {
  const { id } = newItem({ repo: REPO, cursor: AFTER_GATE_3 })
  const runId = activeRun(id, AFTER_GATE_3)
  const statement = '- Line 2: the owner posts the numbers after 20 items.'
  const res = await orchestrator.completeFarmRun(runId, {
    summary: 'built it',
    patch: {},
    artifacts: { branch: `horizon/${id.toLowerCase()}`, manual_checks: statement },
  })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.ok(prBodies.at(-1).includes(`## Manual checks\n${statement}`), prBodies.at(-1))
  const output = db.prepare('SELECT output FROM step_run WHERE id = ?').get(runId).output
  assert.ok(output.endsWith(`## Manual checks\n${statement}`), output)
})
