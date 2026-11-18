// HO-902, the mock path: when an sl item reaches 'Specialist agent implements'
// with no farm, the step summary and the activity feed name the item and say
// no PR is created for sl items — never the generic "no GitHub — PR skipped".
// A local demo item, and a GitHub item with a null issue, keep today's exact
// summary: the sl check is by the repo's backend, never by `issue == null`.
// implement-sl-farm.test.mjs is the farm path.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectReadyRepo } from './helpers/readyRepo.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-implement-sl-reason-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '10'
delete process.env.FARM_URL
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {} })

const SL_REPO = 'acme/sl-app'
const GH_REPO = 'acme/gh-app'
const projectId = store.createProject('HO-902 mock').id
assert.equal(store.addRepoToProject(projectId, SL_REPO, 'sl').ok, true)
assert.equal(store.addRepoToProject(projectId, GH_REPO).ok, true)
connectReadyRepo(db, SL_REPO)
connectReadyRepo(db, GH_REPO)

const DEMO_SUMMARY = 'implementation complete on a feature branch; all checks green (no GitHub — PR skipped)'
const implement = orchestrator.MOCK_STEP_BEHAVIOR['Specialist agent implements']
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const kicked = []
after(() => kicked.forEach((id) => orchestrator.cancel(id)))

function seed(id, { repo = null, issue = null, taskId = null, backend = 'github' } = {}) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, repo, issue, project_id, task_id, backend) VALUES (?, ?, 'Medium', ?, ?, ?, ?, ?, ?)",
  ).run(id, `Item ${id}`, IMPLEMENT_STEP_INDEX, repo, issue, projectId, taskId, backend)
}

// Drives the item's implement step through kick → runMockStep and returns its
// finished run and the "completed …" event that step wrote.
async function runMockImplement(id) {
  kicked.push(id)
  orchestrator.kick(id)
  const implementRun = () =>
    db.prepare("SELECT status, output FROM step_run WHERE item_id = ? AND step_index = ? AND status != 'active'").get(id, IMPLEMENT_STEP_INDEX)
  const deadline = Date.now() + 3000
  while (!implementRun() && Date.now() < deadline) await wait(10)
  orchestrator.cancel(id)
  const run = implementRun()
  assert.ok(run, `${id}: the mock implement run never finished`)
  const event = db
    .prepare('SELECT text FROM event WHERE item_id = ? AND text LIKE ? ORDER BY id DESC')
    .get(id, '%completed “Specialist agent implements”%')
  assert.ok(event, `${id}: no completed event for the implement step`)
  return { run, event: event.text }
}

test('metric 1: an sl item with a null issue gets a summary naming sl and the item, not "PR skipped"', async () => {
  const { summary } = await implement({ id: 'SL-1', repo: SL_REPO, issue: null, task_id: 'T41' })
  assert.match(summary, /\bsl\b/)
  assert.ok(summary.includes('SL-1'), summary)
  assert.ok(!summary.includes('PR skipped'), summary)
  assert.equal(summary, 'sl item SL-1: implementation complete, but no PR is created for sl items')
})

test('metric 1 (R4): through runMockStep, the sl run output and the completed event name sl and the item', async () => {
  seed('SL-2', { repo: SL_REPO, taskId: 'T42', backend: 'sl' })
  const { run, event } = await runMockImplement('SL-2')
  assert.equal(run.status, 'done')
  for (const text of [run.output, event]) {
    assert.ok(text.includes('sl item SL-2'), text)
    assert.ok(text.includes('no PR is created for sl items'), text)
    assert.ok(!text.includes('PR skipped'), text)
  }
})

test('metric 3: a local demo item with no repo keeps the exact demo summary', async () => {
  const { summary } = await implement({ id: 'HZ-9', repo: null, issue: null })
  assert.equal(summary, DEMO_SUMMARY)
})

test('metric 3 (R4): through runMockStep, a local demo item’s event still ends with "(no GitHub — PR skipped)"', async () => {
  seed('DEMO-1')
  const { run, event } = await runMockImplement('DEMO-1')
  assert.equal(run.status, 'done')
  assert.equal(run.output, DEMO_SUMMARY)
  assert.ok(event.endsWith('(no GitHub — PR skipped)'), event)
  assert.ok(!event.includes('sl item'), event)
})

test('guardrail 4: a GitHub item with a null issue keeps the exact demo summary — a null issue alone is not sl', async () => {
  const { summary } = await implement({ id: 'GH-1', repo: GH_REPO, issue: null })
  assert.equal(summary, DEMO_SUMMARY)
})
