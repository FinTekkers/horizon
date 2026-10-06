// HZ-313, approval time: approving gate 5 files the split the plan proposed —
// one issue on the connected upstream repo, synced in as an item there, and a
// dependency that holds the source item back until that item closes. The
// plan step runs through the real orchestrator, gates go through the real
// routes, and GitHub is a counting stub (helpers/splitGithubStub.mjs).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { splitGithubStub } from './helpers/splitGithubStub.mjs'

const SENTINEL = 'ghp_TEST_SENTINEL'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-split-approval-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.GITHUB_TOKEN = SENTINEL
delete process.env.GITHUB_WEBHOOK_SECRET

// Everything the server prints, for the token check.
const printed = []
for (const level of ['log', 'info', 'warn', 'error']) {
  const real = console[level].bind(console)
  console[level] = (...args) => {
    printed.push(args.map(String).join(' '))
    real(...args)
  }
}

const stub = splitGithubStub()
globalThis.fetch = stub.fetch

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { composeIssueBody } = await import('../src/github.js')
const { splitMarker } = await import('../src/split.js')
const { ACTOR } = await import('../src/caretakerRules.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
await orchestrator.init({ info: () => {}, warn: () => {} })
await new Promise((r) => setTimeout(r, 50)) // ensureFarm's start handshake
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)

after(() => {
  for (const { item_id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(item_id)
})

const OPTIONS = requiredStepIndex('Plan options & trade-offs (pros / cons)')
const DESIGN_GATE = requiredStepIndex('Approve the high-level design')
const DRAFT_PLAN = requiredStepIndex('Draft implementation plan')
const REVIEW_GATE = requiredStepIndex('Review before execution')
const SRC = 'FinTekkers/ledger-service'
const LIB = 'FinTekkers/ledger-models'
const LIB2 = 'FinTekkers/ledger-utils'

const project = store.createProject('FinTekkers').id
for (const repo of [SRC, LIB, LIB2]) store.addRepoToProject(project, repo)
const LIB_PREFIX = store.findRepo(LIB).prefix

const PLAN_MD = '## Options\nA, B.\n## Recommendation\nB_PLAN_ONLY_TEXT fixes it upstream.\nRecommended option: B\n## Blockers\nNone.'
const SPLIT = {
  repo: LIB,
  title: 'Fix Decimal serialization',
  description: 'Serialize Decimal without losing scale.',
  metric: '1. Round-trips keep scale.',
  guardrails: '1. No wire change.',
  remaining_description: 'Use the fixed model in the service.',
  remaining_metric: '1. Bump ledger-models to the new release.',
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const responses = []

function newSource(title) {
  const issue = stub.addIssue(SRC, { title, body: composeIssueBody({ outcome: 'SOURCE_ONLY_DESC', metric: 'Works.', guardrails: '' }) })
  const id = `LS-${issue.number}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, repo, project_id, cursor) VALUES (?, ?, 'Medium', 'SOURCE_ONLY_DESC', 'Works.', '', ?, ?, ?, ?)",
  ).run(id, title, issue.number, SRC, project, OPTIONS)
  return { id, issue }
}

async function runPlan(id, split = SPLIT) {
  orchestrator.kick(id)
  await tick()
  const run = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, OPTIONS)
  assert.ok(run, `no active plan run for ${id}`)
  assert.deepEqual(await orchestrator.completeFarmRun(run.id, { summary: 'planned', artifacts: { artifact_md: PLAN_MD, split } }), {
    ok: true,
  })
  assert.equal(store.getItem(id).cursor, DESIGN_GATE)
  return store.latestArtifact(id, OPTIONS)
}

async function approve(id) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/gates/${DESIGN_GATE}/approve`,
    payload: {},
    headers: { cookie, 'x-human-key': pin },
  })
  responses.push(res.body)
  return res
}
const sendBack = (id) => app.gateActions.sendBack(id, { target: 'Approve the high-level design', feedback: 'again' }, 'You')
const rowOf = (id) => db.prepare('SELECT * FROM item_split WHERE source_item_id = ?').get(id)
const deps = (id) => db.prepare('SELECT depends_on_id FROM work_item_dependency WHERE item_id = ?').all(id).map((r) => r.depends_on_id)
const activeRun = (id, step) => db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, step)
const redEvents = (id) => db.prepare("SELECT text FROM event WHERE item_id = ? AND color = '#9C333E'").all(id).map((e) => e.text)
const dispatchedAt = (id, step) =>
  stub.calls.filter((c) => c.path.endsWith('/steps/run') && c.body?.item?.id === id && c.body?.step?.index === step)

