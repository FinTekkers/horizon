// HO-901, farm path (FARM_URL set): an sl Task-backed item has a null issue,
// like a local demo item, but it never takes a demo item's path. At Deploy it
// fails by name (deploy_unsupported) instead of completing with no release —
// there is no sl release path yet — and it never calls the GitHub API: not at
// Deploy, not when Implement hands back a branch, not on abandon, and not once
// its repo is disconnected (forRepo would then fall back to GitHub). A local
// demo item and a GitHub item keep exactly today's calls. Every outbound fetch
// is recorded, and a GitHub item's release proves the recorder sees GitHub.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { connectReadyRepo } from './helpers/readyRepo.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-sl-farm-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-sl-farm-home-'))
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire here
process.env.FARM_STEP_TIMEOUT_MS = '600000'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { IMPLEMENT_STEP_INDEX, DEPLOY_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')
const { setBackendForTest } = await import('../src/backends/index.js')
const { githubAdapters } = await import('../src/backends/github.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
await app.ready()
after(() => app.close())

// Every outbound fetch, farm and GitHub alike. GitHub answers a release.
const calls = []
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  const method = opts.method || 'GET'
  let body = null
  try {
    body = opts.body ? JSON.parse(opts.body) : null
  } catch {
    body = opts.body
  }
  calls.push({ url: u, method, body })
  if (u.includes('api.github.com') && u.includes('/releases/tags/')) return { ok: false, status: 404, json: async () => ({}) }
  if (u.includes('api.github.com') && u.endsWith('/releases') && method === 'POST') {
    return { ok: true, status: 201, json: async () => ({ tag_name: body.tag_name, html_url: `https://github.com/x/releases/${body.tag_name}` }) }
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
}
const githubCalls = (since) => calls.slice(since).filter((c) => c.url.includes('github.com'))
const farmRuns = (id, since) => calls.slice(since).filter((c) => c.url.includes('/steps/run') && c.body?.item?.id === id)

// A second check behind the fetch recorder: GitHub's PR and release calls.
const githubAdapterCalls = []
setBackendForTest('github', {
  ...githubAdapters,
  review: {
    ...githubAdapters.review,
    createPrFromBranch: (...args) => {
      githubAdapterCalls.push(['createPrFromBranch', args[0]?.id])
      return githubAdapters.review.createPrFromBranch(...args)
    },
  },
  vcs: {
    ...githubAdapters.vcs,
    createDeployRelease: (...args) => {
      githubAdapterCalls.push(['createDeployRelease', args[0]?.id])
      return githubAdapters.vcs.createDeployRelease(...args)
    },
  },
})
after(() => setBackendForTest('github', null))

const projectId = store.createProject('HO-901 farm').id
const SL_REPO = 'acme/sl-deploy'
const SL_NODEPLOY = 'acme/sl-nodeploy'
const GH_REPO = 'acme/gh-deploy'
assert.equal(store.addRepoToProject(projectId, SL_REPO, 'sl').ok, true)
assert.equal(store.addRepoToProject(projectId, SL_NODEPLOY, 'sl').ok, true)
assert.equal(store.addRepoToProject(projectId, GH_REPO).ok, true)
// A deploy target that exists (readiness passes) but never re-validates, so
// no deploy queue or deploy wait joins in (helpers/readyRepo.mjs).
connectReadyRepo(db, SL_REPO, { unrunnableTarget: true })
connectReadyRepo(db, SL_NODEPLOY, { noDeploy: true })
connectReadyRepo(db, GH_REPO, { unrunnableTarget: true })

// An sl item through HO-875's own insert path (store.recordTask: issue NULL,
// task_id set, backend taken from the repo), then moved to `cursor`.
let taskNumber = 100
function slItemAt(repo, cursor) {
  const recorded = store.recordTask({ number: ++taskNumber, title: `Task ${taskNumber}`, body: '', labels: [], state: 'open' }, repo)
  assert.equal(recorded?.created, true)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(cursor, recorded.id)
  const item = store.getItem(recorded.id)
  assert.equal(item.issue, null)
  assert.equal(item.backend, 'sl')
  return item.id
}
const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
const runsAt = (id, step) =>
  db.prepare('SELECT id, status, output FROM step_run WHERE item_id = ? AND step_index = ? ORDER BY id').all(id, step)
const settle = () => new Promise((r) => setTimeout(r, 30))
const unsupported = (id) => `deploy_unsupported: ${id} is on the sl backend, which has no release path yet`

async function boardCard(id) {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: alice.cookie } })
  assert.equal(res.statusCode, 200, res.body)
  return res.json().items.find((i) => i.id === id)
}

