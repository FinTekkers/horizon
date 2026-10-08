// HZ-304: Horizon never silently builds or ships an unready repo. An
// implement step on a repo with no check commands fails by name at dispatch,
// unless the owner marked the repo 'no checks'; a deploy step on a repo with no
// deploy target fails the same way, unless it is marked 'no deploy'. Both fail
// inside the dispatch call itself: no queue watchdog, no release, no farm call,
// no auto-retry. An item whose implement predates enforcement keeps its
// pre-merge and conflict runs (predates_enforcement); a send-back does not.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-readiness-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-readiness-home-')) // deploy.js derives state dirs from it
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire here

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { IMPLEMENT_STEP_INDEX, DEPLOY_STEP_INDEX, ACCEPT_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const { FARM_QUEUE_TIMEOUT_MS } = await import('../src/config.js')
const orchestrator = await import('../src/orchestrator.js')
const premerge = await import('../src/premerge.js')
const caretaker = await import('../src/caretaker.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()
const app = buildApp({ logger: false })
const alice = loginFixtureUser(auth, config, { email: 'alice@example.com', name: 'Alice Example' })
await app.ready()
after(() => app.close())

const projectId = db.prepare("INSERT INTO project (name, enabled) VALUES ('Readiness', 1)").run().lastInsertRowid
const connect = (repo, prefix) => db.prepare('INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, ?, ?)').run(projectId, repo, prefix)
connect('acme/bare', 'AB') // no commands, no marks, no target
connect('acme/nochecks', 'AN')
connect('acme/both', 'AT') // commands AND 'no checks'
connect('acme/nodeploy', 'AD')
connect('acme/old', 'AO') // was connected before enforcement
store.setRepoMarks(projectId, 'acme/nochecks', { noChecks: true })
store.setRepoCheckCommands(projectId, 'acme/both', { test: 'npm test' })
store.setRepoMarks(projectId, 'acme/both', { noChecks: true })
store.setRepoMarks(projectId, 'acme/nodeploy', { noDeploy: true })
db.prepare("UPDATE project_repo SET enforced_since = '2026-10-04 12:00:00' WHERE repo = 'acme/old'").run()

const insertItem = db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, issue, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
const runsOf = (id) => db.prepare('SELECT step_index, status, output FROM step_run WHERE item_id = ? ORDER BY id').all(id)

// Every outbound call, GitHub and farm alike. GitHub answers a release.
const calls = []
globalThis.fetch = async (url, opts) => {
  const u = String(url)
  calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null })
  if (u.includes('api.github.com') && u.includes('/releases/tags/')) return { ok: false, status: 404, json: async () => ({}) }
  if (u.includes('api.github.com') && u.endsWith('/releases') && opts?.method === 'POST') {
    const body = JSON.parse(opts.body)
    return { ok: true, status: 201, json: async () => ({ tag_name: body.tag_name, html_url: `https://github.com/x/releases/${body.tag_name}` }) }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}
const callsFor = (id, since = 0) => calls.slice(since).filter((c) => c.body?.item?.id === id || c.url.includes('api.github.com'))
const stepRunFor = (id) => calls.find((c) => c.url.includes('/steps/run') && c.body?.item?.id === id)?.body

async function settle(id) {
  for (let i = 0; i < 50 && !stepRunFor(id); i++) await new Promise((r) => setTimeout(r, 10))
  return stepRunFor(id)
}

// kick() with every timer the dispatch arms recorded. The dispatch's failure
// path runs synchronously inside kick(), so "failed before dispatch resolves"
// is "failed when kick() returns".
function kickRecordingTimers(id) {
  const armed = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const handle = realSetTimeout(fn, ms, ...rest)
    armed.push({ ms, handle })
    return handle
  }
  try {
    orchestrator.kick(id)
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  return armed
}

// ---- metric 3: implement ----

test('an implement on a repo with no check commands fails by name at dispatch; the farm is never called', async () => {
  insertItem.run('RD-1', 'Unconfigured implement', 'Medium', IMPLEMENT_STEP_INDEX, 'acme/bare', 1, projectId)
  const since = calls.length
  kickRecordingTimers('RD-1')
  assert.deepEqual(runsOf('RD-1'), [
    { step_index: IMPLEMENT_STEP_INDEX, status: 'cancelled', output: 'FAILED: no check commands configured for acme/bare' },
  ])
  assert.equal(Boolean(store.getItem('RD-1').paused), true)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(stepRunFor('RD-1'), undefined, 'no /steps/run for an unready repo')
  assert.deepEqual(
    calls.slice(since).filter((c) => !c.url.endsWith('/steps/cancel')).map((c) => c.url),
    [],
    'nothing but the farm-side cancel every failed run sends',
  )
})

test("a repo marked 'no checks' dispatches implement with checks_waiver no_checks and no check_commands", async () => {
  insertItem.run('RD-2', 'Marked implement', 'Medium', IMPLEMENT_STEP_INDEX, 'acme/nochecks', 2, projectId)
  orchestrator.kick('RD-2')
  const body = await settle('RD-2')
  orchestrator.cancel('RD-2')
  assert.equal(body.checks_waiver, store.CHECKS_WAIVER.NO_CHECKS)
  assert.equal(Object.hasOwn(body, 'check_commands'), false)
})

test("configured commands beat the 'no checks' mark: no waiver, and the commands ride with the task", async () => {
  const item = { id: 'RD-3', repo: 'acme/both' }
  assert.equal(orchestrator.checksWaiverFor(item), null)
  assert.equal(orchestrator.readinessFailure(item, IMPLEMENT_STEP_INDEX), null)
  insertItem.run('RD-3', 'Both', 'Medium', IMPLEMENT_STEP_INDEX, 'acme/both', 3, projectId)
  orchestrator.kick('RD-3')
  const body = await settle('RD-3')
  orchestrator.cancel('RD-3')
  assert.deepEqual(body.check_commands, { install: null, test: 'npm test', lint: null, e2e: null })
  assert.equal(Object.hasOwn(body, 'checks_waiver'), false)
})

// ---- metric 4: deploy ----

test('a deploy with no target and no mark fails in the same call: no timer, no release, no farm call, no retry', async () => {
  insertItem.run('RD-4', 'Unready deploy', 'Medium', DEPLOY_STEP_INDEX, 'acme/bare', 4, projectId)
  const since = calls.length
  const armed = kickRecordingTimers('RD-4')
  assert.deepEqual(runsOf('RD-4'), [
    { step_index: DEPLOY_STEP_INDEX, status: 'cancelled', output: 'FAILED: no deploy target configured for acme/bare' },
  ])
  assert.deepEqual(armed.filter((t) => t.ms === FARM_QUEUE_TIMEOUT_MS), [], 'the queue watchdog was never armed')
  assert.ok(armed.every((t) => t.ms < 60_000), `no long timer is left pending: ${JSON.stringify(armed.map((t) => t.ms))}`)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(runsOf('RD-4').length, 1, 'not auto-retried')
  assert.equal(Boolean(store.getItem('RD-4').paused), true)
  assert.equal(store.getItem('RD-4').release_tag, null)
  assert.deepEqual(callsFor('RD-4', since).filter((c) => !c.url.endsWith('/steps/cancel')), [], 'no GitHub release, no /steps/run')

  // What the owner sees: the item's run carries the named reason.
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: alice.cookie } })
  const card = res.json().items.find((i) => i.id === 'RD-4')
  assert.equal(card.paused, true)
  assert.ok(
    card.events.some((e) => e.text === 'agent step failed: no deploy target configured for acme/bare — item paused; resume to retry'),
    JSON.stringify(card.events.map((e) => e.text)),
  )
})

