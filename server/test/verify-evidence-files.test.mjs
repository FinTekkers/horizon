// HZ-771: Verify & report gets the Run plan and this attempt's Execute log
// whole, in the /steps/run `evidence` list the farm writes to files, never
// through the 60,000-char prompt budget. Every other step dispatches exactly
// what main did (server/test/fixtures/hz-771-prompts-before.json, written on
// main by server/scripts/hz-771-prompts-before.mjs).
//
// Its own file because config.js reads the environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-verify-evidence-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const BUDGET = 60000

const dispatches = []
globalThis.fetch = async (url, opts) => {
  dispatches.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  if (String(url).includes('/preflight') || (typeof u !== 'undefined' && String(u).includes('/preflight'))) return { ok: true, status: 200, json: async () => ({ ok: true, failed: [], unmet: [], elapsed_ms: 0 }) }
  return { ok: true, status: 200, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { runChild, digestBody } = await import('../scripts/hz-771-prompts-before.mjs')
const { STEPS, ASSESS_STEP_INDEX, EXECUTE_STEP_INDEX, PREFLIGHT_STEP_INDEX, RUN_PLAN_STEP_INDEX, VERIFY_REPORT_STEP_INDEX } =
  await import('../../domain/js/lifecycle.js')

// HO-837: Preflight's insertion moved Execute from 24 to 25, so its golden
// entry moved with it. Its body differs from main's only in what the
// position names: step.index, the seeded item's id (B-<index>) and run_id.

store.purgeDemoItems()
after(() => db.close())

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const activeRun = (id) => db.prepare("SELECT id, step_index FROM step_run WHERE item_id = ? AND status = 'active'").get(id)
const verifyDispatch = (id) =>
  dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === id && d.body?.step?.index === VERIFY_REPORT_STEP_INDEX)

const COMMANDS = Array.from({ length: 10 }, (_, i) => `python3 step${i + 1}.py`)
const PLAN =
  '## Commands\n1. load the book\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands: COMMANDS, budget_minutes: 30 }, null, 2) +
  '\n```'

// ~300 KB, only the last command failed; non-ASCII, a CRLF line and no
// trailing newline, so a byte-for-byte hand-off is really tested.
function bigExecute(tag = 'attempt 1') {
  const lines = COMMANDS.map((c, i) => `- exit ${i === 9 ? 1 : 0} — \`${c}\``)
  let log = ''
  for (let n = 0; log.length < 300 * 1024; n++) log += `step${1 + (n % 9)} row ${n} prix chargé ✅ ${tag}\n`
  return (
    `## Commands\n10 command(s) run, 9 passed, 1 failed\n${lines.join('\n')}\n\n` +
    `## Log (this attempt)\n${log}$ python3 step10.py\r\nERROR: step10 checksum mismatch 🚨\nexit 1`
  )
}

function seedTask(id, cursor) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, approved_plan_hash, approved_runner) VALUES (?, ?, 'High', ?, 'task', ?, 'host')").run(
    id,
    `Task ${id}`,
    cursor,
    sha256(PLAN),
  )
}

function doneRow(id, stepIndex, artifact, attempt = 1) {
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, ?, ?, 'done', 'ok', ?, datetime('now'))",
  ).run(id, stepIndex, attempt, STEPS[stepIndex].agent, artifact)
}

const storedArtifact = (id, stepIndex) =>
  db.prepare("SELECT artifact FROM step_run WHERE item_id = ? AND step_index = ? AND status = 'done' ORDER BY id DESC LIMIT 1").get(id, stepIndex)
    .artifact

test('metrics 1 and 2: Verify gets the stored Run plan and Execute artifacts whole as evidence, and neither in its budgeted inputs', async () => {
  const id = 'T-771'
  seedTask(id, EXECUTE_STEP_INDEX)
  doneRow(id, ASSESS_STEP_INDEX, 'assess: the scripts exist')
  doneRow(id, RUN_PLAN_STEP_INDEX, PLAN)
  orchestrator.kick(id)
  await wait(30)
  const jobRun = activeRun(id)
  assert.equal(jobRun.step_index, EXECUTE_STEP_INDEX)
  const execute = bigExecute()
  await orchestrator.completeFarmRun(jobRun.id, { summary: '10 command(s) run, 9 passed, 1 failed', artifacts: { artifact_md: execute } })
  await wait(30)

  const dispatch = verifyDispatch(id)
  assert.ok(dispatch, 'Verify & report was dispatched')
  const run = db.prepare('SELECT status, output FROM step_run WHERE item_id = ? AND step_index = ?').get(id, VERIFY_REPORT_STEP_INDEX)
  assert.equal(run.status, 'active', `no REQUIRED_INPUT_INCOMPLETE or other refusal: ${JSON.stringify(run)}`)

  // R3: strictly equal to the rows read back from the DB.
  const { evidence, artifacts } = dispatch.body
  assert.deepStrictEqual(evidence, [
    { label: 'Run plan', stepIndex: RUN_PLAN_STEP_INDEX, content: storedArtifact(id, RUN_PLAN_STEP_INDEX) },
    { label: 'Execute', stepIndex: EXECUTE_STEP_INDEX, content: storedArtifact(id, EXECUTE_STEP_INDEX) },
  ])
  assert.equal(evidence[1].content, execute, 'the stored artifact is the one Execute reported')
  assert.ok(Buffer.byteLength(execute, 'utf8') > 300 * 1024 && execute.length > BUDGET)

  // The budgeted inputs carry neither, and no notice.
  assert.deepEqual(
    artifacts.map((a) => a.label),
    ['Assess'],
  )
  const sent = JSON.stringify(artifacts)
  assert.ok(!sent.includes('checksum mismatch') && !sent.includes('json run-plan'))
  assert.ok(!sent.includes('Truncation notice'))
})

