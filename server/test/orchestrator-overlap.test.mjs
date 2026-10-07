// HZ-236: step 9's overlap check, wired through the real orchestrator. The
// farm is a captured fetch stub (same harness as
// orchestrator-project-context.test.mjs); no test calls a live model. Each
// test uses its own repo, so the in-flight peers of one never leak into another.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

const SENTINEL_TOKEN = 'ghp_SENTINEL_hz236_never_printed'
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-overlap-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.GITHUB_TOKEN = SENTINEL_TOKEN
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { STEPS, IMPLEMENT_STEP_INDEX, requiredStepIndex } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')
const overlapService = await import('../src/overlapService.js')
const { contractText } = await import('../src/overlap.js')
const github = await import('../src/github.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')

store.purgeDemoItems()
const { connectReadyRepo } = await import('./helpers/readyRepo.mjs')

const PLAN = requiredStepIndex('Draft implementation plan')
const SUMMARIZE = requiredStepIndex('Summarize reviews & recommend')
const REVIEW_GATE = requiredStepIndex('Review before execution')
const ACCEPT_GATE = requiredStepIndex('Accept the code')

// Every outbound call: farm calls and GitHub calls alike.
const calls = []
globalThis.fetch = async (url, opts) => {
  const u = String(url)
  calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null, headers: opts?.headers || {} })
  if (u.startsWith('https://api.github.com/')) return { ok: false, status: 500, json: async () => ({ message: 'boom' }) }
  return { ok: true, json: async () => ({}) }
}
orchestrator.init({ info: () => {}, warn: () => {} })

const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)

after(() => {
  for (const { item_id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(item_id)
})

const tick = () => new Promise((r) => setTimeout(r, 20))
const insertItem = db.prepare(
  `INSERT INTO work_item (id, title, priority, cursor, repo, project_id, pr) VALUES (?, ?, 'Medium', ?, ?, ?, ?)`,
)
function item(id, { cursor, repo, project = null, pr = null, plan = null }) {
  insertItem.run(id, `Title ${id}`, cursor, repo, project, pr)
  if (plan) {
    db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact) VALUES (?, ?, 1, 'Eng', 'done', ?)").run(
      id,
      PLAN,
      plan,
    )
  }
}

const planFor = (file, ...fns) => `## Changes\n**1. \`${file}\` — EDIT.**\n${fns.map((f) => `- \`${f}\` changes.`).join('\n')}\n`
const DIGEST = '## Recommendation\n**PROCEED** — fine.\n## Test contract\n- **Kept:** x\n## What\'s being built\n- y\n## Reviewer findings\n- none\n## Actions\nNone.\n'

function stepRunDispatch(id) {
  return calls.filter((c) => c.url.endsWith('/steps/run') && c.body?.item?.id === id).at(-1)
}

// Dispatches step 9 for `id` and returns { runId, body }.
async function startSummarize(id) {
  orchestrator.kick(id)
  await tick()
  const run = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, SUMMARIZE)
  assert.ok(run, `no active step-9 run for ${id}`)
  const dispatch = stepRunDispatch(id)
  assert.ok(dispatch, `no /steps/run dispatch for ${id}`)
  return { runId: run.id, body: dispatch.body }
}

async function runSummarize(id, digest = DIGEST) {
  const { runId, body } = await startSummarize(id)
  const res = await orchestrator.completeFarmRun(runId, { summary: 'recommend', artifacts: { artifact_md: digest } })
  assert.deepEqual(res, { ok: true })
  return { runId, body }
}

// A peer with a live, running step: kicked onto the farm and left there.
async function startRunning(id) {
  orchestrator.kick(id)
  await tick()
  assert.ok(db.prepare("SELECT 1 FROM step_run WHERE item_id = ? AND status = 'active'").get(id), `${id} is not running`)
}

async function cardOf(id) {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  return res.json().items.find((i) => i.id === id)
}

// Metric 6: what step 9 must leave untouched on another item. dependents,
// events and last_activity_at are excluded — gaining a dependent is expected.
async function peerState(ids) {
  const items = (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })).json().items
  const runnableOrder = items.filter((i) => ids.includes(i.id) && !i.blocked && !i.paused && i.currentStep.kind === 'agent').map((i) => i.id)
  return {
    runnableOrder,
    items: ids.map((id) => {
      const it = store.getItem(id)
      const run = db.prepare("SELECT id, status, step_index FROM step_run WHERE item_id = ? AND status = 'active'").get(id) || null
      return { id, cursor: it.cursor, paused: it.paused, rejected: it.rejected, run }
    }),
  }
}

function farmCallsFor(ids, since) {
  const runIds = new Set(db.prepare(`SELECT id FROM step_run WHERE item_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.id))
  return calls
    .slice(since)
    .filter((c) => (c.url.endsWith('/steps/run') && ids.includes(c.body?.item?.id)) || (c.url.endsWith('/steps/cancel') && runIds.has(c.body?.run_id)))
}

