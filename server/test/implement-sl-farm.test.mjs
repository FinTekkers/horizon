// HO-902, the farm path: an implement run that pushed a branch for an sl item
// never reaches createPrFromBranch, and what the run records names sl and the
// item. An sl item with a tracker record submits its diff (HO-877) and its
// summary says no PR is created; one with neither a Task nor an issue has no
// diff to submit, so the run fails with that named reason and the item pauses.
// GitHub items keep today's PR behaviour exactly — with an issue they open
// their PR, with a null issue they complete with no PR call and no sl text.
// implement-sl-reason.test.mjs is the mock path.

import { test, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectReadyRepo } from './helpers/readyRepo.mjs'

// farmd stand-in: names a diff for /vcs/submit, accepts everything else.
const farmd = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    const body = req.url === '/vcs/submit' ? { ok: true, diff: 'D902', commit: '2'.repeat(40), updated: false } : {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
})
await new Promise((resolve) => farmd.listen(0, '127.0.0.1', resolve))

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-implement-sl-farm-')), 'test.db')
process.env.FARM_URL = `http://127.0.0.1:${farmd.address().port}`
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire during these tests
process.env.FARM_STEP_TIMEOUT_MS = '600000'
for (const key of ['FARM_HOME', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { forKind, setBackendForTest } = await import('../src/backends/index.js')
const { IMPLEMENT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

after(() => farmd.close())

store.purgeDemoItems()
const SL_REPO = 'acme/sl-farm'
const GH_REPO = 'acme/gh-farm'
const projectId = store.createProject('HO-902 farm').id
assert.equal(store.addRepoToProject(projectId, SL_REPO, 'sl').ok, true)
assert.equal(store.addRepoToProject(projectId, GH_REPO).ok, true)
connectReadyRepo(db, SL_REPO)
connectReadyRepo(db, GH_REPO)

// createPrFromBranch spies on both backends; every other method is the real one.
const prCalls = { sl: [], github: [] }
for (const backend of ['sl', 'github']) {
  const real = forKind(backend)
  setBackendForTest(backend, {
    ...real,
    review: {
      ...real.review,
      createPrFromBranch: async (item, branch) => {
        prCalls[backend].push({ id: item.id, branch })
        return { number: 77, html_url: `https://github.com/${item.repo}/pull/77` }
      },
    },
  })
}
after(() => {
  setBackendForTest('sl', null)
  setBackendForTest('github', null)
})

const seeded = []
afterEach(() => seeded.splice(0).forEach((id) => orchestrator.cancel(id)))

function itemWithActiveImplementRun(id, { repo, issue = null, taskId = null, backend = 'github' }) {
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, repo, issue, project_id, backend, task_id) VALUES (?, ?, 'Medium', ?, ?, ?, ?, ?, ?)",
  ).run(id, `Item ${id}`, IMPLEMENT_STEP_INDEX, repo, issue, projectId, backend, taskId)
  seeded.push(id)
  return Number(
    db.prepare("INSERT INTO step_run (item_id, step_index, agent, status) VALUES (?, ?, 'eng', 'active')").run(id, IMPLEMENT_STEP_INDEX)
      .lastInsertRowid,
  )
}
const run = (runId) => db.prepare('SELECT status, output FROM step_run WHERE id = ?').get(runId)
const row = (id) => db.prepare('SELECT pr, diff_id, cursor FROM work_item WHERE id = ?').get(id)
const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id DESC').all(id).map((e) => e.text)
const complete = (runId, id) => orchestrator.completeFarmRun(runId, { summary: 'done', artifacts: { branch: `horizon/${id.toLowerCase()}` } })

test('metric 2: an sl item with no tracker record fails with a reason naming sl and the item; no PR call', async () => {
  const id = 'SLF-1'
  const runId = itemWithActiveImplementRun(id, { repo: SL_REPO, backend: 'sl' })
  await complete(runId, id)

  assert.equal(prCalls.sl.length + prCalls.github.length, 0, 'createPrFromBranch is never called')
  const { status, output } = run(runId)
  assert.notEqual(status, 'done')
  assert.equal(
    output,
    `FAILED: sl item ${id}: code pushed to horizon/slf-1, but no PR is created for sl items, and with no Task there is no diff to submit`,
  )
  assert.equal(store.itemViewById(id).paused, true, 'the item pauses for a human')
  assert.equal(row(id).cursor, IMPLEMENT_STEP_INDEX, 'no advance')
  // R2: the owner sees it in the activity feed.
  assert.ok(
    events(id).some((t) => t.startsWith(`agent step failed: sl item ${id}`)),
    `no named failure event in ${JSON.stringify(events(id))}`,
  )
})

test('metric 2: a Task-backed sl item with a null issue submits its diff, and the summary names sl and the item', async () => {
  const id = 'SLF-2'
  const runId = itemWithActiveImplementRun(id, { repo: SL_REPO, taskId: 'T902', backend: 'sl' })
  await complete(runId, id)

  assert.equal(prCalls.sl.length + prCalls.github.length, 0, 'createPrFromBranch is never called')
  const { status, output } = run(runId)
  assert.equal(status, 'done')
  assert.ok(output.includes('submitted D902'), output)
  assert.ok(output.endsWith(`sl item ${id}: no PR is created for sl items`), output)
  assert.equal(row(id).pr, null)
  assert.ok(events(id).some((t) => t.includes(`sl item ${id}: no PR is created for sl items`)), 'the completed event names it')
})

test('metric 2 (R1): an sl item with issue 42 never reaches createPrFromBranch, and the summary names sl and the item', async () => {
  const id = 'SLF-3'
  const runId = itemWithActiveImplementRun(id, { repo: SL_REPO, issue: 42, backend: 'sl' })
  await complete(runId, id)

  assert.equal(prCalls.sl.length + prCalls.github.length, 0, 'createPrFromBranch is never called')
  const { status, output } = run(runId)
  assert.equal(status, 'done')
  assert.ok(output.includes(`sl item ${id}`), output)
  assert.ok(output.includes('no PR is created for sl items'), output)
  assert.ok(!output.includes('backend_not_implemented'), output)
  assert.equal(row(id).pr, null)
})

test('guardrail 1: a GitHub item with an issue and a branch still opens its PR and completes', async () => {
  const id = 'GHF-1'
  const runId = itemWithActiveImplementRun(id, { repo: GH_REPO, issue: 7 })
  await complete(runId, id)

  assert.deepEqual(prCalls.github, [{ id, branch: 'horizon/ghf-1' }])
  assert.equal(prCalls.sl.length, 0)
  prCalls.github.length = 0
  const { status, output } = run(runId)
  assert.equal(status, 'done')
  assert.equal(output, 'done — opened PR #77')
  assert.equal(row(id).pr, 77)
})

test('guardrail 4 (R3): a GitHub item with a null issue and a branch completes with no PR call and no sl text', async () => {
  const id = 'GHF-2'
  const runId = itemWithActiveImplementRun(id, { repo: GH_REPO })
  await complete(runId, id)

  assert.equal(prCalls.sl.length + prCalls.github.length, 0)
  const { status, output } = run(runId)
  assert.equal(status, 'done')
  assert.equal(output, 'done')
  assert.ok(!events(id).some((t) => t.includes('sl item')), 'no sl text in the feed')
  assert.equal(row(id).pr, null)
})
