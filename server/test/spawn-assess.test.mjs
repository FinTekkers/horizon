// HZ-379 metric line 1 and guardrails 1 and 3: when a Task's Assess returns
// `code_needed`, Horizon files one change item in the Task's repo carrying
// its outcome, metric and guardrails, and makes the Task depend on it. "Does
// not advance to Run plan" is read as: Run plan never dispatches and no Run
// plan step_run exists — the cursor rests on Run plan, held by the open
// dependency. A retried Assess, a re-delivered completion and a filing a
// restart cut short each file no second item. The spawned item waits for a
// human at gate 3 even on Autopilot.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitGithubStub } from './helpers/splitGithubStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-spawn-assess-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.GITHUB_TOKEN = 'ghp_TEST_SENTINEL'
delete process.env.FARM_STEP_INDEXES
delete process.env.GITHUB_WEBHOOK_SECRET

const stub = splitGithubStub()
globalThis.fetch = stub.fetch

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const caretakerActor = await import('../src/caretakerActor.js')
const { spawnMarker } = await import('../src/spawn.js')
const { kindStepIndex, requiredStepIndex } = await import('../../domain/js/lifecycle.js')

const REPO = 'FinTekkers/horizon'
const OTHER_REPO = 'FinTekkers/ui-service'
const ASSESS = kindStepIndex('Assess', 'task')
const RUN_PLAN = kindStepIndex('Run plan', 'task')
const GATE_3 = requiredStepIndex('Approve & prioritize this work')

const project = store.createProject('FinTekkers').id
store.addRepoToProject(project, REPO)
store.addRepoToProject(project, OTHER_REPO)
const PREFIX = store.findRepo(REPO).prefix

await orchestrator.init({ info: () => {}, warn: () => {} })
await new Promise((r) => setTimeout(r, 50)) // ensureFarm's start handshake