test('a deploy on a repo item with no issue is still held to a target', () => {
  insertItem.run('RD-5', 'No issue', 'Medium', DEPLOY_STEP_INDEX, 'acme/bare', null, projectId)
  orchestrator.kick('RD-5')
  assert.deepEqual(runsOf('RD-5').map((r) => r.output), ['FAILED: no deploy target configured for acme/bare'])
})

// ---- HZ-358: a 'no deploy' repo with no target ships nothing ----

const NOT_DEPLOYED = 'not deployed: acme/nodeploy is marked no deploy'
const releasePosts = (since) => calls.slice(since).filter((c) => c.url.includes('api.github.com') && c.url.endsWith('/releases'))
const farmRuns = (id, since) => calls.slice(since).filter((c) => c.url.includes('/steps/run') && c.body?.item?.id === id)
const stepRuns14 = (id) => runsOf(id).filter((r) => r.step_index === DEPLOY_STEP_INDEX)

test("a repo marked 'no deploy' with no target publishes no release and completes step 14 as not deployed", async () => {
  insertItem.run('RD-6', 'Marked deploy', 'Medium', DEPLOY_STEP_INDEX, 'acme/nodeploy', 6, projectId)
  const since = calls.length
  const armed = kickRecordingTimers('RD-6')
  await new Promise((r) => setTimeout(r, 30))

  assert.deepEqual(stepRuns14('RD-6'), [{ step_index: DEPLOY_STEP_INDEX, status: 'done', output: NOT_DEPLOYED }])
  assert.deepEqual(releasePosts(since), [], 'no GitHub release published')
  assert.deepEqual(farmRuns('RD-6', since), [], 'no /steps/run')
  assert.deepEqual(armed.filter((t) => t.ms === FARM_QUEUE_TIMEOUT_MS), [], 'the queue watchdog was never armed')
  const it = store.getItem('RD-6')
  assert.equal(it.cursor, DEPLOY_STEP_INDEX + 1)
  assert.equal(Boolean(it.paused), false)

  // A second kick adds no run: the item sits at gate 15.
  orchestrator.kick('RD-6')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(stepRuns14('RD-6').length, 1)

  // What the board renders after a reload.
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: alice.cookie } })
  const card = res.json().items.find((i) => i.id === 'RD-6')
  assert.equal(card.release_tag, null)
  assert.equal(card.release_url, null)
  assert.equal(card.cursor, DEPLOY_STEP_INDEX + 1)
  assert.equal(card.paused, false)
  const artifact = card.stepOutputs[DEPLOY_STEP_INDEX].artifact
  assert.match(artifact, /nothing was deployed/)
  assert.doesNotMatch(artifact, /live/i)
  assert.doesNotMatch(artifact, /deploy-/)
  assert.ok(
    card.events.some((e) => e.text.includes(NOT_DEPLOYED)),
    JSON.stringify(card.events.map((e) => e.text)),
  )
})

