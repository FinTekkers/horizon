// HZ-435: the trivial lane. An issue labelled `trivial` has its plan rows
// checked, not written, skips the options, design gate, architecture review
// and summary rows, and otherwise runs the change pipeline — every gate and
// the automated review included. Unlabelled changes and Tasks run as before.
//
// Driven through the real orchestrator with the farm as a captured fetch stub
// (the orchestrator-overlap.test.mjs harness) and GitHub as a stub that serves
// issue bodies and records every write. Each test uses its own repo, so one
// test's in-flight items are never another's overlap peers.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-trivial-lane-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.GITHUB_TOKEN = 'ghp_hz435_stub'
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_NOTIFY_ENABLED', 'WA_POLL_ENABLED']) delete process.env[key]

// GitHub: issue bodies by "repo#number"; every non-GET request is recorded.
const issueBodies = new Map()
const githubWrites = []
const farmCalls = []
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  const method = opts.method || 'GET'
  if (u.startsWith('https://api.github.com/')) {
    if (method !== 'GET') githubWrites.push({ url: u, method })
    const issue = u.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/)
    if (method === 'GET' && issue && issueBodies.has(`${issue[1]}#${issue[2]}`)) {
      const body = issueBodies.get(`${issue[1]}#${issue[2]}`)
      return { ok: true, status: 200, json: async () => ({ number: Number(issue[2]), body }) }
    }
    return { ok: false, status: 500, json: async () => ({ message: 'stub' }) }
  }
  farmCalls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null })
  return { ok: true, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const gateNotifier = await import('../src/gateNotifier.js')
const { laneFromLabels } = await import('../src/kindLabels.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const auth = await import('../src/auth.js')
const lifecycle = await import('../../domain/js/lifecycle.js')
const { STEPS, isClosed, stepStatus, stepsFor, kindStepIndex, requiredStepIndex, reworkTargets, defaultReworkTarget } = lifecycle
const { connectReadyRepo } = await import('./helpers/readyRepo.mjs')
const domainSource = JSON.parse(readFileSync(join(REPO_ROOT, 'domain/steps.json'), 'utf8'))

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
const app = buildApp({ logger: false })
await app.ready()
const { cookie, pin } = loginFixtureUser(auth, config)

after(async () => {
  for (const row of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(row.id)
  await app.close()
})

const label = (i) => STEPS[i].label
const at = (l) => requiredStepIndex(l)
const APPROVE = at('Approve & prioritize this work')
const OPTIONS = at('Plan options & trade-offs (pros / cons)')
const DESIGN_GATE = at('Approve the high-level design')
const PLAN = at('Draft implementation plan')
const ARCH = at('Architecture review')
const QA = at('QA reviews the test plan')
const SUMMARIZE = at('Summarize reviews & recommend')
const PLAN_GATE = at('Review before execution')
const IMPLEMENT = at('Specialist agent implements')
const REVIEW = at('Automated review (code + QA)')
const ACCEPT = at('Accept the code')
const DEPLOY = at('Deploy the changes')
const CLOSE = at('Review the work & close')
const SKIPPED = [OPTIONS, DESIGN_GATE, ARCH, SUMMARIZE]
const CHECKED = [0, 1, 2].map((n) => stepsFor('change')[n].index)
const changeRows = stepsFor('change').map((row) => row.index)
const taskRows = stepsFor('task').map((row) => row.index)
const RUN_PLAN = kindStepIndex('Run plan', 'task')
const APPROVE_RUN = kindStepIndex('Approve the run', 'task')
const EXECUTE = kindStepIndex('Execute', 'task')
const VERIFY = kindStepIndex('Verify & report', 'task')

const COMPLETE_BODY = '## Outcome\r\nDelete two lines.\r\n\r\n## Success metric\r\n1. The list has two fewer lines.\r\n\r\n## Guardrails\r\n- Nothing else changes.\r\n'
const NO_METRIC_BODY = '## Outcome\nDelete two lines.\n\n## Guardrails\n- Nothing else changes.\n'
const RUN_PLAN_MD = '## Commands\n1. echo\n\n## Run plan block\n```json run-plan\n{"cwd": ".", "commands": ["echo hi"], "budget_minutes": 5}\n```'

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms))
async function waitFor(predicate, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${what}`)
}

const runsOf = (id) => db.prepare('SELECT step_index FROM step_run WHERE item_id = ? ORDER BY id').all(id).map((r) => r.step_index)
const eventsOf = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
const dispatchesOf = (id) => farmCalls.filter((c) => c.url.endsWith('/steps/run') && c.body?.item?.id === id)
const gateRows = (id) => db.prepare('SELECT step_index FROM gate_decision WHERE item_id = ? ORDER BY id').all(id).map((r) => r.step_index)

function connect(repo) {
  connectReadyRepo(db, repo, { noDeploy: true })
  db.prepare("UPDATE project SET enabled = 1 WHERE name = 'Ready repos'").run()
}

// Files `repo#number` the way the webhook and the poller do, and returns its id.
function fileIssue(repo, number, { body = COMPLETE_BODY, labels = [] } = {}) {
  issueBodies.set(`${repo}#${number}`, body)
  const issue = { number, title: `Issue ${number}`, body, state: 'open', labels: labels.map((name) => ({ name })) }
  store.upsertFromGithub(issue, repo)
  return store.findItemByIssue(repo, number).id
}

function resync(id, labels) {
  const it = store.getItem(id)
  const body = issueBodies.get(`${it.repo}#${it.issue}`)
  store.upsertFromGithub({ number: it.issue, title: it.title, body, state: 'open', labels: labels.map((name) => ({ name })) }, it.repo)
}

const REVIEW_PASS = {
  code_review: { verdict: 'pass', findings: [] },
  qa_review: { verdict: 'pass', regression_tests_run: true, new_code_unit_coverage: true, e2e_test_present: true, findings: [] },
}

function replyFor(stepIndex) {
  if (stepIndex === REVIEW) return { summary: 'review passed', artifacts: { verdict: REVIEW_PASS } }
  if (stepIndex === RUN_PLAN) return { summary: 'planned', artifacts: { artifact_md: RUN_PLAN_MD } }
  if (stepIndex === VERIFY) return { summary: 'verified', artifacts: { artifact_md: '## Verdict\n**pass**', verdict: { verdict: 'pass', summary: 'ok' } } }
  if (stepIndex === PLAN) return { summary: 'planned', artifacts: { artifact_md: '## Files & lines\n**1. `server/src/app.js` — EDIT.**\n- `snapshot()` changes.\n' } }
  return { summary: `did ${label(stepIndex)}`, artifacts: { artifact_md: `## ${label(stepIndex)}\ndone` } }
}

async function approve(id, gateIndex) {
  if (lifecycle.isHumanOnlyGate(gateIndex)) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${id}/gates/${gateIndex}/approve`,
      headers: { cookie, 'x-human-key': pin },
      payload: {},
    })
    assert.equal(res.statusCode, 200, res.body)
    return
  }
  assert.deepEqual(store.approveGate(id, gateIndex, '', 'You'), { ok: true, closed: gateIndex === CLOSE || gateIndex === taskRows.at(-1) })
}

// Drives the item to closed (or to `until`), completing each farm run with a
// canned reply and approving each gate. Returns every row it saw, in order.
// Runs are read back from step_run, so one that finishes by itself (a deploy
// with nothing to ship) is counted in its place too.
async function drive(id, { until = null } = {}) {
  const seen = []
  let lastRunId = db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM step_run WHERE item_id = ? AND status = 'done'").get(id).n
  for (let guard = 0; guard < 40; guard++) {
    for (const run of db.prepare("SELECT id, step_index FROM step_run WHERE item_id = ? AND id > ? AND status = 'done' ORDER BY id").all(id, lastRunId)) {
      seen.push(run.step_index)
      lastRunId = run.id
    }
    const it = store.getItem(id)
    if (isClosed(it) || it.cursor === until) return seen
    assert.equal(it.paused, false, `paused at ${label(it.cursor)}: ${eventsOf(id).at(-1)}`)
    const index = it.cursor
    if (STEPS[index].kind === 'gate') {
      seen.push(index)
      await approve(id, index)
      continue
    }
    orchestrator.kick(id)
    let run = null
    await waitFor(() => {
      if (store.getItem(id).cursor !== index) return true
      run = db.prepare("SELECT id FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'active'").get(id, index)
      return run && farmCalls.some((c) => c.body?.run_id === run.id)
    }, `${id} to dispatch ${label(index)}`)
    if (store.getItem(id).cursor === index) {
      const res = await orchestrator.completeFarmRun(run.id, replyFor(index))
      assert.equal(res.ok, true, JSON.stringify(res))
    }
  }
  throw new Error(`${id} never closed`)
}

test('the trivial lane in steps.json skips 4, 5, 7 and 9, checks 0-2, and never a gate or the review', () => {
  const lane = lifecycle.laneOf({ kind: 'change', lane: 'trivial' })
  assert.equal(lane, 'trivial')
  assert.deepEqual([...lifecycle.laneSkips({ lane })].sort((a, b) => a - b), SKIPPED)
  assert.deepEqual([...lifecycle.laneCheckIndexes({ lane })].sort((a, b) => a - b), CHECKED)
  for (const kept of [APPROVE, PLAN_GATE, REVIEW, ACCEPT, CLOSE]) assert.equal(lifecycle.laneSkips({ lane }).has(kept), false)
})

test('guardrail 2: a lane that skips gate 3, 10, 13 or 15 or step 12 fails at load', () => {
  for (const banned of [APPROVE, PLAN_GATE, REVIEW, ACCEPT, CLOSE]) {
    const tampered = structuredClone(domainSource)
    tampered.lanes.trivial.skip.push(label(banned))
    assert.throws(() => lifecycle.assertLifecycleShape(tampered), /lanes\.trivial may not skip/, label(banned))
  }
  assert.equal(lifecycle.assertLifecycleShape(structuredClone(domainSource)).lanes.trivial.itemKind, 'change')
})

test('metrics 1 and 2: a trivial item checks its plan, skips 4, 5, 7 and 9, and runs every gate and the review', async () => {
  const repo = 'hz435/order'
  connect(repo)
  const id = fileIssue(repo, 1, { labels: ['bug', 'Trivial'] })
  assert.equal(store.getItem(id).lane, 'trivial')

  await waitFor(() => store.getItem(id).cursor === APPROVE, 'the plan check to reach gate 3')
  // Metric 2: checked, not written — no run, no farm call, no GitHub write.
  assert.deepEqual(runsOf(id), [])
  assert.deepEqual(dispatchesOf(id), [])
  assert.deepEqual(githubWrites, [])
  assert.equal(issueBodies.get(`${repo}#1`), COMPLETE_BODY)
  const checked = eventsOf(id).indexOf('plan sections checked — Outcome, Success metric, Guardrails present')
  assert.ok(checked >= 0, eventsOf(id).join('\n'))
  assert.deepEqual(gateRows(id), [], 'the check came before gate 3')

  const seen = await drive(id)
  assert.deepEqual(seen, [APPROVE, PLAN, QA, PLAN_GATE, IMPLEMENT, REVIEW, ACCEPT, DEPLOY, CLOSE])
  assert.deepEqual(runsOf(id), [PLAN, QA, IMPLEMENT, REVIEW, DEPLOY])
  assert.deepEqual(gateRows(id), [APPROVE, PLAN_GATE, ACCEPT, CLOSE])
  // The farm was told the lane, so steps 6 and 8 picked their short prompts.
  assert.deepEqual(
    dispatchesOf(id).map((c) => [c.body.step.index, c.body.item.lane]),
    [PLAN, QA, IMPLEMENT, REVIEW].map((i) => [i, 'trivial']),
  )
  const closed = store.getItem(id)
  for (const i of SKIPPED) assert.equal(stepStatus(closed, i), 'skipped', label(i))
  for (const i of [...CHECKED, APPROVE, PLAN, QA, PLAN_GATE, IMPLEMENT]) assert.equal(stepStatus(closed, i), 'done', label(i))
})

test('metric 1: gate 10 of a trivial item notifies without throwing — there is no summary to quote', async () => {
  const repo = 'hz435/notify'
  connect(repo)
  const id = fileIssue(repo, 1, { labels: ['trivial'] })
  await waitFor(() => store.getItem(id).cursor === APPROVE, 'gate 3')
  await drive(id, { until: PLAN_GATE })
  assert.equal(store.latestArtifact(id, SUMMARIZE), null)
  const result = gateNotifier.sweepGates({ log: { info() {}, warn() {}, error() {} } })
  assert.equal(result.failed, 0)
  assert.equal(db.prepare('SELECT notified_step FROM work_item WHERE id = ?').get(id).notified_step, PLAN_GATE)
  assert.match(gateNotifier.renderNotice(store.getItem(id), null), new RegExp(id))
})

test('metric 1: an unlabelled change and a Task each run their full step list', async () => {
  const repo = 'hz435/full'
  connect(repo)
  const change = fileIssue(repo, 1)
  assert.equal(store.getItem(change).lane, null)
  assert.deepEqual(await drive(change), changeRows)
  assert.deepEqual(eventsOf(change).filter((t) => t.startsWith('plan sections checked')), [])

  // Guardrail 3: `trivial` on a Task selects nothing.
  const task = fileIssue(repo, 2, { labels: ['task', 'trivial'] })
  assert.equal(laneFromLabels([{ name: 'task' }, { name: 'trivial' }], 'task'), null)
  const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie } })
  const view = res.json().items.find((i) => i.id === task)
  assert.equal(view.kind, 'task')
  assert.equal(view.lane, null)
  assert.deepEqual(await drive(task), taskRows)
  assert.ok(runsOf(task).includes(EXECUTE))
  assert.ok(gateRows(task).includes(APPROVE_RUN))
})

