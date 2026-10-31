// HZ-685: an item may be narrowed to "Deferred to a follow-up item" only with
// that follow-up filed and linked. Approving Review before execution files a
// same-repo split the summary step proposed (one issue, a dependency the
// follow-up holds on this item), and refuses a narrowing with no follow-up.
// The steps run through the real orchestrator, gates go through the real
// routes, and GitHub is a counting stub (helpers/splitGithubStub.mjs).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { splitGithubStub } from './helpers/splitGithubStub.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-split-narrowing-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.GITHUB_TOKEN = 'ghp_TEST_NARROWING'
delete process.env.GITHUB_WEBHOOK_SECRET

const stub = splitGithubStub()
globalThis.fetch = stub.fetch

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const { composeIssueBody } = await import('../src/github.js')
const { splitMarker } = await import('../src/split.js')
const { UNFILED_NARROWING_REASON } = await import('../src/narrowing.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
await orchestrator.init({ info: () => {}, warn: () => {} })
await new Promise((r) => setTimeout(r, 50)) // ensureFarm's start handshake
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)

after(() => {
  for (const { item_id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(item_id)
})

const INTAKE_GATE = requiredStepIndex('Approve & prioritize this work')
const OPTIONS = requiredStepIndex('Plan options & trade-offs (pros / cons)')
const DESIGN_GATE = requiredStepIndex('Approve the high-level design')
const DIGEST = requiredStepIndex('Summarize reviews & recommend')
const REVIEW_GATE = requiredStepIndex('Review before execution')
const CLOSE_GATE = requiredStepIndex('Review the work & close')
const SRC = 'FinTekkers/ledger-service'
const LIB = 'FinTekkers/ledger-models'

const project = store.createProject('FinTekkers').id
for (const repo of [SRC, LIB]) store.addRepoToProject(project, repo)

const FULL_METRIC = '1. Totals round-trip.\n2. measuresForArm returns every arm.'
const NARROWED = '1. Totals round-trip.\nDeferred to a follow-up item (not in scope here): 2. measuresForArm returns every arm.'
const FOLLOW_UP = {
  title: 'measuresForArm returns every arm',
  description: 'The deferred half of the item: measuresForArm.',
  metric: '1. measuresForArm returns every arm.',
  guardrails: '1. No API change.',
}
const DIGEST_MD = '## Recommendation\n**PROCEED** — part 1 now, part 2 as a follow-up.\n## Actions\nNone.'
const CROSS = {
  repo: LIB,
  title: 'Fix Decimal serialization',
  description: 'Serialize Decimal without losing scale.',
  metric: '1. Round-trips keep scale.',
  guardrails: '1. No wire change.',
  remaining_metric: FULL_METRIC,
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
let seq = 0

function newSource(title, { cursor = DIGEST, desc = 'SOURCE_DESC', metric = FULL_METRIC } = {}) {
  const issue = stub.addIssue(SRC, { title, body: composeIssueBody({ outcome: desc, metric, guardrails: '' }) })
  const id = `LS-${issue.number}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, repo, project_id, cursor) VALUES (?, ?, 'Medium', ?, ?, '', ?, ?, ?, ?)",
  ).run(id, title, desc, metric, issue.number, SRC, project, cursor)
  return id
}

// A follow-up already filed on the item's own repo, as a row and an item.
function filedFollowUp(sourceId, { linked = true } = {}) {
  const targetId = `LS-F${++seq}`
  db.prepare("INSERT INTO work_item (id, title, priority, repo, project_id, cursor) VALUES (?, 'follow-up', 'Medium', ?, ?, 0)").run(targetId, SRC, project)
  db.prepare(
    "INSERT INTO item_split (source_item_id, target_repo, status, payload_json, plan_run_id, target_issue, target_item_id) VALUES (?, ?, 'filed', '{}', 0, ?, ?)",
  ).run(sourceId, SRC, 9000 + seq, targetId)
  if (linked) assert.equal(store.addDependency(targetId, sourceId, 'Horizon').ok, true)
  return targetId
}

// One agent step through the real dispatch and completion.
async function runStep(id, step, { split, patch, artifactMd = DIGEST_MD } = {}) {
  orchestrator.kick(id)
  await tick()
  const run = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, step)
  assert.ok(run, `no active run for ${id} at step ${step}`)
  const artifacts = { artifact_md: artifactMd, ...(split ? { split } : {}) }
  assert.deepEqual(await orchestrator.completeFarmRun(run.id, { summary: 'done', patch, artifacts }), { ok: true })
  assert.equal(store.getItem(id).cursor, step + 1)
  return store.latestArtifact(id, step)
}
const runDigest = (id, opts = {}) => runStep(id, DIGEST, opts)

const approve = (id, gate) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/gates/${gate}/approve`, payload: {}, headers: { cookie, 'x-human-key': pin } })
const rowsOf = (id) => db.prepare('SELECT target_repo, status FROM item_split WHERE source_item_id = ? ORDER BY id').all(id)
const edgesOf = (id) =>
  db.prepare('SELECT item_id, depends_on_id FROM work_item_dependency WHERE item_id = ? OR depends_on_id = ? ORDER BY item_id').all(id, id)
const redEvents = (id) => db.prepare("SELECT text FROM event WHERE item_id = ? AND color = '#9C333E'").all(id).map((e) => e.text)
// Red events about a narrowing. (An approved gate 10 dispatches implement,
// which pauses on this test repo's missing check commands — unrelated.)
const narrowingEvents = (id) => redEvents(id).filter((t) => t.includes(UNFILED_NARROWING_REASON))
const runCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ?').get(id).n
const boardItem = async (id) => (await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })).json().items.find((i) => i.id === id)