async function items() {
  return (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })).json().items
}

let journey = null // the source item the full journey filed, reused below

test('journey: approving gate 5 files one issue upstream, the source waits on it, and starts once it closes', async () => {
  const { id, issue: sourceIssue } = newSource('journey')
  const artifact = await runPlan(id, { ...SPLIT, description: `${SPLIT.description} See /home/ubuntu/notes.txt for context.` })
  assert.match(artifact, /## Proposed split/)
  assert.equal(stub.creates().length, 0)

  const res = await approve(id)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(stub.creates(LIB).length, 1, 'exactly one issue filed')
  assert.equal(stub.creates().length, 1)

  // Metric 1 / guardrail 10: the body is the split's plan text, a back-link and the marker.
  const body = stub.creates(LIB)[0].body.body
  for (const text of [SPLIT.description, SPLIT.metric, SPLIT.guardrails]) assert.ok(body.includes(text), `body carries ${text}`)
  assert.ok(body.includes(`[${id}](${config.UI_URL}/${id.toLowerCase()})`), 'back-link to the source item')
  assert.ok(body.includes(`${SRC}#${sourceIssue.number}`))
  assert.ok(body.includes(splitMarker(id)))
  assert.doesNotMatch(body, /\/home\//, 'no host paths')
  assert.ok(!body.includes('SOURCE_ONLY_DESC') && !body.includes('B_PLAN_ONLY_TEXT'), 'nothing else from the item or the plan')
  assert.ok(!body.includes(SPLIT.remaining_description), 'the source’s remaining scope stays on the source')

  // On the board as an item of the upstream repo.
  const filed = stub.repoIssues(LIB).at(-1)
  const board = await items()
  const target = board.find((i) => i.repo === LIB && i.issue === filed.number)
  assert.ok(target, 'the new issue is an item of the target repo')
  assert.equal(target.id, `${LIB_PREFIX}-${filed.number}`)
  assert.ok(!target.desc.includes('horizon-split-of') && !target.guardrails.includes('Split from'), 'back-link kept out of its fields')

  // Metric 2: the dependency the card renders, and no dispatch while it is open.
  const source = board.find((i) => i.id === id)
  assert.equal(source.blocked, true)
  assert.deepEqual(source.blockedBy.map((b) => b.id), [target.id])
  assert.deepEqual(deps(id), [target.id])
  assert.equal(store.getItem(id).cursor, DRAFT_PLAN)
  await tick()
  assert.equal(activeRun(id, DRAFT_PLAN), undefined, 'the source does not start while the upstream item is open')
  assert.equal(dispatchedAt(id, DRAFT_PLAN).length, 0)

  // Metric 3: the remaining scope, pushed to the source's issue first, so a sync keeps it.
  assert.equal(store.getItem(id).desc, SPLIT.remaining_description)
  assert.equal(store.getItem(id).metric, SPLIT.remaining_metric)
  assert.ok(sourceIssue.body.includes(SPLIT.remaining_description))
  store.upsertFromGithub(sourceIssue, SRC)
  assert.equal(store.getItem(id).desc, SPLIT.remaining_description, 'a later sync does not restore the old scope')

  // Guardrail 9: upstream, the only write is the one create (plus its label).
  for (const c of stub.calls.filter((c) => c.path.startsWith(`/repos/${LIB}/`))) {
    const allowed =
      (c.method === 'POST' && (c.path.endsWith('/issues') || c.path.endsWith('/labels'))) || (c.method === 'GET' && c.path.endsWith('/issues'))
    assert.ok(allowed, `unexpected upstream call ${c.method} ${c.path}`)
  }

  // The upstream item closes: the source starts by itself.
  store.upsertFromGithub({ ...filed, state: 'closed' }, LIB)
  await tick()
  assert.ok(activeRun(id, DRAFT_PLAN), 'the source dispatches once the upstream item closes')
  assert.equal(dispatchedAt(id, DRAFT_PLAN).length, 1)
  journey = { id, target: target.id }
})

test('idempotency: a later re-plan and re-approval of the same split files nothing more', async () => {
  const { id, target } = journey
  orchestrator.cancel(id)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(REVIEW_GATE, id)
  assert.equal((await app.gateActions.sendBack(id, { target: 'x', feedback: 'replan', targetStepIndex: OPTIONS }, 'You')).ok, true)

  const artifact = await runPlan(id)
  assert.match(artifact, /\*\*Already filed\*\*/)
  assert.ok(artifact.includes(target))
  assert.equal((await approve(id)).statusCode, 200)
  assert.equal(stub.creates().length, 1)
  assert.deepEqual(deps(id), [target])
  assert.equal(rowOf(id).status, 'filed')
})

test('idempotency: a real restart after filing — a fresh process re-plans and re-approves, and files nothing', () => {
  const { id, target } = journey
  orchestrator.cancel(id)
  const env = { ...process.env, SPLIT_SOURCE: id, SPLIT_JSON: JSON.stringify(SPLIT), SPLIT_ISSUES: JSON.stringify(Object.fromEntries(stub.issues)) }
  delete env.FARM_URL
  const out = execFileSync(process.execPath, [join(import.meta.dirname, 'helpers/splitRestartChild.mjs')], { env, encoding: 'utf8' })
  const result = JSON.parse(out.trim().split('\n').at(-1))
  assert.deepEqual(result.completed, { ok: true })
  assert.equal(result.approved.ok, true, JSON.stringify(result.approved))
  assert.match(result.artifact, /\*\*Already filed\*\*/)
  assert.equal(result.creates, 0, 'the restarted server filed nothing')
  assert.deepEqual(result.deps, [target])
  assert.deepEqual(result.rows, [{ target_repo: LIB, status: 'filed' }])
})

test('idempotency: a restart mid-filing, with the issue already on GitHub, reuses it by its marker', async () => {
  const { id } = newSource('restart while filing')
  await runPlan(id)
  // The crashed attempt: issue created, row still 'filing', nothing else.
  const orphan = stub.addIssue(LIB, { title: SPLIT.title, body: `${composeIssueBody({ outcome: SPLIT.description, metric: SPLIT.metric })}\n\n${splitMarker(id)}` })
  db.prepare("UPDATE item_split SET status = 'filing' WHERE source_item_id = ?").run(id)
  const before = stub.creates().length

  const res = await approve(id)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(stub.creates().length, before, 'no second issue')
  const target = store.findItemByIssue(LIB, orphan.number)
  assert.deepEqual(deps(id), [target.id])
  assert.equal(rowOf(id).status, 'filed')
})

test('webhook race: the new issue synced in before the split’s own upsert is the one item, and the dependency names it', async () => {
  const { id } = newSource('webhook race')
  await runPlan(id)
  stub.hooks.afterCreate = (repo, issue) => store.upsertFromGithub(issue, repo)
  try {
    assert.equal((await approve(id)).statusCode, 200)
  } finally {
    stub.hooks.afterCreate = null
  }
  const filed = stub.repoIssues(LIB).at(-1)
  const synced = db.prepare('SELECT id FROM work_item WHERE repo = ? AND issue = ?').all(LIB, filed.number)
  assert.equal(synced.length, 1)
  assert.deepEqual(deps(id), [synced[0].id])
})

test('two approvals at once: one files, the other is told filing is in progress', async () => {
  const { id } = newSource('double click')
  await runPlan(id)
  const before = stub.creates().length
  stub.hooks.beforeCreate = () => tick(100)
  let results
  try {
    results = await Promise.all([approve(id), approve(id)])
  } finally {
    stub.hooks.beforeCreate = null
  }
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409])
  assert.match(results.find((r) => r.statusCode === 409).json().error, new RegExp(`split filing is already in progress for ${id}`))
  assert.equal(stub.creates().length, before + 1)
  assert.equal(deps(id).length, 1)
})