test('the MDI-38 shape — paused at step 14 with a cancelled run and a stale tag — resumes to gate 15 with no release', async () => {
  insertItem.run('RD-11', 'Stuck no-deploy', 'Medium', DEPLOY_STEP_INDEX, 'acme/nodeploy', 8, projectId)
  db.prepare("UPDATE work_item SET paused = 1, release_tag = 'deploy-rd-11', release_url = 'https://github.com/x/releases/deploy-rd-11' WHERE id = 'RD-11'").run()
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output) VALUES ('RD-11', ?, 1, 'devops', 'cancelled', ?)").run(
    DEPLOY_STEP_INDEX,
    'FAILED: release deploy-rd-11 cannot be verified: no deploy target',
  )
  const since = calls.length
  // The runner server.js registers via orchestrator.init(), so Resume kicks.
  store.registerAgentRunner({ kick: orchestrator.kick, cancel: orchestrator.cancel })
  let res
  try {
    res = await app.inject({
      method: 'POST',
      url: '/api/items/RD-11/pause',
      headers: { cookie: alice.cookie },
      payload: { paused: false },
    })
  } finally {
    store.registerAgentRunner({ kick() {}, cancel() {}, pause() {} })
  }
  assert.equal(res.statusCode, 200, res.body)
  await new Promise((r) => setTimeout(r, 30))

  assert.deepEqual(releasePosts(since), [], 'no GitHub release published')
  assert.deepEqual(farmRuns('RD-11', since), [], 'no /steps/run')
  assert.deepEqual(stepRuns14('RD-11').map((r) => r.status), ['cancelled', 'done'])
  const it = store.getItem('RD-11')
  assert.equal(it.release_tag, null)
  assert.equal(it.release_url, null)
  assert.equal(it.cursor, DEPLOY_STEP_INDEX + 1)
})