test('metric 2: a trivial item missing its Success metric pauses with a one-line note, nothing written', async () => {
  const repo = 'hz435/missing'
  connect(repo)
  const writesBefore = githubWrites.length
  const id = fileIssue(repo, 1, { body: NO_METRIC_BODY, labels: ['trivial'] })
  await waitFor(() => store.getItem(id).paused, 'the check to pause the item')
  const note = eventsOf(id).find((t) => t.startsWith('paused: '))
  assert.equal(note, 'paused: Missing: Success metric')
  assert.equal(note.includes('\n'), false)
  assert.equal(store.getItem(id).cursor, CHECKED[0])
  assert.deepEqual(runsOf(id), [])
  assert.deepEqual(dispatchesOf(id), [])
  assert.equal(githubWrites.length, writesBefore)
  assert.equal(issueBodies.get(`${repo}#1`), NO_METRIC_BODY)
})

test('metric 5: removing the label before gate 3 restores 4-9; after gate 3 the lane is frozen', async () => {
  const repo = 'hz435/unlabel'
  connect(repo)
  const id = fileIssue(repo, 1, { labels: ['trivial'] })
  await waitFor(() => store.getItem(id).cursor === APPROVE, 'gate 3')

  resync(id, [])
  assert.equal(store.getItem(id).lane, null)
  assert.ok(eventsOf(id).includes('lane: full'))
  const seen = await drive(id, { until: PLAN_GATE + 1 })
  assert.deepEqual(seen, [APPROVE, OPTIONS, DESIGN_GATE, PLAN, ARCH, QA, SUMMARIZE, PLAN_GATE])

  resync(id, ['trivial'])
  assert.equal(store.getItem(id).lane, null, 'a label added after gate 3 changes nothing')
})