test('metric 2: an sl item at Deploy fails by name — no release-less skip, no farm dispatch, no GitHub call', async () => {
  const id = slItemAt(SL_REPO, DEPLOY_STEP_INDEX)
  const since = calls.length
  const adapterSince = githubAdapterCalls.length
  orchestrator.kick(id)
  await settle()

  const runs = runsAt(id, DEPLOY_STEP_INDEX)
  assert.equal(runs.length, 1, 'one run, never auto-retried')
  assert.equal(runs[0].status, 'cancelled')
  assert.equal(runs[0].output, `FAILED: ${unsupported(id)}`)
  assert.doesNotMatch(runs[0].output, /release skipped|not deployed/)
  assert.deepEqual(farmRuns(id, since), [], 'no /steps/run')
  assert.deepEqual(githubCalls(since), [], 'no GitHub call')
  assert.deepEqual(githubAdapterCalls.slice(adapterSince), [])
  const item = store.getItem(id)
  assert.equal(item.cursor, DEPLOY_STEP_INDEX, 'the cursor stays at Deploy')
  assert.equal(item.release_tag, null)

  // What the owner sees over the API the UI reads: a paused item at Deploy
  // whose failure names the item and the reason.
  const card = await boardCard(id)
  assert.equal(card.cursor, DEPLOY_STEP_INDEX)
  assert.equal(card.paused, true)
  assert.ok(
    card.events.some((e) => e.text.includes(`agent step failed: ${unsupported(id)}`)),
    JSON.stringify(card.events.map((e) => e.text)),
  )
  assert.ok(!card.events.some((e) => /release skipped/.test(e.text)))
})

test("metric 2 parity: the mock and farm Deploy paths agree for an sl item — fail by name, or skip a 'no deploy' repo", async () => {
  // A repo with a deploy target: both fail with the same reason.
  const id = slItemAt(SL_REPO, DEPLOY_STEP_INDEX)
  orchestrator.kick(id)
  await settle()
  const mock = await orchestrator.MOCK_STEP_BEHAVIOR['Deploy the changes'](store.getItem(id))
  assert.deepEqual(mock, { failure: unsupported(id) })
  assert.equal(runsAt(id, DEPLOY_STEP_INDEX).at(-1).output, `FAILED: ${mock.failure}`)

  // A 'no deploy' repo with no target: both complete as not deployed, the
  // repo-config outcome checked before the sl guard on both paths.
  const marked = slItemAt(SL_NODEPLOY, DEPLOY_STEP_INDEX)
  const since = calls.length
  orchestrator.kick(marked)
  await settle()
  const notDeployed = `not deployed: ${SL_NODEPLOY} is marked no deploy`
  assert.deepEqual(runsAt(marked, DEPLOY_STEP_INDEX).map((r) => [r.status, r.output]), [['done', notDeployed]])
  assert.deepEqual(await orchestrator.MOCK_STEP_BEHAVIOR['Deploy the changes'](store.getItem(marked)), { summary: notDeployed })
  assert.deepEqual(githubCalls(since), [])
})