const edges = (id) => db.prepare('SELECT depends_on_id FROM work_item_dependency WHERE item_id = ?').all(id).map((r) => r.depends_on_id)
const feedbackOf = (id) => db.prepare('SELECT message, source, delivered_at FROM feedback WHERE item_id = ? ORDER BY id').all(id)
const latestDigest = (id) => store.latestArtifact(id, SUMMARIZE)
const schema = () => db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()

test('metric 1: the step-9 input names every same-repo, same-project peer at steps 6-13 and its files', async () => {
  const repo = 'm1/repo'
  item('M1-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('M1-PLAN', { cursor: PLAN + 1, repo, plan: planFor('server/src/store.js', 'listItems()') })
  item('M1-PR', { cursor: IMPLEMENT_STEP_INDEX, repo, pr: 41 })
  item('M1-GATE13', { cursor: ACCEPT_GATE, repo, plan: planFor('ui/src/App.jsx') })
  item('M1-C6', { cursor: PLAN, repo })
  item('M1-C4', { cursor: 4, repo, plan: planFor('server/src/c4.js') })
  item('M1-C5', { cursor: 5, repo, plan: planFor('server/src/c5.js') })
  item('M1-C14', { cursor: ACCEPT_GATE + 1, repo, plan: planFor('server/src/c14.js') })
  item('M1-OTHERREPO', { cursor: PLAN + 2, repo: 'other/repo', plan: planFor('server/src/otherrepo.js') })
  item('M1-OTHERPROJ', { cursor: PLAN + 2, repo, project: 7, plan: planFor('server/src/otherproj.js') })
  github.setPrFilesForTest({ 'm1/repo#41': [{ filename: 'farm/farmd.py', patch: '@@ -10,6 +10,8 @@ def claim_task(self):\n+    pass' }] })

  const { body } = await startSummarize('M1-SELF')
  orchestrator.cancel('M1-SELF')
  github.setPrFilesForTest(null)

  const input = body.artifacts.find((a) => a.label === 'Overlap check (deterministic)')
  assert.ok(input, 'step 9 carries the deterministic overlap artifact')
  assert.equal(body.artifacts.at(-1), input)
  const text = input.content
  for (const [id, file] of [['M1-PLAN', 'server/src/store.js'], ['M1-PR', 'farm/farmd.py'], ['M1-GATE13', 'ui/src/App.jsx']]) {
    assert.ok(text.includes(`**${id}**`), `${id} is named`)
    assert.ok(text.includes(`\`${file}\``), `${id}'s file ${file} is listed`)
  }
  assert.ok(text.includes('`claim_task()`'), 'the PR diff supplies real function names')
  assert.match(text, /\*\*M1-C6\*\*[^\n]*\n {2}- Computed decision: \*\*not checked\*\* — no step-6 plan and no PR/)
  for (const absent of ['M1-C4', 'M1-C5', 'M1-C14', 'M1-OTHERREPO', 'M1-OTHERPROJ', 'otherproj.js', 'otherrepo.js', 'c14.js']) {
    assert.ok(!text.includes(absent), `${absent} is out of scope`)
  }
})

test('metric 3a + 6: depends-on adds the edge, shows on the card, completes step 9 and leaves the peer alone', async () => {
  const repo = 'dep/repo'
  connectReadyRepo(db, repo) // HZ-304: the peer's implement dispatch needs check commands
  item('DEP-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('DEP-PEER', { cursor: IMPLEMENT_STEP_INDEX, repo, plan: planFor('server/src/app.js', 'snapshot()', 'other()') })
  await startRunning('DEP-PEER')
  const before = await peerState(['DEP-PEER'])
  const schemaBefore = schema()
  const since = calls.length

  const { runId } = await runSummarize('DEP-SELF')

  assert.deepEqual(edges('DEP-SELF'), ['DEP-PEER'])
  assert.deepEqual(edges('DEP-PEER'), [])
  const run = db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId)
  assert.equal(run.status, 'done', 'a blocked self still completes step 9')
  assert.equal(store.getItem('DEP-SELF').cursor, REVIEW_GATE)
  await orchestrator.reconcileActiveRuns()
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status, 'done')

  const card = await cardOf('DEP-SELF')
  assert.equal(card.blocked, true)
  assert.equal(card.blockedBy[0].id, 'DEP-PEER')
  const gateDigest = card.stepOutputs[SUMMARIZE].artifact
  assert.ok(gateDigest.includes('- **DEP-PEER** — decision: **depends-on**'))
  assert.ok(gateDigest.includes('Effect: added dependency DEP-SELF → DEP-PEER; blocked until DEP-PEER closes'))
  assert.deepEqual(feedbackOf('DEP-SELF'), [])
  assert.deepEqual(feedbackOf('DEP-PEER'), [])

  assert.deepEqual(await peerState(['DEP-PEER']), before)
  assert.deepEqual(farmCallsFor(['DEP-PEER'], since), [], 'no dispatch or cancel reached the peer')
  assert.deepEqual(schema(), schemaBefore, 'guardrail 3: no new table or column')
})