test('Autopilot: the caretaker’s approval files the split exactly once', async () => {
  const { id } = newSource('autopilot')
  await runPlan(id)
  const before = stub.creates().length
  const result = await app.gateActions.approve(id, DESIGN_GATE, '', ACTOR)
  assert.equal(result.ok, true)
  assert.equal(stub.creates().length, before + 1)
  assert.equal(deps(id).length, 1)
})

test('a 403 on create: 502, the gate stays open, no dependency, a red event — and re-approving does not retry', async () => {
  const { id } = newSource('forbidden')
  await runPlan(id, { ...SPLIT, repo: LIB2 })
  stub.hooks.createStatus[LIB2] = 403
  try {
    const res = await approve(id)
    assert.equal(res.statusCode, 502)
    assert.match(res.json().error, /^split filing failed: The token is not allowed to create issues/)
    assert.equal(store.getItem(id).cursor, DESIGN_GATE, 'the gate stays open')
    assert.equal(rowOf(id).status, 'failed')
    assert.equal(deps(id).length, 0)
    assert.ok(redEvents(id).some((t) => t.startsWith(`could not file the split on ${LIB2}`)))
    const attempts = stub.creates(LIB2).length

    const again = await approve(id)
    assert.equal(again.statusCode, 409)
    assert.match(again.json().error, /re-run the plan/)
    assert.equal(stub.creates(LIB2).length, attempts, 're-approval makes no more POSTs')
    assert.equal(store.getItem(id).cursor, DESIGN_GATE)
  } finally {
    delete stub.hooks.createStatus[LIB2]
  }
})

