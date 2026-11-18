// HO-880 metric 2 (R3): an imported item is never dispatched again — a kick
// creates no step_run for it and leaves its cursor where it was, while an item
// that was never imported, at the same step, is dispatched as before.
//
// Mock mode (FARM_URL unset), like not-dispatched.test.mjs: a dispatch is a
// step_run row, written synchronously by kick(). With no farm, the sl
// Tracker's methods are placeholders, so the import here is driven through
// importProject() with an in-memory Tracker port.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

globalThis.fetch = async () => {
  throw new Error('import dispatch test: no network')
}

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-import-dispatch-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '600000'
for (const key of ['FARM_URL', 'GITHUB_TOKEN', 'HORIZON_REPO', 'GITHUB_WEBHOOK_SECRET', 'FARM_HOME']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { importProject } = await import('../src/importProject.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: orchestrator.kick, cancel: orchestrator.cancel, waitReason: orchestrator.waitReason })
after(() => {
  for (const { id } of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(id)
})

const ARCH = requiredStepIndex('Architecture review')
const runsOf = (id) => db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ?').get(id).n
const cursorOf = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const seed = (id, repo, projectId) =>
  db
    .prepare("INSERT INTO work_item (id, title, priority, desc, metric, issue, repo, project_id, cursor, backend) VALUES (?, ?, 'High', 'o', '1. m', 1, ?, ?, ?, 'github')")
    .run(id, `Item ${id}`, repo, projectId, ARCH)

// The first project starts enabled; the others are enabled by hand.
const source = store.createProject('Dispatch old').id
assert.equal(store.addRepoToProject(source, 'acme/dispatch-old').ok, true)
const target = store.createProject('Dispatch new').id
assert.equal(store.addRepoToProject(target, 'acme/dispatch-new', 'sl').ok, true)
const plain = store.createProject('Dispatch plain').id
assert.equal(store.addRepoToProject(plain, 'acme/dispatch-plain').ok, true)
for (const id of [target, plain]) store.setProjectEnabled(id, true)

const FROZEN = `${store.findRepo('acme/dispatch-old').prefix}-1`
seed(FROZEN, 'acme/dispatch-old', source)

let next = 1
const tracker = {
  findSplitIssue: async () => null,
  createIssue: async (repo, fields) => {
    const number = next++
    return { number, html_url: `mem://${repo}/${number}`, title: fields.title, body: '', labels: [], state: 'open' }
  },
}

test('R3: a kick never dispatches a frozen item; a never-imported item at the same step is dispatched', async () => {
  const result = await importProject({ sourceProjectId: source, targetProjectId: target, who: 'Owner', trackerFor: () => tracker })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.open, 1)

  orchestrator.kick(FROZEN)
  orchestrator.kickProjectItems(source)
  assert.equal(runsOf(FROZEN), 0, 'no step_run for the frozen item')
  assert.equal(cursorOf(FROZEN), ARCH)
  assert.equal(orchestrator.waitReason(FROZEN).kind, 'imported')

  const PLAIN = `${store.findRepo('acme/dispatch-plain').prefix}-1`
  seed(PLAIN, 'acme/dispatch-plain', plain)
  orchestrator.kick(PLAIN)
  assert.equal(runsOf(PLAIN), 1, 'the control item is dispatched')
})
