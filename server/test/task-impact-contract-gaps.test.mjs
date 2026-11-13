// HO-836: an Impact review result whose `contract_gaps` names a tool or host
// the run plan's `requires` does not declare sends the Task back to Run plan
// before Approve the run, with feedback naming each gap with its command
// index. It shares IMPACT_SENDBACK_CAP with the circular-proof send-back
// (task-impact-circular-sendback.test.mjs). A result with no gaps advances
// exactly as before.
//
// The plan and its gaps are domain/fixtures/contract-gaps-cases.json — the
// same case farm/tests/test_run_plan_requires.py asserts the farm's scan
// reports — so what the farm sends is what this test posts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-impact-gaps-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { IMPACT_SENDBACK_CAP } = await import('../src/config.js')
const { STEPS, ITEM_KINDS, stepsFor, IMPACT_REVIEW_STEP_INDEX, RUN_PLAN_STEP_INDEX, APPROVE_RUN_GATE_INDEX } = await import(
  '../../domain/js/lifecycle.js'
)

store.purgeDemoItems()

const CASE = JSON.parse(readFileSync(new URL('../../domain/fixtures/contract-gaps-cases.json', import.meta.url), 'utf8'))
const METRIC = '1. rows written\n2. no failures\n3. prices match the vendor\n4. the curve uses them\n5. spot checks hold'
const RUN_PLAN_LABEL = STEPS[RUN_PLAN_STEP_INDEX].label
const SECRETS = ['u:p', 'token=', 'Bearer', 'curl -']

function seedTask(id) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, metric) VALUES (?, ?, 'High', ?, 'task', ?)").run(
    id,
    `Task ${id}`,
    IMPACT_REVIEW_STEP_INDEX,
    METRIC,
  )
  const artifact = `## Commands\n1. \`./load.sh\`\n\n## Run plan block\n\`\`\`json run-plan\n${JSON.stringify(CASE.plan)}\n\`\`\``
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', ?, datetime('now'))").run(
    id,
    RUN_PLAN_STEP_INDEX,
    STEPS[RUN_PLAN_STEP_INDEX].agent,
    artifact,
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
const gapLine = (gap) => `- Command ${gap.command}: ${gap.kind} ${gap.name}`

