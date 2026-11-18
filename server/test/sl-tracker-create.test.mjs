// HO-875 metric 1 and guardrail 1: on an sl repo, creating an item makes
// exactly one farmd Task create and stores the returned number in
// work_item.task_id; a create whose answer times out is retried with the same
// key, so it still leaves one Task and one row. A Plan-filed child (through
// planFiling.fileDrafts, the real Plan path) makes exactly one create per
// draft, and approving the filing again files nothing new. A split child
// (split.fileApprovedSplit) makes one create, and abandoning an sl item makes
// one not_planned close — none of it touches GitHub.
//
// globalThis.fetch is the farm stub (helpers/farmTasksStub.mjs): any URL that
// is not farmd's Task routes is refused and recorded in `farm.strays`, which
// must stay empty — so no api.github.com, delegate-to-agent or claim call.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loginFixtureUser } from './helpers/session.mjs'
import { createFarmTasksStub } from './helpers/farmTasksStub.mjs'

const SECRET = 'sl-create-farm-secret'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-sl-tracker-create-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = SECRET
for (const key of ['FARM_HOME', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN']) delete process.env[key]

const farm = createFarmTasksStub({ secret: SECRET })
const realFetch = globalThis.fetch
globalThis.fetch = farm.fetch

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const planDraft = await import('../src/planDraft.js')
const { fileDrafts } = await import('../src/planFiling.js')
const split = await import('../src/split.js')
const { buildApp } = await import('../src/app.js')
const { APPROVE_FILE_GATE_INDEX, PLAN_DRAFT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
const app = buildApp({ logger: false })
await app.ready()
const { cookie, pin } = loginFixtureUser(auth, config)

after(async () => {
  globalThis.fetch = realFetch
  await app.close()
})

const REPO = 'acme/sl-app'
const UPSTREAM = 'acme/sl-lib'
const project = store.createProject('sl create').id
for (const repo of [REPO, UPSTREAM]) assert.equal(store.addRepoToProject(project, repo, 'sl').ok, true)
const PREFIX = store.findRepo(REPO).prefix

const rows = (repo) => db.prepare('SELECT id, issue, task_id FROM work_item WHERE repo = ? ORDER BY rowid').all(repo)
const creates = () => farm.callsTo('create')
const noStrays = () => assert.deepEqual(farm.strays, [], 'no request but farmd’s Task routes')

test('metric 1: POST /api/items on an sl repo makes exactly one farmd create and stores the Task number in task_id', async () => {
  const before = { creates: creates().length, rows: rows(REPO).length }
  const res = await app.inject({
    method: 'POST',
    url: '/api/items',
    headers: { cookie },
    payload: { title: 'One Task', outcome: 'It is filed once.', metric: 'One create.', guardrails: 'No GitHub.', priority: 'High', repo: REPO },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(creates().length - before.creates, 1, 'exactly one create')
  const body = res.json()
  assert.equal(body.issue, null)
  assert.ok(Number.isInteger(body.task_id) && body.task_id > 0)
  assert.equal(body.url, `stub://${REPO}/tasks/${body.task_id}`)
  assert.match(body.id, new RegExp(`^${PREFIX}-\\d+$`))
  const item = store.getItem(body.id)
  assert.equal(item.task_id, String(body.task_id))
  assert.equal(item.issue, null)
  assert.equal(item.backend, 'sl')
  assert.equal(item.priority, 'High')
  assert.equal(item.metric, 'One create.')
  assert.equal(rows(REPO).length - before.rows, 1)
  noStrays()
})

test('metric 1: a create whose answer times out is retried with the same key — one Task and one row', async () => {
  const before = { creates: creates().length, tasks: farm.tasks.size, rows: rows(REPO).length }
  farm.timeoutNextCreate()
  const res = await app.inject({ method: 'POST', url: '/api/items', headers: { cookie }, payload: { title: 'Slow farm', outcome: 'It is filed once, slowly.', metric: 'One Task, one row.', repo: REPO } })
  assert.equal(res.statusCode, 200, res.body)
  const [first, retry] = creates().slice(before.creates)
  assert.equal(creates().length - before.creates, 2, 'the timed-out create and its one retry')
  assert.equal(retry.body.idempotency_key, first.body.idempotency_key)
  assert.equal(farm.tasks.size - before.tasks, 1, 'one Task in the farm')
  assert.equal(rows(REPO).length - before.rows, 1, 'one row')
  assert.equal(store.getItem(res.json().id).task_id, String(res.json().task_id))
  noStrays()
})

// A Plan item on the sl repo, at Approve & file, with `drafts` saved.
function planWithDrafts(id, drafts) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo, backend) VALUES (?, 'Plan to file', 'High', ?, 'plan', ?, ?, 'sl')").run(
    id,
    PLAN_DRAFT_STEP_INDEX,
    project,
    REPO,
  )
  const lines = (prefix) => [1, 2, 3].map((n) => `${prefix} line ${n}.`)
  const doc = {
    items: drafts.map((title, i) => ({
      id: `#${i + 1}`,
      repo: REPO,
      title,
      outcome: `${title}, done well.`,
      metric: lines('Metric'),
      guardrails: lines('Guardrail'),
      depends_on: [],
      must_also_cover: [],
    })),
    shared_guardrails: [],
    open_questions: [],
  }
  const saved = planDraft.ingestDraft(store.getItem(id), null, doc, 'PM')
  assert.equal(saved.ok, true, JSON.stringify(saved))
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(APPROVE_FILE_GATE_INDEX, id)
  return store.getItem(id)
}

test('metric 1: a Plan’s filing (fileDrafts) makes one create per draft; filing again makes no new row and no new Task', async () => {
  const plan = planWithDrafts('PLAN-SL-1', ['First child', 'Second child'])
  const before = { creates: creates().length, tasks: farm.tasks.size, rows: rows(REPO).length }
  const result = await fileDrafts(plan)
  assert.ok(result.summary, JSON.stringify(result))
  const filed = creates().slice(before.creates)
  assert.equal(filed.length, 2, 'one create per draft')
  assert.deepEqual(filed.map((c) => c.body.title), ['First child', 'Second child'])
  assert.equal(farm.tasks.size - before.tasks, 2)
  const children = rows(REPO).slice(before.rows)
  assert.equal(children.length, 2)
  for (const child of children) {
    assert.equal(child.issue, null)
    assert.ok(child.task_id, `${child.id} has its Task`)
    assert.equal(store.getItem(child.id).kind, 'change')
  }

  const again = { creates: creates().length, tasks: farm.tasks.size, rows: rows(REPO).length }
  const refiled = await fileDrafts(store.getItem(plan.id))
  assert.ok(refiled.summary)
  assert.equal(creates().length, again.creates, 'no new create')
  assert.equal(farm.tasks.size, again.tasks, 'no new Task')
  assert.equal(rows(REPO).length, again.rows, 'no new row')
  noStrays()
})

test('guardrail 1: a split child on an sl repo (fileApprovedSplit) makes one create and no GitHub call', async () => {
  const id = `${PREFIX}-900`
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo, task_id, backend) VALUES (?, 'Needs a lib change', 'Medium', ?, 'change', ?, ?, '900', 'sl')").run(
    id,
    split.DESIGN_GATE_INDEX,
    project,
    REPO,
  )
  const proposed = split.recordProposedSplit(id, 1, {
    repo: UPSTREAM,
    title: 'The lib part',
    description: 'The library exposes the hook.',
    metric: 'The hook exists.',
    guardrails: '',
    sameRepo: false,
  })
  assert.ok(proposed)
  const before = { creates: creates().length, rows: rows(UPSTREAM).length }
  const filed = await split.fileApprovedSplit(store.getItem(id), 'Tester')
  assert.equal(filed.ok, true, JSON.stringify(filed))
  assert.equal(creates().length - before.creates, 1, 'one create')
  assert.equal(creates().at(-1).body.repo, UPSTREAM)
  assert.match(creates().at(-1).body.body, /horizon-split-of/)
  const [child] = rows(UPSTREAM).slice(before.rows)
  assert.equal(filed.target, child.id)
  assert.equal(child.issue, null)
  assert.ok(child.task_id)
  noStrays()
})

test('guardrail 1: abandoning an sl item makes one not_planned close and no GitHub call', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/items', headers: { cookie }, payload: { title: 'Dropped', outcome: 'It will not be needed.', metric: 'Closed as not planned.', repo: REPO } })
  const { id, task_id: task } = res.json()
  const before = farm.callsTo('close').length
  const abandoned = await app.inject({ method: 'POST', url: `/api/items/${id}/abandon`, headers: { cookie, 'x-human-key': pin }, payload: { reason: 'Not needed any more.' } })
  assert.equal(abandoned.statusCode, 200, abandoned.body)
  const closes = farm.callsTo('close').slice(before)
  assert.equal(closes.length, 1)
  assert.equal(closes[0].path, `/api/farm/tasks/${task}/close`)
  assert.equal(closes[0].body.reason, 'not_planned')
  assert.match(closes[0].body.summary, /Not needed any more\./)
  assert.equal(farm.tasks.get(task).state, 'closed')
  const events = db.prepare('SELECT text FROM event WHERE item_id = ?').all(id).map((e) => e.text)
  assert.ok(events.includes(`closed Task ${task} as not planned`), events.join('\n'))
  noStrays()
})