test('a repo with a deploy target needs no mark', () => {
  assert.equal(orchestrator.readinessFailure({ id: 'X', repo: 'FinTekkers/horizon' }, DEPLOY_STEP_INDEX), null)
  assert.equal(orchestrator.readinessFailure({ id: 'X', repo: null }, DEPLOY_STEP_INDEX), null, 'a demo item is never judged')
})

test("the mock 'Deploy the changes' path refuses an unready repo by name before any GitHub call", async () => {
  const since = calls.length
  const result = await orchestrator.MOCK_STEP_BEHAVIOR['Deploy the changes']({ id: 'RD-7', repo: 'acme/bare', issue: 7 })
  assert.deepEqual(result, { failure: 'no deploy target configured for acme/bare' })
  assert.deepEqual(calls.slice(since), [])
})

test("a repo with a deploy target still publishes and waits at step 14 even when marked 'no deploy' — the target wins", async () => {
  connect('FinTekkers/horizon', 'HZ')
  store.setRepoMarks(projectId, 'FinTekkers/horizon', { noDeploy: true })
  insertItem.run('RD-12', 'Marked with target', 'Medium', DEPLOY_STEP_INDEX, 'FinTekkers/horizon', 9, projectId)
  const since = calls.length
  orchestrator.kick('RD-12')
  const body = await settle('RD-12')
  orchestrator.cancel('RD-12')
  assert.equal(releasePosts(since).length, 1, 'a GitHub release was published')
  assert.equal(body.item.release_tag, 'deploy-rd-12')
  assert.ok(body.deploy_wait, 'the farm is told to wait for the release to go live')
  assert.ok(runsOf('RD-12').every((r) => !String(r.output ?? '').includes('not deployed')))

  // At gate 15 the caretaker sees a deploy, not "not deployed".
  const it = { ...store.getItem('RD-12'), cursor: DEPLOY_STEP_INDEX + 1 }
  assert.equal(caretaker.gatherFacts(it, DEPLOY_STEP_INDEX + 1, null).notDeployed, null)
  assert.equal(caretaker.gatherFacts({ ...it, release_tag: null }, DEPLOY_STEP_INDEX + 1, null).notDeployed, null)
})

test("the mock 'Deploy the changes' path skips a no-deploy repo the same way and clears a stale tag", async () => {
  insertItem.run('RD-13', 'Mock no-deploy', 'Medium', DEPLOY_STEP_INDEX, 'acme/nodeploy', 10, projectId)
  db.prepare("UPDATE work_item SET release_tag = 'deploy-rd-13', release_url = 'u' WHERE id = 'RD-13'").run()
  const since = calls.length
  const result = await orchestrator.MOCK_STEP_BEHAVIOR['Deploy the changes'](store.getItem('RD-13'))
  assert.deepEqual(result, { summary: NOT_DEPLOYED })
  assert.deepEqual(calls.slice(since), [])
  assert.equal(store.getItem('RD-13').release_tag, null)
  assert.equal(store.getItem('RD-13').release_url, null)
})

// ---- guardrail 6: flagged, not blocked; a send-back is enforced ----

