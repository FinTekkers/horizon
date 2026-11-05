// HZ-770: an Impact review result that flags a metric line's proof as
// circular sends the Task back to Run plan before Approve the run, with
// feedback naming each line. At most IMPACT_SENDBACK_CAP times: after that the
// item goes on to the gate and a human decides. A result with no flags
// advances exactly as before.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-impact-circular-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { IMPACT_SENDBACK_CAP } = await import('../src/config.js')
const { mintHumanProof } = await import('../src/humanProof.js')
const { STEPS, IMPACT_REVIEW_STEP_INDEX, RUN_PLAN_STEP_INDEX, APPROVE_RUN_GATE_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const METRIC = '1. rows written\n2. no failures\n3. prices match the vendor\n4. the curve uses them\n5. spot checks hold'
const PLAN = (proof) =>
  `## Commands\n1. \`./load.sh\`\n\n## Run plan block\n\`\`\`json run-plan\n${JSON.stringify({ cwd: '.', commands: ['./load.sh', './check.sh'], budget_minutes: 5, ...(proof ? { proof } : {}) })}\n\`\`\``

function seedTask(id, proof = [1, 2, 3, 4, 5].map((line) => ({ line, command: 2 }))) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, metric) VALUES (?, ?, 'High', ?, 'task', ?)").run(
    id,
    `Task ${id}`,
    IMPACT_REVIEW_STEP_INDEX,
    METRIC,
  )
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', ?, datetime('now'))").run(
    id,
    RUN_PLAN_STEP_INDEX,
    STEPS[RUN_PLAN_STEP_INDEX].agent,
    PLAN(proof),
  )
}

// An active Impact review run, as a dispatch leaves it, with the cursor on it.
function activeImpactRun(id) {
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(IMPACT_REVIEW_STEP_INDEX, id)
  db.prepare("UPDATE step_run SET status = 'superseded' WHERE item_id = ? AND status = 'active'").run(id)
  const attempt = db.prepare('SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND step_index = ?').get(id, IMPACT_REVIEW_STEP_INDEX).n + 1
  return db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, ?, ?, 'active')")
    .run(id, IMPACT_REVIEW_STEP_INDEX, attempt, STEPS[IMPACT_REVIEW_STEP_INDEX].agent).lastInsertRowid
}

async function completeImpact(id, artifacts) {
  const runId = activeImpactRun(id)
  assert.deepEqual(await orchestrator.completeFarmRun(runId, { summary: 'reviewed the run plan', artifacts }), { ok: true })
  return runId
}

const runStatus = (runId) => db.prepare('SELECT status FROM step_run WHERE id = ?').get(runId).status
const cursor = (id) => db.prepare('SELECT cursor FROM work_item WHERE id = ?').get(id).cursor
const feedbackRows = (id) => db.prepare('SELECT target, message, source FROM feedback WHERE item_id = ? ORDER BY id').all(id)
const events = (id) => db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all(id).map((e) => e.text)

const FLAG_3_AND_5 = [
  { line: 5, reason: 'counts the rows the loader just inserted' },
  { line: 3, reason: "re-parses the loader's own output file" },
]