after(() => {
  for (const { item_id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(item_id)
})

const CODE_NEEDED = {
  title: 'Add a --since flag to the backfill script',
  outcome: 'scripts/backfill.sh takes --since DATE and only touches rows after it.',
  metric: '1. --since 2026-01-01 skips older rows.\n2. Without --since every row is processed.',
  guardrails: '1. The default run is unchanged.',
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

let tasks = 0
function newTask() {
  tasks++
  const issue = stub.addIssue(REPO, { title: `task ${tasks}` })
  const id = `${PREFIX}-${issue.number}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, desc, metric, issue, repo, project_id, cursor, kind) VALUES (?, ?, 'High', 'Backfill.', 'Done.', ?, ?, ?, ?, 'task')",
  ).run(id, `task ${tasks}`, issue.number, REPO, project, ASSESS)
  return id
}

// Dispatches Assess and returns its active run id.
async function startAssess(id) {
  orchestrator.kick(id)
  await tick()
  const run = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, ASSESS)
  assert.ok(run, `no active Assess run for ${id}`)
  return run.id
}
const complete = (runId, extra = {}) =>
  orchestrator.completeFarmRun(runId, { summary: 'assessed', artifacts: { artifact_md: '## Code needed\nA flag.', ...extra } })

const spawnRows = (id) => db.prepare('SELECT * FROM item_spawn WHERE parent_id = ? ORDER BY id').all(id)
const deps = (id) => db.prepare('SELECT depends_on_id FROM work_item_dependency WHERE item_id = ?').all(id).map((r) => r.depends_on_id)
const runPlanDispatches = (id) =>
  stub.calls.filter((c) => c.path.endsWith('/steps/run') && c.body?.item?.id === id && c.body?.step?.index === RUN_PLAN)
const runPlanRuns = (id) => db.prepare('SELECT id FROM step_run WHERE item_id = ? AND step_index = ?').all(id, RUN_PLAN)
const createsBy = (id) => stub.creates(REPO).filter((c) => c.body.body.includes(`horizon-spawned-by: ${id} `))

test('Assess with code_needed files one change item in the Task’s repo and the Task waits: Run plan never dispatches and no Run plan step_run exists', async () => {
  const id = newTask()
  assert.deepEqual(await complete(await startAssess(id), { code_needed: CODE_NEEDED }), { ok: true })
  await tick()

  const creates = createsBy(id)
  assert.equal(creates.length, 1, 'exactly one issue filed')
  assert.equal(stub.creates(OTHER_REPO).length, 0, 'filed in the Task’s own repo only')
  const body = creates[0].body
  assert.equal(body.title, CODE_NEEDED.title)
  assert.equal(body.labels.length, 1, 'a change item carries only its priority label — no kind label')
  assert.match(String(body.labels[0]), /high/i, 'the child takes the Task’s priority')

  const [row] = spawnRows(id)
  assert.equal(row.status, 'filed')
  assert.equal(row.kind, 'change')
  const child = store.getItem(row.child_id)
  assert.equal(child.repo, store.getItem(id).repo)
  assert.equal(child.kind, 'change')
  assert.equal(child.desc, CODE_NEEDED.outcome)
  assert.equal(child.metric, CODE_NEEDED.metric)
  assert.equal(child.guardrails, CODE_NEEDED.guardrails)

  assert.deepEqual(deps(id), [child.id], 'the change is the Task’s dependency')
  const task = store.getItem(id)
  assert.equal(task.cursor, RUN_PLAN, 'the cursor rests on Run plan')
  assert.equal(runPlanRuns(id).length, 0, 'no Run plan step_run')
  assert.equal(runPlanDispatches(id).length, 0, 'Run plan never dispatched')

  // Guardrail 1: the child waits for a human at gate 3, even on Autopilot.
  orchestrator.cancel(child.id)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(GATE_3, child.id)
  assert.equal(store.setProjectAutopilot(project, 'on', 'You').ok, true)
  db.prepare(
    "INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, reason) VALUES (?, ?, 0, 'on', 'approve', 'looks fine')",
  ).run(child.id, GATE_3)
  const acted = []
  const gateActions = new Proxy({}, { get: (_, name) => async (...args) => acted.push([name, ...args]) })
  await caretakerActor.actOnDecisions({ gateActions, send: async () => ({ ok: true }), owner: () => null })
  assert.deepEqual(acted, [], 'Autopilot takes no gate action on the spawned item')
  assert.equal(store.getItem(child.id).cursor, GATE_3, 'it stays at “Approve & prioritize this work”')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gate_decision WHERE item_id = ?').get(child.id).n, 0)
  store.setProjectAutopilot(project, 'off', 'You')
})

for (const [label, extra] of [
  ['null', { code_needed: null }],
  ['missing', {}],
]) {
  test(`Assess with code_needed ${label} files nothing and Run plan dispatches as today`, async () => {
    const id = newTask()
    const before = stub.creates().length
    assert.deepEqual(await complete(await startAssess(id), extra), { ok: true })
    await tick()
    assert.equal(stub.creates().length, before, 'no issue filed')
    assert.deepEqual(spawnRows(id), [])
    assert.deepEqual(deps(id), [])
    assert.equal(runPlanDispatches(id).length, 1, 'Run plan dispatched')
    orchestrator.cancel(id)
  })
}

test('a malformed code_needed fails the run: nothing is filed and the Task stays at Assess', async () => {
  const id = newTask()
  const runId = await startAssess(id)
  await complete(runId, { code_needed: { title: 'No metric', outcome: 'Something.' } })
  assert.match(db.prepare('SELECT output FROM step_run WHERE id = ?').get(runId).output, /malformed code_needed: missing metric/)
  assert.equal(store.getItem(id).cursor, ASSESS)
  assert.deepEqual(spawnRows(id), [])
  assert.equal(createsBy(id).length, 0)
})

test('no duplicates: a run cut off after filing, its retry and a re-delivered completion file one item', async () => {
  const id = newTask()
  const first = await startAssess(id)
  // The run is cancelled while the issue is being created: filed, but stale.
  stub.hooks.afterCreate = () => orchestrator.cancel(id)
  try {
    assert.deepEqual(await complete(first, { code_needed: CODE_NEEDED }), { ok: true, stale: true })
  } finally {
    stub.hooks.afterCreate = null
  }
  assert.equal(createsBy(id).length, 1)
  assert.equal(store.getItem(id).cursor, ASSESS, 'a stale run never advances')

  // The retry asks under the same key: no new issue, and now the edge.
  const retry = await startAssess(id)
  assert.deepEqual(await complete(retry, { code_needed: CODE_NEEDED }), { ok: true })
  // The farm re-delivers both completions.
  assert.deepEqual(await complete(retry, { code_needed: CODE_NEEDED }), { ok: true, stale: true })
  assert.deepEqual(await complete(first, { code_needed: CODE_NEEDED }), { ok: true, stale: true })

  assert.equal(createsBy(id).length, 1, 'one issue in total')
  const rows = spawnRows(id)
  assert.equal(rows.length, 1, 'one spawn row')
  assert.deepEqual(deps(id), [rows[0].child_id])
  assert.equal(store.getItem(id).cursor, RUN_PLAN)
})

test('no duplicates: a filing a restart left half-done finds its issue by the marker instead of filing again', async () => {
  const id = newTask()
  const key = `step:${ASSESS}:0`
  // A previous process created the issue, then died before recording it.
  const leftover = stub.addIssue(REPO, {
    title: CODE_NEEDED.title,
    body: `## Outcome\n${CODE_NEEDED.outcome}\n\n## Success metric\n${CODE_NEEDED.metric}\n\n${spawnMarker(id, key, 0)}`,
  })
  db.prepare(
    "INSERT INTO item_spawn (parent_id, request_key, seq, kind, payload_json, target_repo, status, created_by) VALUES (?, ?, 0, 'change', ?, ?, 'filing', 'Eng')",
  ).run(id, key, JSON.stringify(CODE_NEEDED), REPO)

  assert.deepEqual(await complete(await startAssess(id), { code_needed: CODE_NEEDED }), { ok: true })
  assert.equal(createsBy(id).length, 0, 'no new issue')
  const rows = spawnRows(id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'filed')
  assert.equal(rows[0].child_id, `${PREFIX}-${leftover.number}`)
  assert.deepEqual(deps(id), [rows[0].child_id])
})
