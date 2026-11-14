// HO-839: a passing Preflight's rehearsal decides whether Approve the run can
// be offered. A failed one — a broken proof parser, a refused write, a write
// to the checkout, a timeout — sends the plan back to Run plan with a
// `feedback` row of source `rehearsal`, before anyone can approve it, under
// the send-back cap Impact review's rows count toward too. At the cap the
// item reaches the gate with Approve still refused: a rehearsal is never
// skipped. Only reason ids and labels are stored or shown.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-rehearsal-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { IMPACT_SENDBACK_CAP } = await import('../src/config.js')
const { mintHumanProof } = await import('../src/humanProof.js')
const { REHEARSAL_REASONS } = await import('../../domain/js/runPlan.js')
const { STEPS, IMPACT_REVIEW_STEP_INDEX, RUN_PLAN_STEP_INDEX, APPROVE_RUN_GATE_INDEX, PREFLIGHT_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const SECRET = 'hz839-planted-secret-7f3a'
const STDERR = 'hz839-planted-stderr-c41d'
const METRIC = '1. the day is priced'
const block = (commands) => ({
  cwd: '.',
  commands,
  budget_minutes: 5,
  runner: 'host',
  proof: [{ line: 1, command: 2 }],
  rehearsal: { dry_run: './load.sh --dry-run', samples: [{ command: 2, expect: '3' }] },
})
const PLAN = (commands = ['./load.sh', "jq -e '.priced | length' fixtures/day1.json"]) =>
  `## Commands\n1. load\n\n## Run plan block\n\`\`\`json run-plan\n${JSON.stringify(block(commands))}\n\`\`\``

function seedTask(id, plan = PLAN()) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, metric) VALUES (?, ?, 'High', ?, 'task', ?)").run(id, `Task ${id}`, PREFLIGHT_STEP_INDEX, METRIC)
  writePlan(id, plan)
}

function writePlan(id, plan) {
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', ?, datetime('now'))").run(
    id,
    RUN_PLAN_STEP_INDEX,
    STEPS[RUN_PLAN_STEP_INDEX].agent,
    plan,
  )
}

// An active Preflight run as kick() leaves it: bound to the plan on record.
function activePreflightRun(id) {
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(PREFLIGHT_STEP_INDEX, id)
  db.prepare("UPDATE step_run SET status = 'superseded' WHERE item_id = ? AND status = 'active'").run(id)
  const attempt = db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ?').get(id, PREFLIGHT_STEP_INDEX).n + 1
  return db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, plan_hash) VALUES (?, ?, ?, ?, 'active', ?)")
    .run(id, PREFLIGHT_STEP_INDEX, attempt, STEPS[PREFLIGHT_STEP_INDEX].agent, store.currentRunPlan(id).hash).lastInsertRowid
}

const PASSED = { passed: true, runner: 'host', run_user: 'ubuntu', unmet: [] }
const CLEAN = { clean: true, reason: null, scope: 'full', seconds: 7, plan_hash: 'x', failures: [] }
const failed = (reason, what = 'proof command 2 (metric line 1)', exit = 5) => ({
  clean: false,
  reason,
  scope: 'full',
  seconds: 9,
  failures: [{ what, reason, exit }],
})

async function completePreflight(id, artifacts) {
  const runId = activePreflightRun(id)
  assert.deepEqual(await orchestrator.completeFarmRun(runId, { summary: 'preflight passed; rehearsal ran', artifacts: { artifact_md: '## Preflight', ...artifacts } }), { ok: true })
  return runId
}

const cursor = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const feedbackRows = (id) => db.prepare('SELECT target, message, source FROM feedback WHERE item_id = ? ORDER BY id').all(id)
const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)
const storedRehearsal = (runId) => db.prepare('SELECT rehearsal_json FROM step_run WHERE id = ?').get(runId).rehearsal_json

function approve(id) {
  const view = store.itemViewById(id)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(APPROVE_RUN_GATE_INDEX, id)
  return store.approveGate(id, APPROVE_RUN_GATE_INDEX, '', 'Owner', { proof: mintHumanProof({ userId: 1 }), planHash: view.runPlan.hash, runner: view.runPlan.runner })
}