test('an item whose implement predates enforcement pre-merges with predates_enforcement; its send-back implement fails by name', async () => {
  insertItem.run('RD-8', 'In flight', 'Medium', ACCEPT_GATE_INDEX, 'acme/old', 8, projectId)
  db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, started_at) VALUES ('RD-8', ?, 'eng', 'done', '2026-10-03 09:00:00')").run(
    IMPLEMENT_STEP_INDEX,
  )
  const item = store.getItem('RD-8')
  assert.equal(orchestrator.checksWaiverFor(item), store.CHECKS_WAIVER.PREDATES_ENFORCEMENT)

  // The pre-merge run is handed the waiver on its command line.
  const realSpawn = premerge.runner.spawn
  let args = null
  premerge.runner.spawn = async (a) => {
    args = a
    return { code: 1, stdout: JSON.stringify({ ok: false, reason: 'crash' }) + '\n', stderr: '' }
  }
  try {
    await premerge.runPreMergeChecks(item, {
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      timeoutMs: 60_000,
      checksWaiver: orchestrator.checksWaiverFor(item),
    })
  } finally {
    premerge.runner.spawn = realSpawn
  }
  assert.deepEqual(args.slice(args.indexOf('--checks-waiver'), args.indexOf('--checks-waiver') + 2), ['--checks-waiver', 'predates_enforcement'])
  assert.equal(args.includes('--check-commands'), false)

  // Sent back to implement: a new implement is enforced.
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(IMPLEMENT_STEP_INDEX, 'RD-8')
  orchestrator.kick('RD-8')
  assert.equal(runsOf('RD-8').at(-1).output, 'FAILED: no check commands configured for acme/old')
})

test('an item whose first implement started after enforcement gets no waiver', () => {
  insertItem.run('RD-9', 'New', 'Medium', ACCEPT_GATE_INDEX, 'acme/old', 9, projectId)
  db.prepare("INSERT INTO step_run (item_id, step_index, agent, status, started_at) VALUES ('RD-9', ?, 'eng', 'done', '2026-10-04 13:00:00')").run(
    IMPLEMENT_STEP_INDEX,
  )
  assert.equal(orchestrator.checksWaiverFor(store.getItem('RD-9')), null)
  assert.equal(orchestrator.checksWaiverFor({ id: 'RD-9', repo: 'acme/bare' }), null, 'a repo connected after enforcement has none')
})

// ---- the waiver strings are one contract across Node and Python ----

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function argparseChoices(module) {
  try {
    execFileSync('python3', ['-m', module, 'o/r', 'X-1', 'a'.repeat(40), '--base', 'b'.repeat(40), '--checks-waiver', 'bogus'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    })
  } catch (err) {
    const match = /invalid choice: 'bogus' \(choose from (.+)\)/.exec(String(err.stderr))
    assert.ok(match, String(err.stderr))
    return match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  }
  assert.fail(`${module} accepted a bogus waiver`)
}

test("the server's waiver strings are exactly farm/premerge.py's and farm/validate.py's --checks-waiver choices", () => {
  const server = Object.values(store.CHECKS_WAIVER).sort()
  assert.deepEqual(argparseChoices('farm.premerge').sort(), server)
  assert.deepEqual(argparseChoices('farm.validate').sort(), server)
})

// ---- metric 3: no code path passes silently ----

function productionFiles(dir, ext, skip) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!skip.includes(entry.name)) out.push(...productionFiles(path, ext, skip))
    } else if (entry.name.endsWith(ext)) out.push(path)
  }
  return out
}

test("no production code in farm/ or server/src/ carries the old silent pass, 'no repo checks detected'", () => {
  const files = [
    ...productionFiles(join(REPO_ROOT, 'farm'), '.py', ['tests', '__pycache__', 'node_modules']),
    ...productionFiles(join(REPO_ROOT, 'server', 'src'), '.js', []),
  ]
  assert.ok(files.length > 20, 'the scan found the code it is meant to scan')
  const hits = files.filter((f) => readFileSync(f, 'utf8').includes('no repo checks detected'))
  assert.deepEqual(hits, [])
})
