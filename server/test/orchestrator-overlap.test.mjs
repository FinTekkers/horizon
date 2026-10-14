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
const { STEPS, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, DEPLOY_STEP_INDEX, requiredStepIndex } = await import('../../domain/js/lifecycle.js')
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
function item(id, { cursor, repo, project = null, pr = null, plan = null, paused = 0, ruleBlock = null }) {
  insertItem.run(id, `Title ${id}`, cursor, repo, project, pr)
  if (paused || ruleBlock) db.prepare('UPDATE work_item SET paused = ?, rule_block_json = ? WHERE id = ?').run(paused, ruleBlock, id)
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
// Runs the overlap check for `id` and applies it, as step 9's completion does.
const applyAll = async (id) => overlapService.applyOverlap(id, await overlapService.computeOverlap(id)).results
const apply = async (id) => (await applyAll(id))[0]
const resultFor = (results, id) => results.find((r) => r.id === id)
const removalRows = (a, b) => db.prepare('SELECT removed_by FROM overlap_link_removal WHERE item_a = ? AND item_b = ?').all(...[a, b].sort())
const removeViaApi = (id, dependsOnId) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/dependencies/remove`, headers: { cookie }, payload: { dependsOnId } })

test('metric 1: the step-9 input names every same-repo, same-project peer at steps 6-14 and its files', async () => {
  const repo = 'm1/repo'
  item('M1-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('M1-PLAN', { cursor: PLAN + 1, repo, plan: planFor('server/src/store.js', 'listItems()') })
  item('M1-PR', { cursor: IMPLEMENT_STEP_INDEX, repo, pr: 41 })
  item('M1-GATE13', { cursor: ACCEPT_GATE, repo, plan: planFor('ui/src/App.jsx') })
  item('M1-C6', { cursor: PLAN, repo })
  item('M1-C4', { cursor: 4, repo, plan: planFor('server/src/c4.js') })
  item('M1-C5', { cursor: 5, repo, plan: planFor('server/src/c5.js') })
  item('M1-C14', { cursor: DEPLOY_STEP_INDEX, repo, plan: planFor('server/src/c14.js') })
  item('M1-C15', { cursor: DEPLOY_STEP_INDEX + 1, repo, plan: planFor('server/src/c15.js') })
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
  for (const [id, file] of [['M1-PLAN', 'server/src/store.js'], ['M1-PR', 'farm/farmd.py'], ['M1-GATE13', 'ui/src/App.jsx'], ['M1-C14', 'server/src/c14.js']]) {
    assert.ok(text.includes(`**${id}**`), `${id} is named`)
    assert.ok(text.includes(`\`${file}\``), `${id}'s file ${file} is listed`)
  }
  assert.ok(text.includes('`claim_task()`'), 'the PR diff supplies real function names')
  assert.match(text, /\*\*M1-C6\*\*[^\n]*\n {2}- Computed decision: \*\*not checked\*\* — no step-6 plan and no PR/)
  for (const absent of ['M1-C4', 'M1-C5', 'M1-C15', 'M1-OTHERREPO', 'M1-OTHERPROJ', 'otherproj.js', 'otherrepo.js', 'c15.js']) {
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
  // HZ-466 guardrail 1: a depends-on overlap queues the contract too.
  const contract = contractText('DEP-SELF', 'DEP-PEER', ['server/src/app.js'])
  for (const id of ['DEP-SELF', 'DEP-PEER']) assert.deepEqual(feedbackOf(id), [{ message: contract, source: 'overlap', delivered_at: null }])

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
  item('DN-PEER', { cursor: IMPLEMENT_STEP_INDEX, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  await runSummarize('DN-SELF', `${DIGEST}## Overlap\n- **DN-PEER** — decision: **none**\n`)
  const digest = latestDigest('DN-SELF')
  assert.equal(digest.match(/## Overlap/g).length, 1)
  assert.ok(digest.includes('- **DN-PEER** — decision: **depends-on**'))
  assert.ok(!digest.includes('decision: **none**'))
})

test('guardrail 8: an existing reverse edge turns depends-on into shared-contract with a Why line', async () => {
  const repo = 'cyc/repo'
  item('CY-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('CY-PEER', { cursor: IMPLEMENT_STEP_INDEX, repo, plan: planFor('server/src/app.js', 'snapshot()') })
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
  item('ID-A', { cursor: IMPLEMENT_STEP_INDEX, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('ID-B', { cursor: IMPLEMENT_STEP_INDEX, repo, plan: planFor('server/src/app.js', 'snapshot()') })

  const first = await apply('ID-A')
  assert.equal(first.effect, 'added dependency ID-A → ID-B; blocked until ID-B closes (shown on the card); contract queued as feedback on ID-A and ID-B')
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

// ── HZ-466: links only to items actually building, only on defined/changed
// functions, and never back onto a pair whose link an owner removed.

test('HZ-466 metric 1: a paused, rule-blocked, planning or gate-10 peer queues a note and adds no edge', async () => {
  const repo = 'hz466-idle/repo'
  item('IDLE-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  const peers = {
    'IDLE-PAUSED': { cursor: IMPLEMENT_STEP_INDEX, paused: 1, state: 'paused' },
    'IDLE-RULE': { cursor: IMPLEMENT_STEP_INDEX, paused: 1, ruleBlock: '{"rule":"r","needs":"n"}', state: 'rule-blocked' },
    'IDLE-PLAN': { cursor: PLAN + 1, state: 'still planning' },
    'IDLE-GATE': { cursor: REVIEW_GATE, state: 'waiting at the Review before execution gate' },
  }
  for (const [id, p] of Object.entries(peers)) item(id, { ...p, repo, plan: planFor('server/src/app.js', 'snapshot()') })

  const results = await applyAll('IDLE-SELF')

  assert.deepEqual(edges('IDLE-SELF'), [])
  for (const [id, p] of Object.entries(peers)) {
    const r = resultFor(results, id)
    assert.equal(r.decision, 'shared-contract', id)
    assert.equal(r.why, `${id} is ${p.state}; links go only to items implementing, in review or merged but not deployed`)
    const contract = contractText('IDLE-SELF', id, ['server/src/app.js'])
    assert.deepEqual(feedbackOf(id).map((f) => f.message), [contract], `${id} got the note`)
    assert.ok(feedbackOf('IDLE-SELF').some((f) => f.message === contract), `IDLE-SELF got the note for ${id}`)
  }
})

test('HZ-466 metric 1: an implementing, in-review, gate-13 or merged-not-deployed peer that changes a shared function is linked', async () => {
  const repo = 'hz466-busy/repo'
  item('BUSY-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  const peers = {
    'BUSY-IMPL': { cursor: IMPLEMENT_STEP_INDEX },
    'BUSY-REVIEW': { cursor: REVIEW_STEP_INDEX },
    'BUSY-GATE13': { cursor: ACCEPT_GATE },
    'BUSY-DEPLOY': { cursor: DEPLOY_STEP_INDEX },
    // A resumed peer with a leftover rule block: read only while paused.
    'BUSY-STALE': { cursor: IMPLEMENT_STEP_INDEX, paused: 0, ruleBlock: '{"rule":"old","needs":"n"}' },
  }
  for (const [id, p] of Object.entries(peers)) item(id, { ...p, repo, plan: planFor('server/src/app.js', 'snapshot()') })

  const results = await applyAll('BUSY-SELF')

  for (const id of Object.keys(peers)) assert.equal(resultFor(results, id).decision, 'depends-on', id)
  assert.deepEqual(edges('BUSY-SELF').sort(), Object.keys(peers).sort())
})

test('HZ-466 metric 2: a linkable peer is read from its PR first — a patch that only calls foo() is a note, one that redefines it links', async () => {
  const repo = 'hz466-pr/repo'
  item('PR-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/a.js', 'foo()') })
  // The plan says it changes foo(); the PR diff is what it really did.
  item('PR-CALLS', { cursor: IMPLEMENT_STEP_INDEX, repo, pr: 5, plan: planFor('server/src/a.js', 'foo()') })
  item('PR-DEFS', { cursor: REVIEW_STEP_INDEX, repo, pr: 6, plan: planFor('server/src/b.js') })
  github.setPrFilesForTest({
    [`${repo}#5`]: [{ filename: 'server/src/a.js', patch: '@@ -1,2 +1,3 @@\n const x = 1\n+  foo()' }],
    [`${repo}#6`]: [{ filename: 'server/src/b.js', patch: '@@ -1,2 +1,3 @@\n+export function foo(scope) {\n+}' }],
  })
  let results
  try {
    results = await applyAll('PR-SELF')
  } finally {
    github.setPrFilesForTest(null)
  }
  const calls = resultFor(results, 'PR-CALLS')
  assert.equal(calls.sourceLabel, 'PR #5 diff')
  assert.equal(calls.decision, 'shared-contract')
  assert.deepEqual(feedbackOf('PR-CALLS').map((f) => f.message), [contractText('PR-SELF', 'PR-CALLS', ['server/src/a.js'])])
  assert.equal(resultFor(results, 'PR-DEFS').decision, 'depends-on')
  assert.deepEqual(edges('PR-SELF'), ['PR-DEFS'])
})

test('HZ-466 metric 2: a PR file read that fails falls back to the peer plan, which links — not "not checked"', async () => {
  const repo = 'hz466-prfail/repo'
  item('PF-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/a.js', 'foo()') })
  item('PF-PEER', { cursor: IMPLEMENT_STEP_INDEX, repo, pr: 9, plan: planFor('server/src/b.js', 'foo()') })
  const results = await applyAll('PF-SELF')
  assert.ok(calls.some((c) => c.url.includes(`/repos/${repo}/pulls/9/files`)), 'the PR was tried first')
  const r = resultFor(results, 'PF-PEER')
  assert.equal(r.sourceLabel, 'step-6 plan')
  assert.equal(r.decision, 'depends-on')
  assert.deepEqual(edges('PF-SELF'), ['PF-PEER'])
})

test('HZ-466 metric 4: an owner removal through the API sticks across a real step-9 replan, and the activity shows it', async () => {
  const repo = 'hz466-rm/repo'
  item('RM-A', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('RM-B', { cursor: IMPLEMENT_STEP_INDEX, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  await runSummarize('RM-A')
  assert.deepEqual(edges('RM-A'), ['RM-B'])

  const res = await removeViaApi('RM-A', 'RM-B')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(removalRows('RM-A', 'RM-B'), [{ removed_by: 'Fixture User' }])

  // The replan: step 9 runs again through the orchestrator.
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(SUMMARIZE, 'RM-A')
  await runSummarize('RM-A')

  assert.deepEqual(edges('RM-A'), [])
  const contract = contractText('RM-A', 'RM-B', ['server/src/app.js'])
  for (const id of ['RM-A', 'RM-B']) assert.deepEqual(feedbackOf(id).map((f) => f.message), [contract])
  const digest = latestDigest('RM-A')
  assert.ok(digest.includes('- **RM-B** — decision: **shared-contract**'))
  assert.match(digest, /- Why: owner Fixture User removed this link on \d{4}-\d\d-\d\d/)
  const texts = (await cardOf('RM-A')).events.map((e) => e.text)
  assert.ok(texts.includes('removed the dependency on RM-B'))
  assert.ok(texts.some((t) => /^did not re-add the overlap dependency on RM-B: Fixture User removed it on \d{4}-/.test(t)))

  // Reverse direction: with RM-A building, step 9 for RM-B adds no RM-B → RM-A edge.
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(IMPLEMENT_STEP_INDEX, 'RM-A')
  const reverse = resultFor(await applyAll('RM-B'), 'RM-A')
  assert.equal(reverse.decision, 'shared-contract')
  assert.match(reverse.why, /^owner Fixture User removed this link on /)
  assert.deepEqual(edges('RM-B'), [])
  assert.equal(reverse.effect, 'contract already queued on RM-A and RM-B')
})

test('HZ-466 guardrail 1: every overlap, linked or not, queues exactly one contract on both items', async () => {
  const repo = 'hz466-notes/repo'
  const selfPlan = '**1. `server/src/app.js` — EDIT.**\n- `snapshot()` changes.\n- `render()` changes.\n'
  item('NT-SELF', { cursor: SUMMARIZE, repo, plan: selfPlan })
  const appPlan = planFor('server/src/app.js', 'snapshot()')
  item('NT-PAUSED', { cursor: IMPLEMENT_STEP_INDEX, paused: 1, repo, plan: appPlan })
  item('NT-PLAN', { cursor: PLAN, repo, plan: appPlan })
  item('NT-GATE', { cursor: REVIEW_GATE, repo, plan: appPlan })
  item('NT-CALLS', { cursor: IMPLEMENT_STEP_INDEX, repo, plan: '**1. `server/src/view.js` — EDIT.**\n- It uses `snapshot()` to read items.\n' })
  item('NT-GENERIC', { cursor: IMPLEMENT_STEP_INDEX, repo, plan: planFor('ui/src/View.jsx', 'render()') })
  item('NT-REMOVED', { cursor: IMPLEMENT_STEP_INDEX, repo, plan: appPlan })
  item('NT-LINK', { cursor: IMPLEMENT_STEP_INDEX, repo, plan: appPlan })
  assert.ok(store.addDependency('NT-SELF', 'NT-REMOVED', 'Horizon').ok)
  assert.equal((await removeViaApi('NT-SELF', 'NT-REMOVED')).statusCode, 200)

  const results = await applyAll('NT-SELF')

  const expected = {
    'NT-PAUSED': ['shared-contract', ['server/src/app.js'], ['snapshot()']],
    'NT-PLAN': ['shared-contract', ['server/src/app.js'], ['snapshot()']],
    'NT-GATE': ['shared-contract', ['server/src/app.js'], ['snapshot()']],
    'NT-CALLS': ['shared-contract', [], ['snapshot()']],
    'NT-GENERIC': ['shared-contract', [], ['render()']],
    'NT-REMOVED': ['shared-contract', ['server/src/app.js'], ['snapshot()']],
    'NT-LINK': ['depends-on', ['server/src/app.js'], ['snapshot()']],
  }
  const selfNotes = feedbackOf('NT-SELF').map((f) => f.message)
  for (const [id, [decision, files, symbols]] of Object.entries(expected)) {
    assert.equal(resultFor(results, id).decision, decision, id)
    const contract = contractText('NT-SELF', id, files, symbols)
    assert.deepEqual(feedbackOf(id).map((f) => f.message), [contract], `${id}: one note`)
    assert.equal(selfNotes.filter((m) => m === contract).length, 1, `NT-SELF: one note for ${id}`)
  }
  assert.equal(selfNotes.length, Object.keys(expected).length)
  assert.deepEqual(edges('NT-SELF'), ['NT-LINK'])
})

test('HZ-466 guardrail 2: owner-added edges are never recorded as removals and never touched by the check', async () => {
  const repo = 'hz466-owner/repo'
  item('OW-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('OW-PAUSED', { cursor: IMPLEMENT_STEP_INDEX, paused: 1, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('OW-BUSY', { cursor: IMPLEMENT_STEP_INDEX, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('OW-GONE', { cursor: IMPLEMENT_STEP_INDEX, repo: 'hz466-owner/other' })
  for (const id of ['OW-PAUSED', 'OW-BUSY', 'OW-GONE']) assert.ok(store.addDependency('OW-SELF', id).ok)

  assert.equal((await removeViaApi('OW-SELF', 'OW-GONE')).statusCode, 200)
  assert.deepEqual(removalRows('OW-SELF', 'OW-GONE'), [], 'an owner-added edge leaves no removal record')

  const results = await applyAll('OW-SELF')
  assert.equal(resultFor(results, 'OW-PAUSED').decision, 'shared-contract')
  assert.ok(resultFor(results, 'OW-BUSY').effect.startsWith('dependency OW-SELF → OW-BUSY already present'))
  const rows = db.prepare('SELECT depends_on_id, created_by FROM work_item_dependency WHERE item_id = ? ORDER BY depends_on_id').all('OW-SELF')
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { depends_on_id: 'OW-BUSY', created_by: 'You' },
    { depends_on_id: 'OW-PAUSED', created_by: 'You' },
  ])
})

test('HZ-466 guardrail 3: a model Overlap that says depends-on for a paused peer cannot add the edge', async () => {
  const repo = 'hz466-model/repo'
  item('MD-SELF', { cursor: SUMMARIZE, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  item('MD-PEER', { cursor: IMPLEMENT_STEP_INDEX, paused: 1, repo, plan: planFor('server/src/app.js', 'snapshot()') })
  await runSummarize('MD-SELF', `${DIGEST}## Overlap\n- **MD-PEER** — decision: **depends-on**\n`)
  assert.deepEqual(edges('MD-SELF'), [])
  const digest = latestDigest('MD-SELF')
  assert.equal(digest.match(/## Overlap/g).length, 1)
  assert.ok(digest.includes('- **MD-PEER** — decision: **shared-contract**'))
  assert.ok(!digest.includes('decision: **depends-on**'))
})

test('HZ-466 guardrail 4: a recorded removal covers only its own pair; Horizon removing an edge records nothing', async () => {
  const repo = 'hz466-pair/repo'
  const plan = planFor('server/src/app.js', 'snapshot()')
  item('PA-A', { cursor: SUMMARIZE, repo, plan })
  item('PA-B', { cursor: IMPLEMENT_STEP_INDEX, repo, plan })
  item('PA-C', { cursor: IMPLEMENT_STEP_INDEX, repo, plan })
  assert.ok(store.addDependency('PA-A', 'PA-B', 'Horizon').ok)
  assert.equal((await removeViaApi('PA-A', 'PA-B')).statusCode, 200)

  await applyAll('PA-A')
  assert.deepEqual(edges('PA-A'), ['PA-C'], 'PA-A still links to PA-C')
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(REVIEW_GATE, 'PA-A') // PA-A is no longer building
  const fromC = await applyAll('PA-C')
  assert.equal(resultFor(fromC, 'PA-B').decision, 'depends-on')
  assert.deepEqual(edges('PA-C'), ['PA-B'], 'PA-C still links to PA-B')

  // split.js's cleanups remove Horizon edges as Horizon: no record.
  assert.ok(store.removeDependency('PA-C', 'PA-B', 'Horizon').ok)
  assert.deepEqual(removalRows('PA-C', 'PA-B'), [])
})

test('HZ-466 guardrail 4: an owner removing a spawn/split Horizon edge records that pair only', async () => {
  const repo = 'hz466-spawn/repo'
  const plan = planFor('server/src/app.js', 'snapshot()')
  item('SP-PARENT', { cursor: SUMMARIZE, repo, plan })
  item('SP-CHILD', { cursor: IMPLEMENT_STEP_INDEX, repo, plan })
  item('SP-OTHER', { cursor: IMPLEMENT_STEP_INDEX, repo, plan })
  // spawn.js and split.js write their edges with created_by 'Horizon', the same as the overlap check.
  assert.ok(store.addDependency('SP-PARENT', 'SP-CHILD', 'Horizon').ok)
  assert.equal((await removeViaApi('SP-PARENT', 'SP-CHILD')).statusCode, 200)
  assert.deepEqual(removalRows('SP-PARENT', 'SP-CHILD'), [{ removed_by: 'Fixture User' }])

  const results = await applyAll('SP-PARENT')
  assert.equal(resultFor(results, 'SP-CHILD').decision, 'shared-contract')
  assert.equal(resultFor(results, 'SP-OTHER').decision, 'depends-on')
  assert.deepEqual(edges('SP-PARENT'), ['SP-OTHER'])
})
