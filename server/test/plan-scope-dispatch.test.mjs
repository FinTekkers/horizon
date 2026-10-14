// HZ-447: a Plan's farm steps carry its repo scope (plan_scope). Driven
// through the real orchestrator with the farm as a captured fetch stub (the
// trivial-lane.test.mjs harness): the dispatched Inventory task names the
// in-scope repos with their latest check, and every other connected repo as
// out of scope. Other kinds carry no plan_scope.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-plan-scope-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_NOTIFY_ENABLED', 'WA_POLL_ENABLED']) delete process.env[key]

const farmCalls = []
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.startsWith('https://api.github.com/')) return { ok: false, status: 500, json: async () => ({ message: 'stub' }) }
  farmCalls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null })
  return { ok: true, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { kindStepIndex, firstStepIndex } = await import('../../domain/js/lifecycle.js')
const { connectReadyRepo } = await import('./helpers/readyRepo.mjs')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
after(() => {
  for (const row of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(row.id)
})

// The fixture comes after init and adds no project through the store: either
// would start the farm, and the stub farm never reports running.
const IN_SCOPE = ['acme/api', 'acme/data', 'acme/web']
const OUTSIDE = 'acme/secret'
const OTHER_PROJECT = 'other/thing'
const SHA = 'a'.repeat(40)

for (const repo of [...IN_SCOPE, OUTSIDE]) connectReadyRepo(db, repo)
const project = db.prepare("SELECT id FROM project WHERE name = 'Ready repos'").get().id
db.prepare('UPDATE project SET enabled = 1 WHERE id = ?').run(project)
const other = db.prepare("INSERT INTO project (name, enabled) VALUES ('Elsewhere', 1)").run().lastInsertRowid
db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, 'EW')").run(other, OTHER_PROJECT)

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms))
async function waitFor(predicate, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${what}`)
}
const dispatchesOf = (id) => farmCalls.filter((c) => c.url.endsWith('/steps/run') && c.body?.item?.id === id)

test('an Inventory dispatch carries plan_scope: the scope repos with their last check, every other repo out of scope', async () => {
  const itemId = 'PS-1'
  db.prepare(
    'INSERT INTO work_item (id, title, priority, cursor, kind, repo, project_id, scope_repos_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(itemId, 'Retire the FIX gateway', 'High', kindStepIndex('Inventory current state', 'plan'), 'plan', 'acme/api', project, JSON.stringify(['acme/web', 'acme/data']))
  assert.ok(store.recordCheckPass({ repo: 'acme/api', itemId, sha: SHA, finishedAt: new Date().toISOString(), source: 'implement' }))

  orchestrator.kick(itemId)
  await waitFor(() => dispatchesOf(itemId).length === 1, 'the Inventory dispatch')
  const { plan_scope: scope } = dispatchesOf(itemId)[0].body
  // acme/api is in scope as the Plan's own repo, though the stored list omits it.
  assert.deepEqual(scope.repos.map((r) => r.repo), IN_SCOPE)
  const api = scope.repos.find((r) => r.repo === 'acme/api')
  assert.deepEqual(api.last_check, { status: 'pass', sha: SHA, finished_at: api.last_check.finished_at, source: 'implement' })
  assert.deepEqual(scope.repos.find((r) => r.repo === 'acme/web').last_check, { status: 'none' })
  assert.deepEqual(scope.out_of_scope.sort(), [OUTSIDE, OTHER_PROJECT].sort())
})

test('a Plan with no stored scope reads every repo in its project', () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind, repo, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'PS-2', 'All repos', 'High', firstStepIndex('plan'), 'plan', 'acme/api', project,
  )
  const { plan_scope: scope } = orchestrator.planScopeField(store.getItem('PS-2'))
  assert.deepEqual(scope.repos.map((r) => r.repo), [...IN_SCOPE, OUTSIDE].sort())
  assert.deepEqual(scope.out_of_scope, [OTHER_PROJECT])
})

test('only a Plan carries plan_scope', () => {
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind, repo, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'PS-3', 'A change', 'High', 0, 'change', 'acme/api', project,
  )
  assert.deepEqual(orchestrator.planScopeField(store.getItem('PS-3')), {})
})