// ---- metric 1: refused at the gate without a filed, linked follow-up ----

for (const [name, fields, withRow] of [
  ['a deferred line in the metric, no follow-up', { metric: NARROWED }, false],
  ['a deferred line in the outcome only', { desc: `Totals only.\nDeferred to a follow-up item (not in scope here): measuresForArm.` }, false],
  ['a filed follow-up with no dependency', { metric: NARROWED }, true],
]) {
  test(`refused: ${name} — 409, one red event, the gate stays open, nothing runs or is filed`, async () => {
    const id = newSource(`refused ${name}`, { cursor: REVIEW_GATE, ...fields })
    if (withRow) filedFollowUp(id, { linked: false })
    const runs = runCount(id)
    const creates = stub.creates().length

    const res = await approve(id, REVIEW_GATE)
    assert.equal(res.statusCode, 409, res.body)
    assert.deepEqual(res.json(), { error: UNFILED_NARROWING_REASON, narrowing: true })
    const red = redEvents(id)
    assert.equal(red.length, 1)
    assert.ok(red[0].includes(UNFILED_NARROWING_REASON), red[0])
    assert.equal(store.getItem(id).cursor, REVIEW_GATE)
    assert.equal(runCount(id), runs, 'no step_run was started')
    assert.equal(stub.creates().length, creates)
  })
}

test('accepted: the same narrowing with a filed, linked same-repo follow-up approves at gate 10 and at gate 5', async () => {
  const at10 = newSource('accepted at 10', { cursor: REVIEW_GATE, metric: NARROWED })
  filedFollowUp(at10)
  const res10 = await approve(at10, REVIEW_GATE)
  assert.equal(res10.statusCode, 200, res10.body)
  assert.equal(store.getItem(at10).cursor, REVIEW_GATE + 1)

  const at5 = newSource('accepted at 5', { cursor: DESIGN_GATE, metric: NARROWED })
  filedFollowUp(at5)
  const res5 = await approve(at5, DESIGN_GATE)
  assert.equal(res5.statusCode, 200, res5.body)
  assert.equal(store.getItem(at5).cursor, DESIGN_GATE + 1)
  assert.deepEqual(narrowingEvents(at10).concat(narrowingEvents(at5)), [])
})

test('scope: a deferred line is not refused at intake or at Review the work & close', async () => {
  for (const gate of [INTAKE_GATE, CLOSE_GATE]) {
    const id = newSource(`scope ${gate}`, { cursor: gate, metric: NARROWED })
    const res = await approve(id, gate)
    assert.equal(res.statusCode, 200, `gate ${gate}: ${res.body}`)
    assert.deepEqual(narrowingEvents(id), [], `gate ${gate}`)
  }
})

// ---- metric 3: one issue, one dependency, survives a restart ----

let journey = null

