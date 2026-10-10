// HZ-379 metric line 4 and guardrail 3: spawnItems takes a LIST of items
// from one parent. Two specs file two children, both recorded as the
// parent's children and both its dependencies; the parent stays waiting
// after the first closes and resumes only after the second. A filing that
// fails part-way files only what is left on retry.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitGithubStub } from './helpers/splitGithubStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-spawn-items-')), 'test.db')
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
const spawn = await import('../src/spawn.js')
const { kindStepIndex, endIndex } = await import('../../domain/js/lifecycle.js')

const REPO = 'FinTekkers/horizon'
const RUN_PLAN = kindStepIndex('Run plan', 'task')
const FINAL_GATE = endIndex('change') - 1

await orchestrator.init({ info: () => {}, warn: () => {} })
await new Promise((r) => setTimeout(r, 50))

after(() => {
  for (const { item_id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(item_id)
})

const SPECS = [
  { title: 'First part', outcome: 'Build the first part.', metric: '1. It works.' },
  { title: 'Second part', outcome: 'Build the second part.', metric: '1. It also works.' },
]
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const deps = (id) => db.prepare('SELECT depends_on_id FROM work_item_dependency WHERE item_id = ? ORDER BY depends_on_id').all(id).map((r) => r.depends_on_id)
const runPlanDispatches = (id) =>
  stub.calls.filter((c) => c.path.endsWith('/steps/run') && c.body?.item?.id === id && c.body?.step?.index === RUN_PLAN)

// A local (demo-mode) child closes at its final gate, through the store.
function closeLocal(id) {
  orchestrator.cancel(id)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(FINAL_GATE, id)
  assert.equal(store.approveGate(id, FINAL_GATE, '', 'You').ok, true)
}

test('two specs file two children; the parent waits for both and resumes only after the second closes', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind) VALUES ('T-TWO', 'two children', 'Medium', ?, 'task')").run(RUN_PLAN)
  const parent = store.getItem('T-TWO')
  const filed = await spawn.spawnItems(parent, SPECS, { requestKey: 'plan:1', kind: 'change' })
  assert.equal(filed.ok, true, JSON.stringify(filed))
  assert.equal(filed.children.length, 2)
  const [first, second] = filed.children
  for (const c of filed.children) orchestrator.cancel(c)
  assert.equal(spawn.linkSpawned('T-TWO', 'plan:1').ok, true)

  assert.deepEqual(deps('T-TWO'), [...filed.children].sort())
  assert.equal(store.getItem(first).title, 'First part')
  assert.equal(store.getItem(second).title, 'Second part')
  const fields = store.spawnFields('T-TWO')
  assert.deepEqual(
    fields.spawned.map((c) => [c.id, c.closed]),
    [
      [first, false],
      [second, false],
    ],
  )
  for (const c of filed.children) assert.deepEqual(store.spawnFields(c).spawnedBy, { id: 'T-TWO', title: 'two children' })

  closeLocal(first)
  await tick()
  assert.equal(runPlanDispatches('T-TWO').length, 0, 'still waiting on the second child')
  assert.deepEqual(
    store.spawnFields('T-TWO').spawned.map((c) => c.closed),
    [true, false],
  )

  closeLocal(second)
  await tick()
  assert.equal(runPlanDispatches('T-TWO').length, 1, 'resumed once both are closed')
  orchestrator.cancel('T-TWO')

  // The same request again files nothing new.
  const again = await spawn.spawnItems(parent, SPECS, { requestKey: 'plan:1', kind: 'change' })
  assert.deepEqual(again.children, filed.children)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM item_spawn WHERE parent_id = 'T-TWO'").get().n, 2)
})

test('a filing that fails on the second spec files only that one on retry: 2 issues, 2 rows, 2 edges', async () => {
  const project = store.createProject('FinTekkers').id
  store.addRepoToProject(project, REPO)
  const issue = stub.addIssue(REPO, { title: 'partial' })
  const id = `${store.findRepo(REPO).prefix}-${issue.number}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, issue, repo, project_id, cursor, kind) VALUES (?, 'partial', 'Medium', ?, ?, ?, ?, 'task')",
  ).run(id, issue.number, REPO, project, RUN_PLAN)
  const parent = store.getItem(id)
  const creates = () => stub.creates(REPO).filter((c) => c.body.body.includes(`horizon-spawned-by: ${id} `))

  stub.hooks.afterCreate = () => {
    stub.hooks.createStatus[REPO] = 500 // every create after the first fails
  }
  let result
  try {
    result = await spawn.spawnItems(parent, SPECS, { requestKey: 'step:1:0', kind: 'change' })
  } finally {
    stub.hooks.afterCreate = null
    delete stub.hooks.createStatus[REPO]
  }
  assert.equal(result.status, 502, JSON.stringify(result))
  assert.deepEqual(
    db.prepare('SELECT seq, status FROM item_spawn WHERE parent_id = ? ORDER BY seq').all(id),
    [
      { seq: 0, status: 'filed' },
      { seq: 1, status: 'failed' },
    ],
  )
  assert.ok(spawn.linkSpawned(id, 'step:1:0').error, 'a half-filed request is never linked')

  const retry = await spawn.spawnItems(parent, SPECS, { requestKey: 'step:1:0', kind: 'change' })
  assert.equal(retry.ok, true, JSON.stringify(retry))
  for (const c of retry.children) orchestrator.cancel(c)
  assert.equal(spawn.linkSpawned(id, 'step:1:0').ok, true)

  assert.equal(creates().length, 3, 'one create per spec, plus the one that failed')
  assert.equal(stub.repoIssues(REPO).filter((i) => i.body.includes(`horizon-spawned-by: ${id} `)).length, 2, '2 issues')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_spawn WHERE parent_id = ?').get(id).n, 2, '2 rows')
  assert.deepEqual(deps(id), [...retry.children].sort(), '2 edges')
})

test('requestKeyFor: a retry while the child is open reuses the key; after it ships, a new key', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind) VALUES ('T-KEY', 'keys', 'Medium', ?, 'task')").run(RUN_PLAN)
  const key = spawn.requestKeyFor('T-KEY', 4)
  const filed = await spawn.spawnItems(store.getItem('T-KEY'), [SPECS[0]], { requestKey: key, kind: 'change' })
  orchestrator.cancel(filed.children[0])
  assert.equal(spawn.requestKeyFor('T-KEY', 4), key, 'same key while the child is open')
  closeLocal(filed.children[0])
  assert.notEqual(spawn.requestKeyFor('T-KEY', 4), key, 'a new key once it has shipped')
  orchestrator.cancel('T-KEY')
})
