// HZ-313, plan time: "Plan options & trade-offs" may propose a cross-repo
// split. The server validates it when the step completes, shows it (or why it
// was refused) at gate 5, and files nothing before that gate is approved.
// The plan step is driven through the real orchestrator with a captured farm
// and GitHub (helpers/splitGithubStub.mjs); gates go through the real routes.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { splitGithubStub } from './helpers/splitGithubStub.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-split-plan-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.GITHUB_TOKEN = 'ghp_split_plan_test_token'
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
const { decide, parsePolicy, ACTOR } = await import('../src/caretakerRules.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
await orchestrator.init({ info: () => {}, warn: () => {} })
await new Promise((r) => setTimeout(r, 50)) // ensureFarm's start handshake
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)

after(() => {
  for (const { item_id } of db.prepare("SELECT DISTINCT item_id FROM step_run WHERE status = 'active'").all()) orchestrator.cancel(item_id)
})

const OPTIONS = requiredStepIndex('Plan options & trade-offs (pros / cons)')
const DESIGN_GATE = requiredStepIndex('Approve the high-level design')
const SRC = 'FinTekkers/ledger-service'
const LIB = 'FinTekkers/ledger-models'
const LIB2 = 'FinTekkers/ledger-utils'
const OTHER = 'Acme/elsewhere'

const project = store.createProject('FinTekkers').id
for (const repo of [SRC, LIB, LIB2]) store.addRepoToProject(project, repo)
store.addRepoToProject(store.createProject('Acme').id, OTHER)

const PLAN_MD = '## Options\nA, B.\n## Recommendation\nB fixes it upstream.\nRecommended option: B\n## Blockers\nNone.'
const SPLIT = {
  repo: LIB,
  title: 'Fix Decimal serialization',
  description: 'Serialize Decimal without losing scale.',
  metric: '1. Round-trips keep scale.',
  guardrails: '1. No wire change.',
  remaining_description: 'Use the fixed model.',
  remaining_metric: '1. Bump ledger-models to the new release.',
}

const tick = () => new Promise((r) => setTimeout(r, 20))
const policy = parsePolicy(readFileSync(join(REPO_ROOT, 'farm/roles/caretaker.md'), 'utf8'))

function newSource(title) {
  const issue = stub.addIssue(SRC, { title, body: composeIssueBody({ outcome: 'Fix it.', metric: 'Works.', guardrails: '' }) })
  const id = `LS-${issue.number}`
  db.prepare(
    "INSERT INTO work_item (id, title, priority, desc, metric, guardrails, issue, repo, project_id, cursor) VALUES (?, ?, 'Medium', 'Fix it.', 'Works.', '', ?, ?, ?, ?)",
  ).run(id, title, issue.number, SRC, project, OPTIONS)
  return id
}

// Completes one "Plan options" run for `id` (dispatching it if needed) and
// returns the artifact gate 5 shows.
async function runPlan(id, split, artifactMd = PLAN_MD) {
  orchestrator.kick(id)
  await tick()
  const run = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, OPTIONS)
  assert.ok(run, `no active plan run for ${id}`)
  const res = await orchestrator.completeFarmRun(run.id, { summary: 'planned', artifacts: { artifact_md: artifactMd, split } })
  assert.deepEqual(res, { ok: true })
  assert.equal(store.getItem(id).cursor, DESIGN_GATE)
  return store.latestArtifact(id, OPTIONS)
}

const approve = (id) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/gates/${DESIGN_GATE}/approve`, payload: {}, headers: { cookie, 'x-human-key': pin } })
const sendBack = (id) => app.gateActions.sendBack(id, { target: 'Approve the high-level design', feedback: 'rethink' }, 'You')
const rows = (id) => db.prepare('SELECT * FROM item_split WHERE source_item_id = ? ORDER BY id').all(id)
const deps = (id) => db.prepare('SELECT * FROM work_item_dependency WHERE item_id = ?').all(id)

async function cardOf(id) {
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  return res.json().items.find((i) => i.id === id)
}

test('a valid split is shown at gate 5 with its repo and title, and nothing is filed before approval', async () => {
  const before = stub.creates().length
  const id = newSource('valid split')
  const artifact = await runPlan(id, SPLIT)

  assert.match(artifact, /## Proposed split/)
  assert.ok(artifact.includes(`\`${LIB}\``))
  assert.ok(artifact.includes('Fix Decimal serialization'))
  assert.ok(artifact.includes('Bump ledger-models to the new release.'))
  const card = await cardOf(id)
  assert.match(card.stepOutputs[OPTIONS].artifact, /## Proposed split/, 'the board carries the proposed split')

  assert.deepEqual(rows(id).map((r) => [r.target_repo, r.status]), [[LIB, 'proposed']])
  assert.equal(stub.creates().length, before, 'no issue is filed by an unapproved plan')
  assert.equal(deps(id).length, 0)

  // Autopilot reads the same artifact: no blocker, one recommended option.
  const verdict = decide(DESIGN_GATE, { artifact }, policy)
  assert.equal(verdict.ruleId, 'g5.approve')
  assert.equal(stub.creates().length, before)
})