test('journey: the summary step proposes a same-repo follow-up; approving gate 10 files one issue that waits for this item', async () => {
  const id = newSource('journey')
  const artifact = await runDigest(id, { split: FOLLOW_UP, patch: { metric: NARROWED } })
  assert.match(artifact, /## Proposed split/)
  assert.match(artifact, /That follow-up then waits for this item\./)
  assert.equal(store.getItem(id).metric, NARROWED)
  assert.deepEqual(rowsOf(id), [{ target_repo: SRC, status: 'proposed' }])
  assert.equal(stub.creates().length, 0, 'nothing is filed before the gate is approved')

  const res = await approve(id, REVIEW_GATE)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(stub.creates(SRC).length, 1)
  assert.equal(stub.creates().length, 1)
  const body = stub.creates(SRC)[0].body.body
  for (const text of [FOLLOW_UP.description, FOLLOW_UP.metric, splitMarker(id), 'this follow-up waits for that item to close']) {
    assert.ok(body.includes(text), `body carries ${text}`)
  }

  const followUp = store.findItemByIssue(SRC, stub.repoIssues(SRC).at(-1).number)
  assert.ok(followUp, 'the follow-up synced in as an item')
  assert.equal(store.hasDependency(followUp.id, id), true, 'the follow-up waits for this item')
  assert.equal(store.hasDependency(id, followUp.id), false, 'this item never waits for its own part 2')
  assert.deepEqual(edgesOf(id), [{ item_id: followUp.id, depends_on_id: id }])
  assert.deepEqual(rowsOf(id), [{ target_repo: SRC, status: 'filed' }])
  const source = await boardItem(id)
  assert.equal(source.blocked, false)
  assert.deepEqual(source.blockedBy, [])
  assert.equal(store.getItem(id).cursor, REVIEW_GATE + 1)
  assert.ok(
    db.prepare('SELECT text FROM event WHERE item_id = ?').all(id).some((e) => e.text.startsWith(`filed the deferred part of this item as ${followUp.id}`)),
  )
  journey = { id, followUp: followUp.id }
})

function restartChild(id, extraIssues = {}) {
  const issues = Object.fromEntries(stub.issues)
  for (const [repo, list] of Object.entries(extraIssues)) issues[repo] = [...(issues[repo] || []), ...list]
  const env = {
    ...process.env,
    SPLIT_SOURCE: id,
    SPLIT_JSON: JSON.stringify(FOLLOW_UP),
    SPLIT_ISSUES: JSON.stringify(issues),
    SPLIT_STEP: String(DIGEST),
    SPLIT_GATE: String(REVIEW_GATE),
    SPLIT_PATCH: JSON.stringify({ metric: NARROWED }),
  }
  delete env.FARM_URL
  const out = execFileSync(process.execPath, [join(import.meta.dirname, 'helpers/splitRestartChild.mjs')], { env, encoding: 'utf8' })
  return JSON.parse(out.trim().split('\n').at(-1))
}

test('idempotency: after a real restart, a re-run summary and re-approval file no second issue and no second edge', () => {
  const { id, followUp } = journey
  orchestrator.cancel(id)
  // Implement paused it on the missing check commands; the restart re-runs
  // the summary step, which a paused item would refuse.
  db.prepare('UPDATE work_item SET paused = 0 WHERE id = ?').run(id)
  const result = restartChild(id)
  assert.deepEqual(result.completed, { ok: true })
  assert.equal(result.approved.ok, true, JSON.stringify(result.approved))
  assert.match(result.artifact, /\*\*Already filed\*\*/)
  assert.equal(result.creates, 0, 'the restarted server filed nothing')
  assert.deepEqual(result.edges, [{ item_id: followUp, depends_on_id: id }])
  assert.deepEqual(result.rows, [{ target_repo: SRC, status: 'filed' }])
})

test('idempotency: a restart mid-filing, the issue already on GitHub and the edge missing, reuses the issue', async () => {
  const id = newSource('restart while filing')
  await runDigest(id, { split: FOLLOW_UP, patch: { metric: NARROWED } })
  // The crashed attempt: issue created, row still 'filing', no edge.
  const orphan = stub.addIssue(SRC, {
    title: FOLLOW_UP.title,
    body: `${composeIssueBody({ outcome: FOLLOW_UP.description, metric: FOLLOW_UP.metric })}\n\n${splitMarker(id)}`,
  })
  db.prepare("UPDATE item_split SET status = 'filing' WHERE source_item_id = ?").run(id)
  orchestrator.cancel(id)
  assert.deepEqual(edgesOf(id), [])

  const result = restartChild(id)
  assert.equal(result.approved.ok, true, JSON.stringify(result.approved))
  assert.equal(result.creates, 0, 'no second issue')
  const target = store.findItemByIssue(SRC, orphan.number)
  assert.ok(target, 'the orphan issue is the follow-up item')
  assert.deepEqual(result.edges, [{ item_id: target.id, depends_on_id: id }])
  assert.deepEqual(result.rows, [{ target_repo: SRC, status: 'filed' }])
})

// ---- guardrail 3: filed only when the gate is approved ----

test('send-back, reject and a re-run summary with no split file nothing and add no edge', async () => {
  const id = newSource('no filing')
  const creates = stub.creates().length
  await runDigest(id, { split: FOLLOW_UP, patch: { metric: NARROWED } })
  assert.deepEqual(rowsOf(id), [{ target_repo: SRC, status: 'proposed' }])

  // Send-back (the caretaker's and WhatsApp's path).
  assert.equal((await app.gateActions.sendBack(id, { target: 'x', feedback: 'again', targetStepIndex: DIGEST }, 'You')).ok, true)
  assert.equal(stub.creates().length, creates)
  assert.deepEqual(edgesOf(id), [])

  // Reject through the browser route.
  await runDigest(id, { split: FOLLOW_UP })
  const rejected = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/reject`,
    payload: { target: 'x', feedback: 'no', targetStepIndex: DIGEST },
    headers: { cookie, 'x-human-key': pin },
  })
  assert.equal(rejected.statusCode, 200, rejected.body)
  assert.equal(stub.creates().length, creates)
  assert.deepEqual(edgesOf(id), [])

  // A re-run summary with no split drops the stale proposal: the narrowing
  // is now refused, and once the owner clears the deferred line the gate
  // approves with nothing filed.
  await runDigest(id)
  assert.deepEqual(rowsOf(id), [])
  assert.equal((await approve(id, REVIEW_GATE)).statusCode, 409)
  db.prepare('UPDATE work_item SET metric = ? WHERE id = ?').run(FULL_METRIC, id)
  assert.equal((await approve(id, REVIEW_GATE)).statusCode, 200)
  assert.equal(stub.creates().length, creates)
  assert.deepEqual(edgesOf(id), [])
})

// ---- guardrail 1: a cross-repo split and a same-repo follow-up on one item ----

test('a cross-repo split filed at gate 5 and a same-repo follow-up filed at gate 10 each file once, each edge its own way', async () => {
  const id = newSource('both', { cursor: OPTIONS })
  await runStep(id, OPTIONS, { split: CROSS, artifactMd: '## Recommendation\nRecommended option: A\n## Blockers\nNone.' })
  assert.equal((await approve(id, DESIGN_GATE)).statusCode, 200)
  assert.equal(stub.creates(LIB).length, 1)
  const lib = store.findItemByIssue(LIB, stub.repoIssues(LIB).at(-1).number)
  assert.deepEqual(edgesOf(id), [{ item_id: id, depends_on_id: lib.id }])

  // A summary re-run with no split leaves the cross-repo row and edge alone.
  orchestrator.cancel(id)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(DIGEST, id)
  await runDigest(id)
  assert.deepEqual(rowsOf(id), [{ target_repo: LIB, status: 'filed' }])
  assert.deepEqual(edgesOf(id), [{ item_id: id, depends_on_id: lib.id }])

  // A cross-repo split at the summary step is refused; nothing changes.
  assert.equal((await app.gateActions.sendBack(id, { target: 'x', feedback: 'again', targetStepIndex: DIGEST }, 'You')).ok, true)
  const refused = await runDigest(id, { split: { ...CROSS, title: 'another' } })
  assert.match(refused, /another repo/)
  assert.deepEqual(rowsOf(id), [{ target_repo: LIB, status: 'filed' }])

  assert.equal((await app.gateActions.sendBack(id, { target: 'x', feedback: 'again', targetStepIndex: DIGEST }, 'You')).ok, true)
  await runDigest(id, { split: FOLLOW_UP, patch: { metric: NARROWED } })
  assert.deepEqual(rowsOf(id), [
    { target_repo: LIB, status: 'filed' },
    { target_repo: SRC, status: 'proposed' },
  ])
  const before = stub.creates(SRC).length
  const res = await approve(id, REVIEW_GATE)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(stub.creates(LIB).length, 1, 'the cross-repo split is not filed again')
  assert.equal(stub.creates(SRC).length, before + 1)
  const followUp = store.findItemByIssue(SRC, stub.repoIssues(SRC).at(-1).number)
  assert.deepEqual(
    edgesOf(id).sort((a, b) => a.item_id.localeCompare(b.item_id)),
    [
      { item_id: id, depends_on_id: lib.id },
      { item_id: followUp.id, depends_on_id: id },
    ].sort((a, b) => a.item_id.localeCompare(b.item_id)),
  )
  assert.deepEqual(rowsOf(id), [
    { target_repo: LIB, status: 'filed' },
    { target_repo: SRC, status: 'filed' },
  ])
})

// ---- guardrail 4: no narrowing, no split — exactly as before ----

test('an item with no deferred line and no split approves at gate 10 as before', async () => {
  const id = newSource('plain', { cursor: REVIEW_GATE })
  const creates = stub.creates().length
  const res = await approve(id, REVIEW_GATE)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(store.getItem(id).cursor, REVIEW_GATE + 1)
  assert.equal(stub.creates().length, creates)
  assert.deepEqual(narrowingEvents(id), [])
  assert.deepEqual(rowsOf(id), [])
})