test('send-back: gates 10 and 13 and boot recovery never land on a skipped row', async () => {
  const insert = db.prepare("INSERT INTO work_item (id, title, priority, cursor, lane) VALUES (?, 'Send back', 'Medium', ?, 'trivial')")
  const item = { kind: 'change', lane: 'trivial' }
  for (const t of reworkTargets(PLAN_GATE, 'change', item)) assert.equal(SKIPPED.includes(t.index), false, t.label)
  assert.equal(defaultReworkTarget(PLAN_GATE, 'change', item), QA)
  assert.equal(defaultReworkTarget(ACCEPT, 'change', item), IMPLEMENT)
  // Without the item, the picker is today's.
  assert.equal(defaultReworkTarget(PLAN_GATE), SUMMARIZE)

  insert.run('SB-10', PLAN_GATE)
  assert.deepEqual(store.requestChanges('SB-10', 'QA', 'redo', 'You', SUMMARIZE), { error: 'invalid_target' })
  assert.deepEqual(store.requestChanges('SB-10', 'QA', 'redo'), { ok: true })
  assert.equal(store.getItem('SB-10').cursor, QA)

  insert.run('SB-13', ACCEPT)
  assert.deepEqual(store.requestChanges('SB-13', 'Eng', 'redo'), { ok: true })
  assert.equal(store.getItem('SB-13').cursor, IMPLEMENT)

  insert.run('SB-BOOT', PLAN_GATE)
  db.prepare("UPDATE work_item SET rejected = 1 WHERE id = 'SB-BOOT'").run()
  store.recoverRejectedItems()
  assert.equal(store.getItem('SB-BOOT').cursor, QA)
  for (const id of ['SB-10', 'SB-13', 'SB-BOOT']) orchestrator.cancel(id)
})

