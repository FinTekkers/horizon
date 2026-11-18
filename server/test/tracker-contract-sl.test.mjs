// HO-875 metric 3: HO-871's shared Tracker port contract
// (test/contracts/tracker.contract.mjs), and the port cases it lacks
// (test/contracts/tracker-port.contract.mjs), run against the sl adapter that
// forRepo() hands out for an sl repo, and pass. farmd is stubbed
// (helpers/farmTasksStub.mjs) — and that stub is held to the same wire
// contract farmd itself is (farm/tests/fixtures/farm_tasks_contract.json).
//
// Metric 5 / guardrail 1 for these cases: globalThis.fetch is the farm stub,
// which refuses (and records) anything but FARM_URL's Task routes, so a
// GitHub, delegate-to-agent or claim call fails the case; every farm call must
// carry the farm secret.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runTrackerContract } from './contracts/tracker.contract.mjs'
import { runTrackerPortContract } from './contracts/tracker-port.contract.mjs'
import { FARM_TASKS_CONTRACT, createFarmTasksStub } from './helpers/farmTasksStub.mjs'

const SECRET = 'sl-contract-farm-secret'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-tracker-contract-sl-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = SECRET
for (const key of ['FARM_HOME', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { forRepo, backendOf } = await import('../src/backends/index.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })

const REPO = 'acme/sl-contract'
const project = store.createProject('sl tracker contract').id
assert.equal(store.addRepoToProject(project, REPO, 'sl').ok, true)
assert.equal(backendOf(REPO), 'sl')

test('the farm stub answers farmd’s wire contract, step by step', () => {
  const stub = createFarmTasksStub({ secret: SECRET })
  for (const step of FARM_TASKS_CONTRACT.steps) {
    const { method, path, body } = step.request
    assert.deepEqual(stub.answer(method, path, body, step.secret !== false), step.response, step.name)
  }
  const off = createFarmTasksStub({ secret: SECRET, configured: false })
  const { method, path, body } = FARM_TASKS_CONTRACT.not_configured.request
  assert.deepEqual(off.answer(method, path, body), FARM_TASKS_CONTRACT.not_configured.response)
})

function farmHarness() {
  const realFetch = globalThis.fetch
  const stub = createFarmTasksStub({ secret: SECRET })
  globalThis.fetch = stub.fetch
  stub.seedTasks(REPO, [{ number: 12, html_url: `stub://${REPO}/tasks/12`, title: 'Contract item', body: '', state: 'open' }])
  const item = { id: 'SLC-12', repo: REPO, issue: null, task_id: '12', pr: null, release_tag: null, metric: 'The port holds on sl.' }
  return {
    stub,
    tracker: forRepo(REPO).tracker,
    repo: REPO,
    item,
    violations: () => [...stub.strays.map((s) => `stray: ${s}`), ...stub.calls.filter((c) => !c.secretOk).map((c) => `no farm secret: ${c.path}`)],
    restore: () => {
      globalThis.fetch = realFetch
      db.prepare('DELETE FROM work_item WHERE repo = ?').run(REPO)
    },
  }
}

runTrackerContract('sl', () => {
  const h = farmHarness()
  return {
    ...h,
    primeCreate: (issue) => h.stub.primeNextTask(issue.number, issue.html_url),
    primeIssues: (list) => h.stub.seedTasks(REPO, list),
    primeCloseFailure: () => h.stub.failNext('close', 502, { error: 'task_close_refused' }),
  }
})

runTrackerPortContract('sl', () => {
  const h = farmHarness()
  return {
    ...h,
    comments: () => h.stub.callsTo('comment').map((c) => c.body.body),
    closes: () => h.stub.callsTo('close').map((c) => ({ summary: c.body.summary, reason: c.body.reason })),
  }
})

test('sl createIssue sends one farm create with the item’s labels and a body in Horizon’s section format', async () => {
  const h = farmHarness()
  try {
    const issue = await h.tracker.createIssue(REPO, {
      title: 'Labelled',
      outcome: 'It reads back.',
      metric: 'One line.',
      guardrails: '',
      priority: 'High',
      kind: 'task',
      lane: 'trivial',
      autopilotOff: true,
    })
    const [create] = h.stub.callsTo('create')
    assert.equal(h.stub.callsTo('create').length, 1)
    assert.equal(create.body.repo, REPO)
    assert.deepEqual(create.body.labels, ['priority: high', 'task', 'trivial', 'autopilot-off'])
    assert.match(create.body.body, /^## Outcome\nIt reads back\.\n\n## Success metric\nOne line\./)
    assert.match(create.body.idempotency_key, /^item:[0-9a-f-]{36}$/)
    assert.equal(h.stub.tasks.get(issue.number)?.title, 'Labelled')
    assert.equal(issue.html_url, `stub://${REPO}/tasks/${issue.number}`)
    assert.deepEqual(issue.labels, [{ name: 'priority: high' }, { name: 'task' }, { name: 'trivial' }, { name: 'autopilot-off' }])
    assert.deepEqual(h.violations(), [])
  } finally {
    h.restore()
  }
})

test('sl createIssue with a body marker keys the create on the body, so a repeat answers the first Task', async () => {
  const h = farmHarness()
  try {
    const fields = { title: 'Child', outcome: 'o', metric: 'm', guardrails: '', priority: 'Medium', bodySuffix: '<!-- horizon-split-of: X-1 -->' }
    const first = await h.tracker.createIssue(REPO, fields)
    const again = await h.tracker.createIssue(REPO, fields)
    assert.equal(again.number, first.number)
    assert.equal(h.stub.callsTo('create').length, 2)
    assert.equal(h.stub.callsTo('create')[0].body.idempotency_key, h.stub.callsTo('create')[1].body.idempotency_key)
    assert.match(h.stub.callsTo('create')[0].body.idempotency_key, /^body:[0-9a-f]{64}$/)
    assert.equal([...h.stub.tasks.values()].filter((t) => t.title === 'Child').length, 1)
  } finally {
    h.restore()
  }
})

test('an sl farm refusal reaches the caller as "<action> failed: <code>", never as response text', async () => {
  const h = farmHarness()
  try {
    h.stub.failNext('comment', 502, { error: 'Something <b>long</b> with spaces' })
    await assert.rejects(() => h.tracker.postIssueComment(h.item, 'x'), { message: 'Task comment failed: farm returned 502' })
    h.stub.failNext('close', 503, { error: 'task_driver_not_configured' })
    await assert.rejects(() => h.tracker.closeIssueWithSummary(h.item), { message: 'Task close failed: task_driver_not_configured' })
  } finally {
    h.restore()
  }
})