for (const [name, repo, phrase] of [
  ['a repo connected to another project', OTHER, /\*\*not connected\*\* to this item’s project/],
  ['a repo not connected at all', 'FinTekkers/unknown', /\*\*not connected\*\* to this item’s project/],
  ['the item’s own repo', SRC, /this item’s own repo/],
]) {
  test(`refusal: a split naming ${name} files nothing and the plan output says why`, async () => {
    const before = stub.creates().length
    const id = newSource(`refuse ${repo}`)
    const artifact = await runPlan(id, { ...SPLIT, repo })

    assert.ok(artifact.includes(`\`${repo}\``), 'the output names the repo')
    assert.match(artifact, phrase)
    assert.doesNotMatch(artifact, /## Proposed split/)
    assert.doesNotMatch(artifact, /^None\.$/m, 'the refusal replaces "None." under Blockers')
    assert.equal(rows(id).length, 0)

    // Autopilot is stopped by the blocker and sends the design back.
    const verdict = decide(DESIGN_GATE, { artifact }, policy)
    assert.equal(verdict.ruleId, 'g5.blocker')
    assert.equal(verdict.decision, 'send_back')
    assert.equal((await app.gateActions.sendBack(id, { target: 'Approve the high-level design', feedback: verdict.comment }, ACTOR)).ok, true)

    // Even a human approval of the refused plan files nothing.
    await runPlan(id, { ...SPLIT, repo })
    assert.equal((await approve(id)).statusCode, 200)
    assert.equal(stub.creates().length, before)
    assert.equal(deps(id).length, 0)
    assert.equal(rows(id).length, 0)
  })
}

test('a send-back at gate 5 files nothing, and a re-run with no split drops the proposal', async () => {
  const before = stub.creates().length
  const id = newSource('send back')
  await runPlan(id, SPLIT)
  assert.equal(rows(id).length, 1)

  assert.equal((await sendBack(id)).ok, true)
  assert.equal(stub.creates().length, before, 'a sent-back plan files nothing')

  const artifact = await runPlan(id, undefined)
  assert.doesNotMatch(artifact, /## Proposed split/)
  assert.equal(rows(id).length, 0, 'the proposed row is gone')
  assert.equal((await approve(id)).statusCode, 200)
  assert.equal(stub.creates().length, before)
  assert.equal(deps(id).length, 0)
})

test('a re-run that switches repo leaves one proposal, for the new repo, and approval files only there', async () => {
  const id = newSource('switch repo')
  await runPlan(id, SPLIT)
  assert.equal((await sendBack(id)).ok, true)
  await runPlan(id, { ...SPLIT, repo: LIB2, title: 'Utils fix' })

  assert.deepEqual(rows(id).map((r) => [r.target_repo, r.status]), [[LIB2, 'proposed']])
  const libBefore = stub.creates(LIB).length
  const lib2Before = stub.creates(LIB2).length
  const res = await approve(id)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(stub.creates(LIB).length, libBefore)
  assert.equal(stub.creates(LIB2).length, lib2Before + 1)
  assert.equal(deps(id).length, 1)
})

test('cycle: once the filed upstream item depends on the source, a re-plan of the same split is refused and files nothing', async () => {
  const id = newSource('cycle')
  await runPlan(id, SPLIT)
  assert.equal((await approve(id)).statusCode, 200)
  const [row] = rows(id)
  assert.equal(row.status, 'filed')

  // A human swaps the edge round with the X button and the API.
  assert.equal(store.removeDependency(id, row.target_item_id).ok, true)
  orchestrator.cancel(id) // the unblocked source had started its next step
  assert.equal(store.addDependency(row.target_item_id, id).ok, true)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(OPTIONS, id)

  const before = stub.creates().length
  const artifact = await runPlan(id, SPLIT)
  assert.match(artifact, /would create a cycle/)
  assert.ok(artifact.includes(row.target_item_id))
  assert.equal(decide(DESIGN_GATE, { artifact }, policy).ruleId, 'g5.blocker')
  assert.equal((await approve(id)).statusCode, 200)
  assert.equal(stub.creates().length, before)
  assert.equal(deps(id).length, 0, 'no edge back onto the dependent item')
})
