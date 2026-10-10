// HZ-379 metric line 2 and guardrail 2: a Task whose Assess filed a change
// item waits at Run plan. Run plan never dispatches while the change is
// open, nor once it closes until the deployed checkout's HEAD is at or past
// the change's merge commit; then it dispatches with that HEAD as
// `checkout_sha`. The real orchestrator and store run against a GitHub +
// farm stub; the git lookups go through spawn.js's test seam.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitGithubStub } from './helpers/splitGithubStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-spawn-hold-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.GITHUB_TOKEN = 'ghp_TEST_SENTINEL'
delete process.env.FARM_STEP_INDEXES
delete process.env.GITHUB_WEBHOOK_SECRET

const stub = splitGithubStub()
globalThis.fetch = stub.fetch

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const spawn = await import('../src/spawn.js')
const { kindStepIndex, endIndex } = await import('../../domain/js/lifecycle.js')

const REPO = 'FinTekkers/horizon'
const ASSESS = kindStepIndex('Assess', 'task')
const RUN_PLAN = kindStepIndex('Run plan', 'task')
const sha = (c) => c.repeat(40)
const MERGE = sha('a')
const OLD_HEAD = sha('b')
const NEW_HEAD = sha('c')

// The git seam: every child's PR merged at MERGE; the deployed checkout is
// whatever deploy_batch says; NEW_HEAD contains MERGE, OLD_HEAD does not.
let mergeShaGate = null
spawn.setSpawnGitForTest({
  resolveTarget: () => ({ key: 'horizon' }),
  getPrMergeSha: async () => {
    if (mergeShaGate) await mergeShaGate
    return MERGE
  },
  isAncestor: async (_repo, base, head) => base === MERGE && head === NEW_HEAD,
  getBranchSha: async () => {
    throw new Error('a repo with a deploy target never reads the branch head')
  },
})

const project = store.createProject('FinTekkers').id
store.addRepoToProject(project, REPO)
const PREFIX = store.findRepo(REPO).prefix

let batches = 0
function liveBatch(commit) {
  batches++
  db.prepare(
    "INSERT INTO deploy_batch (target, repo, status, window_closes_at, tag, commit_sha, live_at) VALUES ('horizon', ?, 'done', datetime('now'), ?, ?, datetime('now'))",
  ).run(REPO, `v-test-${batches}`, commit)
}

let tasks = 0
function newTask(cursor = RUN_PLAN) {
  tasks++
  const issue = stub.addIssue(REPO, { title: `task ${tasks}` })
  const id = `${PREFIX}-${issue.number}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, desc, metric, issue, repo, project_id, cursor, kind) VALUES (?, ?, 'Medium', 'Backfill.', 'Done.', ?, ?, ?, ?, 'task')",
  ).run(id, `task ${tasks}`, issue.number, REPO, project, cursor)
  return id
}

const SPEC = { title: 'Add a --since flag', outcome: 'The backfill script takes --since.', metric: '1. --since filters rows.' }

// Files the child through the real spawn engine and links it, the way a
// finished Assess does.
async function fileChild(taskId) {
  const filed = await spawn.spawnItems(store.getItem(taskId), [SPEC], { requestKey: `step:${ASSESS}:0`, kind: 'change' })
  assert.equal(filed.ok, true, JSON.stringify(filed))
  assert.equal(spawn.linkSpawned(taskId, `step:${ASSESS}:0`).ok, true)
  const childId = filed.children[0]
  orchestrator.cancel(childId) // the child's own PM step is not under test
  return childId
}

// Closes the child the way GitHub does: its PR merged, its issue closed.
function closeChild(childId) {
  const child = store.getItem(childId)
  db.prepare('UPDATE work_item SET pr = 42 WHERE id = ?').run(childId)
  const issue = stub.repoIssues(REPO).find((i) => i.number === child.issue)
  issue.state = 'closed'
  store.upsertFromGithub(issue, REPO)
}

const runPlanDispatches = (id) =>
  stub.calls.filter((c) => c.path.endsWith('/steps/run') && c.body?.item?.id === id && c.body?.step?.index === RUN_PLAN)
const runPlanRuns = (id) => db.prepare('SELECT id FROM step_run WHERE item_id = ? AND step_index = ?').all(id, RUN_PLAN)
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

// ---- seeded BEFORE init(): a Task left waiting by a restart ----
// Its child is closed and the merge is live; no timer of this process ever
// knew about it. Only init()'s own resume can dispatch it.
const RESTARTED = newTask()
const restartedChild = (() => {
  const issue = stub.addIssue(REPO, { title: 'restarted child', state: 'closed' })
  const id = `${PREFIX}-${issue.number}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, issue, repo, project_id, cursor, pr) VALUES (?, 'restarted child', 'Medium', ?, ?, ?, ?, 7)",
  ).run(id, issue.number, REPO, project, endIndex('change'))
  db.prepare(
    "INSERT INTO item_spawn (parent_id, request_key, seq, kind, payload_json, target_repo, target_issue, child_id, status, created_by) VALUES (?, ?, 0, 'change', '{}', ?, ?, ?, 'filed', 'Eng')",
  ).run(RESTARTED, `step:${ASSESS}:0`, REPO, issue.number, id)
  db.prepare('INSERT INTO work_item_dependency (item_id, depends_on_id, created_by) VALUES (?, ?, ?)').run(RESTARTED, id, 'Horizon')
  return id
})()
liveBatch(NEW_HEAD)