test('metric 3b + 6: shared-contract queues the same text on both items and the peer gets it on its next dispatch', async () => {
  const repo = 'sc/repo'
  connectReadyRepo(db, repo) // HZ-304: the peer's implement dispatch needs check commands
  item('SC-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/store.js', 'addThing()') })
  item('SC-PEER', { cursor: IMPLEMENT_STEP_INDEX, repo, plan: planFor('server/src/store.js', 'removeThing()') })
  await startRunning('SC-PEER')
  const before = await peerState(['SC-PEER'])
  const since = calls.length

  await runSummarize('SC-SELF')

  const contract = contractText('SC-SELF', 'SC-PEER', ['server/src/store.js'])
  for (const id of ['SC-SELF', 'SC-PEER']) assert.deepEqual(feedbackOf(id), [{ message: contract, source: 'overlap', delivered_at: null }])
  assert.deepEqual(edges('SC-SELF'), [])
  const gateDigest = (await cardOf('SC-SELF')).stepOutputs[SUMMARIZE].artifact
  assert.ok(gateDigest.includes(`  - Contract: ${contract}`))
  assert.ok(gateDigest.includes('Effect: contract queued as feedback on SC-PEER and SC-SELF'))

  assert.deepEqual(await peerState(['SC-PEER']), before)
  assert.deepEqual(farmCallsFor(['SC-PEER'], since), [])

  // The peer's running step finishes elsewhere; its next dispatch carries the contract.
  orchestrator.cancel('SC-PEER')
  orchestrator.kick('SC-PEER')
  await tick()
  assert.ok(stepRunDispatch('SC-PEER').body.feedback.some((f) => f.message === contract))
  assert.notEqual(feedbackOf('SC-PEER')[0].delivered_at, null)
})

test('metric 5 + 6: disjoint plans decide none — no dependency, no feedback', async () => {
  const repo = 'none/repo'
  connectReadyRepo(db, repo) // HZ-304: the peer's implement dispatch needs check commands
  item('NO-SELF', { cursor: SUMMARIZE, repo, plan: planFor('ui/src/App.jsx', 'renderBoard()') })
  item('NO-PEER', { cursor: IMPLEMENT_STEP_INDEX, repo, plan: planFor('farm/farmd.py', 'claim_task()') })
  await startRunning('NO-PEER')
  const before = await peerState(['NO-PEER'])
  const since = calls.length

  await runSummarize('NO-SELF')

  assert.ok(latestDigest('NO-SELF').includes('- **NO-PEER** — decision: **none**'))
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_item_dependency WHERE item_id IN ('NO-SELF','NO-PEER') OR depends_on_id IN ('NO-SELF','NO-PEER')").get().n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE item_id IN ('NO-SELF','NO-PEER')").get().n, 0)
  assert.deepEqual(await peerState(['NO-PEER']), before)
  assert.deepEqual(farmCallsFor(['NO-PEER'], since), [])
})