test('contract gaps send the Task back to Run plan before the gate, one feedback line per gap with its command index', async () => {
  seedTask('T-GAPS')
  const runId = await completeImpact('T-GAPS', { artifact_md: '## Verdict\n**concerns**', contract_gaps: CASE.gaps })
  assert.equal(runStatus(runId), 'done')
  assert.equal(cursor('T-GAPS'), RUN_PLAN_STEP_INDEX)
  const rows = feedbackRows('T-GAPS')
  assert.equal(rows.length, 1, 'one feedback row names every gap')
  assert.equal(rows[0].target, STEPS[RUN_PLAN_STEP_INDEX].agent)
  assert.equal(rows[0].source, orchestrator.IMPACT_SENDBACK_SOURCE)
  const listed = rows[0].message.split('\n').filter((line) => line.startsWith('- '))
  assert.deepEqual(listed.sort(), CASE.gaps.map(gapLine).sort())
  assert.ok(listed.includes('- Command 2: tool jq'))
  assert.ok(listed.includes('- Command 4: service api.example.com'))
  assert.ok(
    events('T-GAPS').some(
      (t) => t.includes('4 undeclared tools or services in commands 2, 3, 4') && t.includes(`(send-back 1/${IMPACT_SENDBACK_CAP}) — sent back to “${RUN_PLAN_LABEL}”`),
    ),
  )
  // Guardrail 4: only a tool or host name and an index — never the command's
  // header, userinfo or query string.
  for (const text of [rows[0].message, ...events('T-GAPS')]) {
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} leaked into: ${text}`)
  }
})

test('the cap is shared: a circular send-back then a gap send-back, and the third result goes on to the gate', async () => {
  assert.equal(IMPACT_SENDBACK_CAP, 2)
  seedTask('T-MIXED-CAP')
  await completeImpact('T-MIXED-CAP', { artifact_md: 'x', circular_proofs: [{ line: 3, reason: 'reads its own output' }] })
  assert.equal(cursor('T-MIXED-CAP'), RUN_PLAN_STEP_INDEX)
  await completeImpact('T-MIXED-CAP', { artifact_md: 'x', contract_gaps: CASE.gaps })
  assert.equal(cursor('T-MIXED-CAP'), RUN_PLAN_STEP_INDEX, 'the gap still sends it back')
  const runId = await completeImpact('T-MIXED-CAP', { artifact_md: 'x', contract_gaps: CASE.gaps })
  assert.equal(runStatus(runId), 'done')
  assert.equal(cursor('T-MIXED-CAP'), APPROVE_RUN_GATE_INDEX)
  assert.equal(feedbackRows('T-MIXED-CAP').length, IMPACT_SENDBACK_CAP, 'no new row once the cap is reached')
})

test('gap-only: two send-backs, then the third goes on to the gate with an event naming the gap commands', async () => {
  seedTask('T-GAP-CAP')
  const gaps = [{ kind: 'tool', name: 'jq', command: 2 }]
  await completeImpact('T-GAP-CAP', { artifact_md: 'x', contract_gaps: gaps })
  await completeImpact('T-GAP-CAP', { artifact_md: 'x', contract_gaps: gaps })
  assert.equal(cursor('T-GAP-CAP'), RUN_PLAN_STEP_INDEX)
  const runId = await completeImpact('T-GAP-CAP', { artifact_md: 'x', contract_gaps: gaps })
  assert.equal(runStatus(runId), 'done')
  assert.equal(cursor('T-GAP-CAP'), APPROVE_RUN_GATE_INDEX)
  assert.equal(feedbackRows('T-GAP-CAP').length, IMPACT_SENDBACK_CAP)
  assert.ok(
    events('T-GAP-CAP').some(
      (t) => t.includes('1 undeclared tool or service in command 2') && t.includes(`cap (${IMPACT_SENDBACK_CAP}) is reached`),
    ),
  )
})

for (const [name, artifacts] of [
  ['an empty contract_gaps list', { artifact_md: '## Verdict\n**pass**', contract_gaps: [] }],
  ['no contract_gaps key', { artifact_md: '## Verdict\n**pass**' }],
]) {
  test(`a fully declared plan (${name}) advances to Approve the run with no feedback`, async () => {
    const id = `T-DECLARED-${name.length}`
    seedTask(id)
    const runId = await completeImpact(id, artifacts)
    assert.equal(runStatus(runId), 'done')
    assert.equal(cursor(id), APPROVE_RUN_GATE_INDEX)
    assert.deepEqual(feedbackRows(id), [])
  })
}

for (const [n, [name, gap]] of [
  ['a name holding command text', { kind: 'tool', name: 'jq; rm -rf /', command: 1 }],
  ['an unknown kind', { kind: 'binary', name: 'jq', command: 1 }],
  ['command 0', { kind: 'tool', name: 'jq', command: 0 }],
  ['a command index as a string', { kind: 'tool', name: 'jq', command: '1' }],
].entries()) {
  test(`a bad gap shape (${name}) is ignored: no row, on to the gate, and its name in no event`, async () => {
    const id = `T-BAD-${n}`
    seedTask(id)
    await completeImpact(id, { artifact_md: 'x', contract_gaps: [gap] })
    assert.equal(cursor(id), APPROVE_RUN_GATE_INDEX)
    assert.deepEqual(feedbackRows(id), [])
    assert.ok(!events(id).some((t) => t.includes('rm -rf') || t.includes('undeclared')))
  })
}

test('only a Task reaches Impact review: its step index belongs to the task kind alone', () => {
  for (const kind of ITEM_KINDS) {
    const owns = stepsFor(kind).some((step) => step.index === IMPACT_REVIEW_STEP_INDEX)
    assert.equal(owns, kind === 'task', `${kind} ${owns ? 'owns' : 'does not own'} the Impact review step`)
  }
})