test('overlap: a trivial item runs the overlap check when step 8 completes, and gains the edge', async () => {
  const repo = 'hz435/overlap'
  connect(repo)
  const peer = fileIssue(repo, 1)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(IMPLEMENT, peer)
  orchestrator.cancel(peer)
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact) VALUES (?, ?, 1, 'Eng', 'done', ?)").run(
    peer,
    PLAN,
    '## Changes\n**1. `server/src/app.js` — EDIT.**\n- `snapshot()` changes.\n',
  )

  const id = fileIssue(repo, 2, { labels: ['trivial'] })
  await waitFor(() => store.getItem(id).cursor === APPROVE, 'gate 3')
  await drive(id, { until: PLAN_GATE })
  const edges = db.prepare('SELECT depends_on_id FROM work_item_dependency WHERE item_id = ?').all(id).map((r) => r.depends_on_id)
  assert.deepEqual(edges, [peer])
  assert.match(store.latestArtifact(id, QA), /## Overlap/)
})

// The six forward moves all go through nextCursor; a bare increment would
// walk a lane item onto a row it skips.
const BARE_INCREMENT = /cursor\s*=\s*cursor\s*\+\s*1/
test('no stray advance: store.js and orchestrator.js never increment the cursor by hand', () => {
  assert.equal(BARE_INCREMENT.test("UPDATE work_item SET cursor = cursor + 1 WHERE id = ?"), true, 'the scan must catch a planted increment')
  for (const file of ['server/src/store.js', 'server/src/orchestrator.js']) {
    assert.equal(BARE_INCREMENT.test(readFileSync(join(REPO_ROOT, file), 'utf8')), false, file)
  }
})