test('guardrail 5: a model Overlap that says none for a computed depends-on is replaced', async () => {
  const repo = 'down/repo'
  item('DN-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('DN-PEER', { cursor: PLAN, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  await runSummarize('DN-SELF', `${DIGEST}## Overlap\n- **DN-PEER** — decision: **none**\n`)
  const digest = latestDigest('DN-SELF')
  assert.equal(digest.match(/## Overlap/g).length, 1)
  assert.ok(digest.includes('- **DN-PEER** — decision: **depends-on**'))
  assert.ok(!digest.includes('decision: **none**'))
})

test('guardrail 8: an existing reverse edge turns depends-on into shared-contract with a Why line', async () => {
  const repo = 'cyc/repo'
  item('CY-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('CY-PEER', { cursor: PLAN, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  assert.ok(store.addDependency('CY-PEER', 'CY-SELF').ok)

  await runSummarize('CY-SELF')

  assert.deepEqual(edges('CY-SELF'), [])
  const digest = latestDigest('CY-SELF')
  assert.ok(digest.includes('- **CY-PEER** — decision: **shared-contract**'))
  assert.match(digest, /- Why: a dependency CY-SELF → CY-PEER would close a cycle — CY-PEER already depends on CY-SELF/)
  assert.ok(digest.includes('Effect: contract queued as feedback on CY-PEER and CY-SELF'))
  assert.equal(feedbackOf('CY-PEER').length, 1)
})

test('guardrail 7: applying from A, then B, then A leaves one edge and one feedback row per item', async () => {
  const repo = 'idem/repo'
  item('ID-A', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('ID-B', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  const apply = async (id) => overlapService.applyOverlap(id, await overlapService.computeOverlap(id)).results[0]

  const first = await apply('ID-A')
  assert.equal(first.effect, 'added dependency ID-A → ID-B; blocked until ID-B closes (shown on the card)')
  const fromB = await apply('ID-B')
  assert.equal(fromB.decision, 'shared-contract')
  assert.ok(fromB.why.includes('cycle'))
  const again = await apply('ID-A')
  assert.ok(again.effect.startsWith('dependency ID-A → ID-B already present'))
  const fromBAgain = await apply('ID-B')
  assert.equal(fromBAgain.effect, 'contract already queued on ID-A and ID-B')

  assert.deepEqual(edges('ID-A'), ['ID-B'])
  assert.deepEqual(edges('ID-B'), [])
  assert.equal(feedbackOf('ID-A').length, 1)
  assert.equal(feedbackOf('ID-B').length, 1)
})

test('guardrail 9: this item with no plan and no PR lists every peer as not checked', async () => {
  const repo = 'noplan/repo'
  item('NP-SELF', { cursor: SUMMARIZE, repo })
  item('NP-PEER', { cursor: PLAN, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  await runSummarize('NP-SELF')
  const digest = latestDigest('NP-SELF')
  assert.match(digest, /- \*\*NP-PEER\*\* — \*\*not checked\*\* — this item has nothing to compare \(no step-6 plan and no PR\)/)
  assert.ok(!digest.includes('decision: **none**'))
})

test('guardrail 9: a computeOverlap that throws still completes step 9, peers not checked', async () => {
  const repo = 'throw/repo'
  item('TH-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('TH-PEER', { cursor: PLAN, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  overlapService.setComputeOverlapForTest(() => {
    throw new Error('boom')
  })
  try {
    const { runId } = await runSummarize('TH-SELF')
    assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status, 'done')
  } finally {
    overlapService.setComputeOverlapForTest(null)
  }
  assert.equal(store.getItem('TH-SELF').cursor, REVIEW_GATE)
  assert.ok(latestDigest('TH-SELF').includes('- **TH-PEER** — **not checked** — the overlap check failed: boom'))
  assert.deepEqual(edges('TH-SELF'), [])
})

test('guardrail 10: a failed PR file read never leaks the token into the reason, digest, prompt or console', async () => {
  const repo = 'gh/repo'
  item('GH-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('GH-PEER', { cursor: IMPLEMENT_STEP_INDEX, repo, pr: 77 })
  const logged = []
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  for (const k of Object.keys(saved)) console[k] = (...args) => logged.push(args.map(String).join(' '))
  let body
  try {
    ;({ body } = await runSummarize('GH-SELF'))
  } finally {
    Object.assign(console, saved)
  }
  const ghCall = calls.find((c) => c.url.includes('/repos/gh/repo/pulls/77/files'))
  assert.ok(ghCall, 'the PR file list was requested from GitHub')
  assert.equal(ghCall.headers.Authorization, `Bearer ${SENTINEL_TOKEN}`, 'the stub really saw the sentinel token')

  const digest = latestDigest('GH-SELF')
  assert.ok(digest.includes("- **GH-PEER** — **not checked** — PR #77's file list is unavailable: could not read PR #77's changed files (GitHub returned 500)"))
  for (const surface of [digest, JSON.stringify(body), logged.join('\n'), JSON.stringify(store.getItem('GH-SELF'))]) {
    assert.ok(!surface.includes(SENTINEL_TOKEN))
  }
})