// ==== metric lines 1 and 3, guardrail 2: every failure class is sent back ====

for (const [reason, what, exit] of [
  ['rehearsal_parser_failed', 'proof command 2 (metric line 1)', 5],
  ['rehearsal_write_refused', 'dry run', 1],
  ['rehearsal_checkout_write_refused', 'dry run', 0],
  ['rehearsal_timeout', 'rehearsal', null],
]) {
  test(`${reason}: a feedback row of source rehearsal, back to Run plan, and Approve the run refused`, async () => {
    const id = `T-RH-${reason.slice(10, 22).toUpperCase()}`
    seedTask(id)
    const runId = await completePreflight(id, { preflight: PASSED, rehearsal: failed(reason, what, exit) })
    assert.equal(cursor(id), RUN_PLAN_STEP_INDEX)
    const rows = feedbackRows(id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].source, orchestrator.REHEARSAL_SENDBACK_SOURCE)
    assert.equal(rows[0].source, 'rehearsal')
    assert.equal(rows[0].target, STEPS[RUN_PLAN_STEP_INDEX].agent)
    assert.match(rows[0].message, new RegExp(`rehearsal of this run plan failed .*: ${reason}`))
    assert.ok(rows[0].message.includes(`- ${what}: ${reason}${exit == null ? '' : ` (exit ${exit})`}`), rows[0].message)
    assert.deepEqual(JSON.parse(storedRehearsal(runId)), { clean: false, reason, scope: 'full', seconds: 9, failures: [{ what, reason, exit }] })
    assert.ok(events(id).some((t) => t.includes(`the rehearsal failed (${reason}; send-back 1/${IMPACT_SENDBACK_CAP}`) && t.includes(`sent back to “${STEPS[RUN_PLAN_STEP_INDEX].label}”`)))
    // Even forced to the gate, nobody can approve it.
    assert.deepEqual(approve(id), { error: 'rehearsal_not_clean', reason })
    assert.equal(db.prepare('SELECT approved_plan_hash FROM work_item WHERE id = ?').get(id).approved_plan_hash, null)
    assert.equal(store.itemViewById(id).runPlan.rehearsal.clean, false)
  })
}

test('a clean rehearsal goes on to the gate, shows clean on the card, and approves', async () => {
  seedTask('T-RH-CLEAN')
  const runId = await completePreflight('T-RH-CLEAN', { preflight: PASSED, rehearsal: CLEAN })
  assert.equal(cursor('T-RH-CLEAN'), APPROVE_RUN_GATE_INDEX)
  assert.deepEqual(feedbackRows('T-RH-CLEAN'), [])
  assert.deepEqual(JSON.parse(storedRehearsal(runId)), { clean: true, reason: null, scope: 'full', seconds: 7, failures: [] })
  assert.deepEqual(store.itemViewById('T-RH-CLEAN').runPlan.rehearsal, { clean: true, reason: null, scope: 'full', seconds: 7, failures: [] })
  assert.equal(approve('T-RH-CLEAN').error, undefined)
})

test('a passing Preflight with no rehearsal in its result is stored as rehearsal_missing and sent back', async () => {
  seedTask('T-RH-NONE')
  const runId = await completePreflight('T-RH-NONE', { preflight: PASSED })
  assert.equal(JSON.parse(storedRehearsal(runId)).reason, 'rehearsal_missing')
  assert.equal(cursor('T-RH-NONE'), RUN_PLAN_STEP_INDEX)
  assert.equal(feedbackRows('T-RH-NONE')[0].source, 'rehearsal')
})

test('an unmet Preflight stores no rehearsal and sends nothing back: Preflight blocks the gate first', async () => {
  seedTask('T-RH-UNMET')
  const runId = await completePreflight('T-RH-UNMET', { preflight: { ...PASSED, passed: false, unmet: [{ kind: 'tool', name: 'jq', reason: 'missing' }] }, rehearsal: CLEAN })
  assert.equal(storedRehearsal(runId), null)
  assert.equal(cursor('T-RH-UNMET'), APPROVE_RUN_GATE_INDEX)
  assert.deepEqual(feedbackRows('T-RH-UNMET'), [])
  assert.equal(store.itemViewById('T-RH-UNMET').runPlan.rehearsal, null)
  assert.equal(approve('T-RH-UNMET').error, 'preflight_unmet')
})