const orchestrator = await import('../src/orchestrator.js')
await orchestrator.init({ info: () => {}, warn: () => {} })
await tick(80) // ensureFarm's start handshake, then the async hold check

after(() => {
  spawn.setSpawnGitForTest(null)
  for (const { item_id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(item_id)
})

test('restart: with no timer left, the boot-time resume dispatches Run plan on the deployed commit', () => {
  assert.ok(store.getItem(restartedChild), 'fixture child exists')
  const sent = runPlanDispatches(RESTARTED)
  assert.equal(sent.length, 1, 'Run plan dispatched once at boot')
  assert.equal(sent[0].body.checkout_sha, NEW_HEAD)
  orchestrator.cancel(RESTARTED)
})

test('Run plan waits while the change is open, then while its merge is not live, then runs on the deployed commit', async () => {
  liveBatch(OLD_HEAD) // the deployed checkout predates the merge
  const id = newTask()
  const childId = await fileChild(id)

  // Guardrail 2: the spawned dependency is open.
  orchestrator.kick(id)
  await tick()
  assert.deepEqual(store.getItem(id).cursor, RUN_PLAN)
  assert.equal(runPlanDispatches(id).length, 0, 'never dispatched while the change is open')
  assert.equal(runPlanRuns(id).length, 0, 'no Run plan step_run while the change is open')

  // Closed, but the deployed HEAD (OLD_HEAD) does not contain the merge.
  closeChild(childId)
  await tick()
  assert.equal(runPlanDispatches(id).length, 0, 'never dispatched before the merge is live')
  assert.equal(runPlanRuns(id).length, 0)
  const holds = db.prepare("SELECT text FROM event WHERE item_id = ? AND text LIKE '%waits for the code it asked for%'").all(id)
  assert.equal(holds.length, 1, 'the hold says why, once')
  assert.match(holds[0].text, /merge not deployed/)
  assert.match(holds[0].text, /aaaaaaa/)

  // A second check that finds the same reason logs nothing new.
  orchestrator.kick(id)
  await tick()
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = ? AND text LIKE '%waits for the code%'").get(id).n, 1)

  // The next deploy contains the merge: the re-check dispatches on it.
  liveBatch(NEW_HEAD)
  orchestrator.kick(id)
  await tick()
  const sent = runPlanDispatches(id)
  assert.equal(sent.length, 1, 'Run plan dispatched once the merge is live')
  assert.equal(sent[0].body.checkout_sha, NEW_HEAD)
  orchestrator.cancel(id)
})

test('an abandoned child whose dependency was removed no longer holds Run plan', async () => {
  const id = newTask()
  const childId = await fileChild(id)
  store.abandonItem(childId, 'not needed after all', 'You')
  await tick()
  assert.equal(runPlanDispatches(id).length, 0, 'still blocked by the abandoned child')

  store.removeDependency(id, childId, 'You')
  await tick()
  const sent = runPlanDispatches(id)
  assert.equal(sent.length, 1, 'Run plan dispatched once the edge is gone')
  // The child is still listed as spawned: the record stays.
  assert.deepEqual(
    store.spawnFields(id).spawned.map((c) => c.id),
    [childId],
  )
  orchestrator.cancel(id)
})

test('a blocker added while the live-code check is in flight stops the dispatch', async () => {
  liveBatch(NEW_HEAD)
  const id = newTask()
  const childId = await fileChild(id)
  let release
  mergeShaGate = new Promise((r) => (release = r))
  try {
    closeChild(childId) // wakes the Task; the check now waits on the gate
    await tick()
    const other = store.createLocalItem({ title: 'late blocker', outcome: 'Something else first.', metric: 'Done.', priority: 'Medium' })
    orchestrator.cancel(other)
    assert.equal(store.addDependency(id, other, 'You').ok, true)
    release()
    await tick()
    assert.equal(runPlanDispatches(id).length, 0, 'the new open blocker is re-checked after the await')
    assert.equal(runPlanRuns(id).length, 0)
  } finally {
    mergeShaGate = null
  }
})