test('orphan recovery: the issue was filed but the dependency failed; a re-plan and re-approval reuse it', async () => {
  const { id } = newSource('orphan')
  await runPlan(id)
  const before = stub.creates().length
  // The new item is abandoned before the dependency can be added.
  stub.hooks.afterCreate = (repo, issue) => {
    store.upsertFromGithub(issue, repo)
    store.abandonItem(store.findItemByIssue(repo, issue.number).id, 'gone', 'You')
  }
  try {
    assert.equal((await approve(id)).statusCode, 502)
  } finally {
    stub.hooks.afterCreate = null
  }
  assert.equal(stub.creates().length, before + 1)
  assert.equal(deps(id).length, 0)
  const row = rowOf(id)
  assert.equal(row.status, 'failed')
  assert.ok(row.target_issue, 'the created issue is remembered')
  const target = store.findItemByIssue(LIB, row.target_issue)
  db.prepare('UPDATE work_item SET abandoned_at = NULL, abandoned_reason = NULL, abandoned_by = NULL WHERE id = ?').run(target.id)

  assert.equal((await sendBack(id)).ok, true)
  await runPlan(id)
  assert.equal(rowOf(id).status, 'proposed')
  assert.equal((await approve(id)).statusCode, 200)
  assert.equal(stub.creates().length, before + 1, 'no new issue')
  assert.deepEqual(deps(id), [target.id])
})

test('the source scope push fails: the split fails visibly, nothing waits on it, and a sync does not half-apply it', async () => {
  const { id, issue } = newSource('scope push fails')
  await runPlan(id)
  stub.hooks.patchStatus[SRC] = 500
  try {
    const res = await approve(id)
    assert.equal(res.statusCode, 502)
    assert.match(res.json().error, /updating issue/)
  } finally {
    delete stub.hooks.patchStatus[SRC]
  }
  assert.equal(rowOf(id).status, 'failed')
  assert.deepEqual(deps(id), [], 'the dependency the attempt added was taken back')
  assert.ok(redEvents(id).some((t) => t.includes('could not file the split')))
  assert.equal(store.getItem(id).desc, 'SOURCE_ONLY_DESC')
  store.upsertFromGithub(issue, SRC)
  assert.equal(store.getItem(id).desc, 'SOURCE_ONLY_DESC')
  assert.notEqual(rowOf(id).status, 'filed')
})

test('the token never leaves the Authorization header: not in bodies, responses, split errors, events or logs', () => {
  assert.ok(stub.calls.some((c) => c.headers.Authorization === `Bearer ${SENTINEL}`), 'the stub did see the token')
  const leaks = [
    ...stub.calls.map((c) => JSON.stringify(c.body ?? '')),
    ...responses,
    ...db.prepare('SELECT error FROM item_split').all().map((r) => r.error ?? ''),
    ...db.prepare('SELECT text FROM event').all().map((r) => r.text),
    ...printed,
  ].filter((s) => s.includes(SENTINEL))
  assert.deepEqual(leaks, [])
})