// ==== guardrail 3: one cap for Impact review's and the rehearsal's send-backs ====

test('the shared cap: one impact-review row plus one rehearsal row reach it — the next failure reaches the gate with Approve refused', async () => {
  assert.equal(IMPACT_SENDBACK_CAP, 2)
  seedTask('T-RH-CAP')
  // Impact review sent it back once already (HZ-770).
  db.prepare("INSERT INTO feedback (item_id, target, message, source) VALUES (?, ?, 'circular line 1', ?)").run('T-RH-CAP', STEPS[RUN_PLAN_STEP_INDEX].agent, orchestrator.IMPACT_SENDBACK_SOURCE)
  await completePreflight('T-RH-CAP', { preflight: PASSED, rehearsal: failed('rehearsal_parser_failed') })
  assert.equal(cursor('T-RH-CAP'), RUN_PLAN_STEP_INDEX, 'the first rehearsal failure is send-back 2 of 2')
  assert.equal(orchestrator.sendBackCount('T-RH-CAP'), IMPACT_SENDBACK_CAP)
  assert.ok(events('T-RH-CAP').some((t) => t.includes(`send-back 2/${IMPACT_SENDBACK_CAP}, shared with Impact review`)))

  await completePreflight('T-RH-CAP', { preflight: PASSED, rehearsal: failed('rehearsal_sample_mismatch') })
  assert.equal(cursor('T-RH-CAP'), APPROVE_RUN_GATE_INDEX, 'at the cap it reaches the gate')
  assert.equal(feedbackRows('T-RH-CAP').length, IMPACT_SENDBACK_CAP, 'no third send-back row')
  assert.ok(events('T-RH-CAP').some((t) => t.includes('send-back cap (2, shared with Impact review) is reached — Approve stays hidden')))
  assert.deepEqual(approve('T-RH-CAP'), { error: 'rehearsal_not_clean', reason: 'rehearsal_sample_mismatch' })
  assert.ok(events('T-RH-CAP').some((t) => t.includes('could not approve') && t.includes('rehearsal_sample_mismatch')))
  // Impact review's own send-back counts the rehearsal's rows too.
  assert.equal(orchestrator.impactSendBack('T-RH-CAP', { circular_proofs: [{ line: 1, reason: 'own output' }] }, METRIC).capped, true)
})

test('a human Reject with feedback does not count toward the shared cap', () => {
  seedTask('T-RH-HUMAN')
  db.prepare("INSERT INTO feedback (item_id, target, message, source) VALUES (?, 'Eng', 'try the vendor file', 'ui')").run('T-RH-HUMAN')
  assert.equal(orchestrator.sendBackCount('T-RH-HUMAN'), 0)
})

// ==== the result is bound to the plan it rehearsed ====

test('a clean rehearsal of plan A is no rehearsal for plan B', async () => {
  seedTask('T-RH-HASH')
  await completePreflight('T-RH-HASH', { preflight: PASSED, rehearsal: CLEAN })
  assert.equal(store.rehearsalCheck('T-RH-HASH').ok, true)
  writePlan('T-RH-HASH', PLAN(['./load.sh', "jq -e '.priced | length > 0' fixtures/day1.json"]))
  assert.equal(store.itemViewById('T-RH-HASH').runPlan.rehearsal, null)
  assert.deepEqual(store.rehearsalCheck('T-RH-HASH'), { error: 'rehearsal_not_clean', reason: null })
})

// ==== guardrail 4: reason ids and labels only ====