test('a circular proof for lines 3 and 5 sends the Task back to Run plan, naming both, with the run done', async () => {
  seedTask('T-CIRC')
  const runId = await completeImpact('T-CIRC', { artifact_md: '## Verdict\n**concerns**', circular_proofs: FLAG_3_AND_5 })
  assert.equal(runStatus(runId), 'done')
  assert.equal(cursor('T-CIRC'), RUN_PLAN_STEP_INDEX)
  assert.notEqual(cursor('T-CIRC'), APPROVE_RUN_GATE_INDEX)
  const rows = feedbackRows('T-CIRC')
  assert.equal(rows.length, 1, 'one feedback row names every flagged line')
  assert.equal(rows[0].target, STEPS[RUN_PLAN_STEP_INDEX].agent)
  assert.equal(rows[0].source, orchestrator.IMPACT_SENDBACK_SOURCE)
  assert.match(rows[0].message, /circular proof for metric lines 3, 5\b/)
  assert.match(rows[0].message, /Line 3: re-parses the loader's own output file/)
  assert.match(rows[0].message, /Line 5: counts the rows the loader just inserted/)
  assert.ok(events('T-CIRC').some((t) => t.includes('circular proof for metric lines 3, 5') && t.includes(`sent back to “${STEPS[RUN_PLAN_STEP_INDEX].label}”`)))
})

test('a flag for line 3 alone names line 3 in the send-back reason', async () => {
  seedTask('T-CIRC-ONE')
  await completeImpact('T-CIRC-ONE', { artifact_md: '## Verdict\n**concerns**', circular_proofs: [{ line: 3, reason: 'reads its own report' }] })
  assert.equal(cursor('T-CIRC-ONE'), RUN_PLAN_STEP_INDEX)
  assert.match(feedbackRows('T-CIRC-ONE')[0].message, /circular proof for metric line 3\./)
})

for (const [name, artifacts] of [
  ['an empty circular_proofs list', { artifact_md: '## Verdict\n**pass**', circular_proofs: [] }],
  ['no circular_proofs key', { artifact_md: '## Verdict\n**pass**' }],
]) {
  test(`${name} advances to Approve the run as before`, async () => {
    const id = `T-CLEAN-${name.length}`
    seedTask(id)
    const runId = await completeImpact(id, artifacts)
    assert.equal(runStatus(runId), 'done')
    assert.equal(cursor(id), APPROVE_RUN_GATE_INDEX)
    assert.deepEqual(feedbackRows(id), [])
  })
}

test('the cap: flags 1 and 2 send the Task back, flag 3 goes on to the gate naming the lines; a human Reject does not count', async () => {
  assert.equal(IMPACT_SENDBACK_CAP, 2)
  seedTask('T-CAP')
  const flagged = { artifact_md: '## Verdict\n**concerns**', circular_proofs: [{ line: 3, reason: 'reads its own output' }] }

  await completeImpact('T-CAP', flagged)
  assert.equal(cursor('T-CAP'), RUN_PLAN_STEP_INDEX)

  // A human Reject with feedback at Approve the run: its feedback row is not
  // an Impact review send-back.
  db.prepare("UPDATE step_run SET status = 'superseded' WHERE item_id = ? AND status = 'active'").run('T-CAP')
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(APPROVE_RUN_GATE_INDEX, 'T-CAP')
  assert.deepEqual(store.requestChanges('T-CAP', 'Run plan', 'use the vendor file for line 3'), { ok: true })

  await completeImpact('T-CAP', flagged)
  assert.equal(cursor('T-CAP'), RUN_PLAN_STEP_INDEX, 'the second flag still sends it back')

  const runId = await completeImpact('T-CAP', flagged)
  assert.equal(runStatus(runId), 'done')
  assert.equal(cursor('T-CAP'), APPROVE_RUN_GATE_INDEX, 'the third flag goes on to the gate')
  const sources = feedbackRows('T-CAP').map((r) => r.source)
  assert.equal(sources.filter((s) => s === orchestrator.IMPACT_SENDBACK_SOURCE).length, IMPACT_SENDBACK_CAP)
  assert.ok(sources.includes('ui'), "the human's feedback row is there, untagged")
  assert.ok(events('T-CAP').some((t) => t.includes('circular proof for metric line 3') && t.includes(`cap (${IMPACT_SENDBACK_CAP}) is reached`)))
})

test('a plan written before the proof map still shows on the card, with its uncovered lines, and still approves', async () => {
  seedTask('T-OLD', null)
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(APPROVE_RUN_GATE_INDEX, 'T-OLD')
  const view = store.itemViewById('T-OLD')
  assert.equal(view.runPlan.commands, 2)
  assert.deepEqual(view.runPlan.uncoveredLines, [1, 2, 3, 4, 5])
  const proof = mintHumanProof({ userId: 1 })
  const res = store.approveGate('T-OLD', APPROVE_RUN_GATE_INDEX, '', 'Owner', { proof, planHash: view.runPlan.hash, runner: view.runPlan.runner })
  assert.equal(res.error, undefined, JSON.stringify(res))
  assert.equal(db.prepare('SELECT approved_plan_hash FROM work_item WHERE id = ?').get('T-OLD').approved_plan_hash, view.runPlan.hash)
})

test('a fully proved plan shows no uncovered lines', () => {
  seedTask('T-FULL')
  db.prepare('UPDATE work_item SET cursor = ? WHERE id = ?').run(APPROVE_RUN_GATE_INDEX, 'T-FULL')
  assert.deepEqual(store.itemViewById('T-FULL').runPlan.uncoveredLines, [])
})