test('guardrail 1 positive control: a GitHub item with its issue still publishes its release — the recorder sees GitHub', async () => {
  insertItem.run('GHD-1', 'GitHub deploy', 'Medium', DEPLOY_STEP_INDEX, GH_REPO, 5, projectId)
  const since = calls.length
  const adapterSince = githubAdapterCalls.length
  orchestrator.kick('GHD-1')
  for (let i = 0; i < 50 && farmRuns('GHD-1', since).length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  orchestrator.cancel('GHD-1')

  assert.deepEqual(
    githubCalls(since).map((c) => [c.method, new URL(c.url).pathname]),
    [
      ['GET', `/repos/${GH_REPO}/releases/tags/deploy-ghd-1`],
      ['POST', `/repos/${GH_REPO}/releases`],
    ],
  )
  assert.deepEqual(githubAdapterCalls.slice(adapterSince), [['createDeployRelease', 'GHD-1']])
  assert.equal(farmRuns('GHD-1', since).length, 1, 'the DevOps agent verifies the release')
  assert.equal(farmRuns('GHD-1', since)[0].body.item.release_tag, 'deploy-ghd-1')
})

test('metric 4 / guardrail 1: a demo item goes to the farm with no release at Deploy and opens no PR at Implement', async () => {
  // Deploy: no repo, so no readiness rule, no release; the farm run carries no tag.
  insertItem.run('DEMO-1', 'Demo deploy', 'Medium', DEPLOY_STEP_INDEX, null, null, null)
  let since = calls.length
  const adapterSince = githubAdapterCalls.length
  orchestrator.kick('DEMO-1')
  for (let i = 0; i < 50 && farmRuns('DEMO-1', since).length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  orchestrator.cancel('DEMO-1')
  assert.equal(farmRuns('DEMO-1', since).length, 1, 'dispatched to the farm as today')
  assert.equal(farmRuns('DEMO-1', since)[0].body.item.release_tag ?? null, null)
  assert.deepEqual(githubCalls(since), [])

  // Implement: a pushed branch on a demo item opens no PR.
  insertItem.run('DEMO-2', 'Demo implement', 'Medium', IMPLEMENT_STEP_INDEX, null, null, null)
  const runId = Number(
    db.prepare("INSERT INTO step_run (item_id, step_index, agent, status) VALUES ('DEMO-2', ?, 'eng', 'active')").run(IMPLEMENT_STEP_INDEX)
      .lastInsertRowid,
  )
  since = calls.length
  await orchestrator.completeFarmRun(runId, { summary: 'did it', artifacts: { branch: 'horizon/demo-2' } })
  orchestrator.cancel('DEMO-2')
  assert.equal(runsAt('DEMO-2', IMPLEMENT_STEP_INDEX)[0].status, 'done')
  assert.equal(store.getItem('DEMO-2').pr, null)
  assert.deepEqual(githubCalls(since), [])
  assert.deepEqual(githubAdapterCalls.slice(adapterSince), [], 'no createPrFromBranch, no createDeployRelease')
})

test('guardrail 3: an sl item handing back a branch at Implement opens no GitHub PR and makes no GitHub call', async () => {
  const id = slItemAt(SL_REPO, IMPLEMENT_STEP_INDEX)
  const runId = Number(
    db.prepare("INSERT INTO step_run (item_id, step_index, agent, status) VALUES (?, ?, 'eng', 'active')").run(id, IMPLEMENT_STEP_INDEX)
      .lastInsertRowid,
  )
  const since = calls.length
  const adapterSince = githubAdapterCalls.length
  await orchestrator.completeFarmRun(runId, { summary: 'did it', artifacts: { branch: `horizon/${id.toLowerCase()}` } })
  orchestrator.cancel(id)
  assert.deepEqual(githubAdapterCalls.slice(adapterSince), [], 'no createPrFromBranch')
  assert.deepEqual(githubCalls(since), [])
  assert.equal(store.getItem(id).pr, null)
})

test('guardrail 3: abandoning an sl item makes no GitHub call', async () => {
  const id = slItemAt(SL_REPO, IMPLEMENT_STEP_INDEX)
  const since = calls.length
  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/abandon`,
    headers: { cookie: alice.cookie, 'x-human-key': alice.pin },
    payload: { reason: 'not needed' },
  })
  assert.equal(res.statusCode, 200, res.body)
  await settle()
  assert.ok(store.getItem(id).abandoned_at)
  assert.deepEqual(githubCalls(since), [])
})

test('guardrail 3: once its sl repo is disconnected, an sl item still fails Deploy by name and abandons with no GitHub call', async () => {
  const REPO = 'acme/sl-gone'
  assert.equal(store.addRepoToProject(projectId, REPO, 'sl').ok, true)
  connectReadyRepo(db, REPO, { unrunnableTarget: true })
  const atDeploy = slItemAt(REPO, DEPLOY_STEP_INDEX)
  const toAbandon = slItemAt(REPO, IMPLEMENT_STEP_INDEX)
  assert.equal(store.removeRepoFromProject(projectId, REPO).ok, true)
  // The live lookup now falls back to GitHub; the item's own backend does not.
  assert.equal(store.findRepo(REPO), null)
  assert.equal(store.getItem(atDeploy).backend, 'sl')

  const since = calls.length
  orchestrator.kick(atDeploy)
  await settle()
  assert.equal(runsAt(atDeploy, DEPLOY_STEP_INDEX).at(-1).output, `FAILED: ${unsupported(atDeploy)}`)
  assert.equal(store.getItem(atDeploy).cursor, DEPLOY_STEP_INDEX)

  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${toAbandon}/abandon`,
    headers: { cookie: alice.cookie, 'x-human-key': alice.pin },
    payload: { reason: 'repo is gone' },
  })
  assert.equal(res.statusCode, 200, res.body)
  await settle()
  assert.ok(store.getItem(toAbandon).abandoned_at)
  assert.deepEqual(
    githubCalls(since).map((c) => `${c.method} ${c.url}`),
    [],
    'no api.github.com call — never an issues/null comment or close',
  )
})