test('guardrail 2: only the current Execute attempt rides in evidence', async () => {
  const id = 'T-771-R4'
  seedTask(id, VERIFY_REPORT_STEP_INDEX)
  doneRow(id, RUN_PLAN_STEP_INDEX, PLAN)
  doneRow(id, EXECUTE_STEP_INDEX, '## Commands\n1 command(s) run, 0 passed, 1 failed\n\n## Log (this attempt)\nATTEMPT-ONE-FAILED\n', 1)
  doneRow(id, EXECUTE_STEP_INDEX, bigExecute('attempt 2'), 2)
  orchestrator.kick(id)
  await wait(30)
  const dispatch = verifyDispatch(id)
  assert.ok(dispatch, 'Verify & report was dispatched')
  const execute = dispatch.body.evidence.filter((e) => e.stepIndex === EXECUTE_STEP_INDEX)
  assert.equal(execute.length, 1)
  assert.equal(execute[0].content, bigExecute('attempt 2'))
  assert.ok(!JSON.stringify(dispatch.body).includes('ATTEMPT-ONE-FAILED'), 'no attempt 1 text anywhere in the dispatch')
})

test('splitVerifyEvidence takes only the Run plan and Execute rows, in order, and leaves the rest', () => {
  const rows = [
    { step_index: ASSESS_STEP_INDEX, artifact: 'a' },
    { step_index: RUN_PLAN_STEP_INDEX, artifact: 'p' },
    { step_index: EXECUTE_STEP_INDEX, artifact: 'e' },
  ]
  const { evidence, rest } = orchestrator.splitVerifyEvidence(rows)
  assert.deepEqual(orchestrator.VERIFY_EVIDENCE_STEP_INDEXES, [RUN_PLAN_STEP_INDEX, EXECUTE_STEP_INDEX])
  assert.deepEqual(rest, [rows[0]])
  assert.deepEqual(
    evidence.map((e) => [e.stepIndex, e.content]),
    [
      [RUN_PLAN_STEP_INDEX, 'p'],
      [EXECUTE_STEP_INDEX, 'e'],
    ],
  )
})

// HZ-801 adds each stored input's artifact page `url` and the step's own
// `artifact_url` to every agent dispatch (a job dispatch has neither). Both
// are pinned here, then taken out so the rest of the body is still compared
// with main's byte for byte.
function withoutArtifactUrls(body, index) {
  const page = (step) => new RegExp(`^https?://\\S+/api/items/${body.item.id}/artifacts/${step}$`)
  if (body.artifact_url !== undefined) assert.match(body.artifact_url, page(index))
  const artifacts = (body.artifacts || []).map(({ url, ...input }) => {
    if (url !== undefined) assert.match(url, page('\\d+'))
    return input
  })
  return Object.fromEntries(
    Object.entries(body)
      .filter(([key]) => key !== 'artifact_url')
      .map(([key, value]) => [key, key === 'artifacts' ? artifacts : value]),
  )
}

test("metric 3 and guardrail 4: every other step's /steps/run body is main's, budget and digest included", () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/hz-771-prompts-before.json', import.meta.url), 'utf8'))
  const steps = runChild()

  const verify = steps[VERIFY_REPORT_STEP_INDEX]
  assert.equal(verify.length, 1, 'Verify was dispatched for the same seeding')
  assert.ok(!(String(VERIFY_REPORT_STEP_INDEX) in golden.steps))
  delete steps[VERIFY_REPORT_STEP_INDEX]

  // HO-837: Preflight is new — a code-run dispatch with no inputs, no
  // feedback and the plan's hash, and no counterpart on main.
  const preflight = steps[PREFLIGHT_STEP_INDEX]
  assert.equal(preflight.length, 1, 'Preflight was dispatched for the same seeding')
  assert.deepEqual(preflight[0].artifacts, [])
  assert.deepEqual(preflight[0].feedback, [])
  assert.match(preflight[0].plan_hash, /^[0-9a-f]{64}$/)
  assert.ok(!('evidence' in preflight[0]) && !('providerChoices' in preflight[0].item))
  delete steps[PREFLIGHT_STEP_INDEX]

  assert.deepEqual(Object.keys(steps), Object.keys(golden.steps))
  for (const [index, bodies] of Object.entries(steps)) {
    assert.deepStrictEqual(
      bodies.map((body) => digestBody(withoutArtifactUrls(body, Number(index)))),
      golden.steps[index],
      `step ${index} (${STEPS[index].label})`,
    )
    for (const body of bodies) assert.ok(!('evidence' in body), `step ${index} carries no evidence`)
  }

  // Still capped: Run plan's inputs are over the budget and are digested to it.
  const [runPlan] = steps[RUN_PLAN_STEP_INDEX]
  const kept = runPlan.artifacts.reduce((sum, a) => sum + a.content.split('\n\n[...reduced:')[0].length, 0)
  assert.ok(runPlan.artifacts.some((a) => a.content.includes('\n\n[...reduced:')), 'an over-budget step is still digested')
  assert.ok(kept <= BUDGET, `kept ${kept} chars, over ${BUDGET}`)

  // And Verify, for the same item: the 300 KB log whole, nothing of it budgeted.
  const [body] = verify
  const execute = body.evidence.find((e) => e.stepIndex === EXECUTE_STEP_INDEX).content
  assert.ok(execute.length > 300 * 1024 && execute.includes('ERROR: step10 row 1300 checksum mismatch'))
  assert.ok(!body.artifacts.some((a) => a.label === 'Execute' || a.label === 'Run plan'))
})