test('sanitizeRehearsal keeps reason ids, labels and exit codes only, and never turns a bad shape into clean', () => {
  assert.deepEqual(orchestrator.sanitizeRehearsal(null).clean, false)
  assert.deepEqual(orchestrator.sanitizeRehearsal({ clean: 'yes', failures: [] }).reason, 'rehearsal_missing')
  assert.equal(orchestrator.sanitizeRehearsal({ clean: true, failures: [{ what: 'x', reason: 'rehearsal_timeout' }] }).clean, false)
  assert.equal(orchestrator.sanitizeRehearsal({ clean: false, reason: 'made_up', failures: [{ what: 'x', reason: 'made_up' }] }).reason, 'rehearsal_missing')
  const kept = orchestrator.sanitizeRehearsal({ ...failed('rehearsal_parser_failed'), stdout: SECRET, failures: [{ what: 'dry run', reason: 'rehearsal_dry_run_failed', exit: 3, stderr: STDERR }] })
  assert.deepEqual(kept.failures, [{ what: 'dry run', reason: 'rehearsal_dry_run_failed', exit: 3 }])
  assert.ok(!JSON.stringify(kept).includes(SECRET) && !JSON.stringify(kept).includes(STDERR))
  for (const reason of REHEARSAL_REASONS) assert.ok(orchestrator.sanitizeRehearsal(failed(reason)).reason === reason)
})

test('a planted secret and planted stderr in a farm result reach no stored row, feedback, event or item JSON', async () => {
  seedTask('T-RH-LEAK')
  const raw = { ...failed('rehearsal_parser_failed'), output: SECRET, failures: [{ what: 'proof command 2 (metric line 1)', reason: 'rehearsal_parser_failed', exit: 5, stderr: STDERR, value: SECRET }] }
  const runId = await completePreflight('T-RH-LEAK', { preflight: PASSED, rehearsal: raw })
  const surfaces = [storedRehearsal(runId), JSON.stringify(feedbackRows('T-RH-LEAK')), JSON.stringify(events('T-RH-LEAK')), JSON.stringify(store.itemViewById('T-RH-LEAK'))]
  for (const text of surfaces) {
    assert.ok(!text.includes(SECRET), text)
    assert.ok(!text.includes(STDERR), text)
  }
})

// ==== the demo farm and the pre-pull ====

test("the demo farm's Preflight rehearses clean, so a demo Task's gate offers Approve", async () => {
  seedTask('T-RH-DEMO')
  const result = await orchestrator.MOCK_STEP_BEHAVIOR.Preflight({ id: 'T-RH-DEMO' })
  assert.deepEqual(orchestrator.sanitizeRehearsal(result.rehearsal), { clean: true, reason: null, scope: 'full', seconds: 0, failures: [] })
})

test('a changed deploy-target image asks the farm to pre-pull it; an unchanged or cleared one does not', async () => {
  const pulled = []
  const pull = async (image) => pulled.push(image)
  assert.equal(orchestrator.prePullOnImageChange('ghcr.io/acme/job:1', 'ghcr.io/acme/job:2', pull), true)
  assert.equal(orchestrator.prePullOnImageChange(null, 'ghcr.io/acme/job:1', pull), true)
  assert.equal(orchestrator.prePullOnImageChange('ghcr.io/acme/job:2', 'ghcr.io/acme/job:2', pull), false)
  assert.equal(orchestrator.prePullOnImageChange('ghcr.io/acme/job:2', null, pull), false)
  assert.equal(orchestrator.prePullOnImageChange('ghcr.io/acme/job:2', '', pull), false)
  // A refused pull is swallowed: fire and forget.
  assert.equal(orchestrator.prePullOnImageChange('a', 'b', async () => { throw new Error('farm down') }), true)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(pulled, ['ghcr.io/acme/job:2', 'ghcr.io/acme/job:1'])
})

test('Impact review still advances to Preflight, untouched by the rehearsal', async () => {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, metric) VALUES ('T-RH-IR', 't', 'High', ?, 'task', ?)").run(IMPACT_REVIEW_STEP_INDEX, METRIC)
  writePlan('T-RH-IR', PLAN())
  const runId = db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES ('T-RH-IR', ?, 1, ?, 'active')")
    .run(IMPACT_REVIEW_STEP_INDEX, STEPS[IMPACT_REVIEW_STEP_INDEX].agent).lastInsertRowid
  assert.deepEqual(await orchestrator.completeFarmRun(runId, { summary: 'reviewed', artifacts: { artifact_md: '## Verdict\n**pass**' } }), { ok: true })
  assert.equal(cursor('T-RH-IR'), PREFLIGHT_STEP_INDEX)
  assert.equal(storedRehearsal(runId), null)
})
