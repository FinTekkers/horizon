// HZ-434: when Verify & report's input is cut to fit the context budget,
// the dispatched inputs say so first — which section, how many bytes, where
// the whole text is — and tell Verify to say so in its summary. A report
// section is kept whole or named as omitted, never cut.
// No other step gets a notice, and the 60,000-char budget is not raised.
// HZ-771: the Run plan and Execute go to Verify whole, as files, so the cut
// input here is an oversized Assess artifact.
//
// Its own file because config.js reads the environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-verify-truncation-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const BUDGET = 60000

const dispatches = []
globalThis.fetch = async (url, opts) => {
  dispatches.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  return { ok: true, status: 200, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { STEPS, ASSESS_STEP_INDEX, EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX, VERIFY_REPORT_STEP_INDEX, kindStepIndex } = await import(
  '../../domain/js/lifecycle.js'
)

store.purgeDemoItems()
after(() => db.close())

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const activeRun = (id) => db.prepare("SELECT id, step_index FROM step_run WHERE item_id = ? AND status = 'active'").get(id)
const stepDispatch = (id, stepIndex) =>
  dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === id && d.body?.step?.index === stepIndex)
const totalChars = (artifacts) => artifacts.reduce((sum, a) => sum + a.content.length, 0)

const PLAN =
  '## Commands\n1. load\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands: ['python3 load.py --report /tmp/mdi-51-run1.json'], budget_minutes: 20 }, null, 2) +
  '\n```'

function seedTaskRow(id, cursor, approvedHash = null) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, approved_plan_hash, approved_runner) VALUES (?, ?, 'High', ?, 'task', ?, ?)").run(
    id,
    `Task ${id}`,
    cursor,
    approvedHash,
    approvedHash ? 'host' : null,
  )
}

function doneRow(id, stepIndex, artifact) {
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
  ).run(id, stepIndex, STEPS[stepIndex].agent, artifact)
}

// Runs Execute to completion with `artifact`, then returns Verify's dispatch.
// `assess`, when given, is a done Assess artifact before the Run plan.
async function verifyDispatchFor(id, artifact, assess = null) {
  seedTaskRow(id, EXECUTE_STEP_INDEX, sha256(PLAN))
  if (assess !== null) doneRow(id, ASSESS_STEP_INDEX, assess)
  doneRow(id, RUN_PLAN_STEP_INDEX, PLAN)
  orchestrator.kick(id)
  await wait(30)
  const jobRun = activeRun(id)
  assert.equal(jobRun.step_index, EXECUTE_STEP_INDEX)
  await orchestrator.completeFarmRun(jobRun.id, { summary: '1 command(s) run, 1 passed, 0 failed', artifacts: { artifact_md: artifact } })
  await wait(30)
  const dispatch = stepDispatch(id, VERIFY_REPORT_STEP_INDEX)
  assert.ok(dispatch, 'Verify & report was dispatched')
  return dispatch.body
}

// A report the way farm/job_reports.py renders one: a `Report: ` heading and
// a fenced body. Its lines hold `# ` text a heading split must not cut on.
const reportBody = (tag) =>
  JSON.stringify({ tag, rows: Array.from({ length: 700 }, (_, i) => `${tag}-row-${i}`) }, null, 1) + `\n# not a heading ${tag}\n`
const reportSection = (path, body) => `### Report: ${path}\n\ninlined, ${Buffer.byteLength(body)} bytes\n\`\`\`\n${body}\`\`\``

test('R3: an over-budget Verify dispatch puts the notice first, names the cut, and keeps each report whole or omitted', async () => {
  const reports = ['/tmp/a.json', '/tmp/b.json', '/tmp/c.json', '/tmp/d.json'].map((path) => ({ path, body: reportBody(path) }))
  const log = 'déjà vu — prices checked é\n'.repeat(3000)
  const assess =
    '## Assess\nThe scripts exist.\n\n' +
    `## Reports\n\n${reports.map((r) => reportSection(r.path, r.body)).join('\n\n')}\n\n` +
    `## Notes\n${log}`
  const execute = '## Commands\n1 command(s) run, 1 passed, 0 failed\n\n## Log (this attempt)\nok\n'
  assert.ok(assess.length > BUDGET, 'sanity: the inputs really are over the budget')

  const { artifacts, evidence } = await verifyDispatchFor('T-TRUNC', execute, assess)
  assert.deepEqual(
    evidence.map((e) => e.label),
    ['Run plan', 'Execute'],
    'the Run plan and Execute ride whole, as evidence',
  )

  // The notice comes first and is within the budget with everything else.
  assert.equal(artifacts[0].label, orchestrator.TRUNCATION_NOTICE_LABEL)
  assert.equal(artifacts[0].label, 'Truncation notice')
  // HZ-801: only a stored input links its artifact page; the notice and the
  // HZ-771 evidence rows are synthetic and carry no url.
  assert.ok(!Object.hasOwn(artifacts[0], 'url'), 'the truncation notice has no url')
  for (const e of evidence) assert.ok(!Object.hasOwn(e, 'url'), `evidence row ${e.label} has no url`)
  assert.ok(artifacts.find((a) => a.label === 'Assess').url.endsWith(`/api/items/T-TRUNC/artifacts/${ASSESS_STEP_INDEX}`))
  assert.ok(totalChars(artifacts) <= BUDGET, `inputs total ${totalChars(artifacts)} chars, over ${BUDGET}`)
  assert.ok(artifacts[0].content.length <= orchestrator.TRUNCATION_NOTICE_MAX_CHARS)

  // It names the section, the bytes cut (bytes, not chars: the text is
  // multi-byte), where the whole artifact is, and the summary instruction.
  const sent = artifacts.find((a) => a.label === 'Assess').content
  const kept = sent.slice(0, sent.lastIndexOf('\n\n[...reduced:'))
  const fullBytes = Buffer.byteLength(assess, 'utf8')
  const cutBytes = fullBytes - Buffer.byteLength(kept, 'utf8')
  assert.notEqual(cutBytes, assess.length - kept.length, 'sanity: bytes and chars differ for this text')
  const notice = artifacts[0].content
  assert.ok(
    notice.includes(`**Assess**: cut ${cutBytes.toLocaleString('en-US')} of ${fullBytes.toLocaleString('en-US')} bytes`),
    notice,
  )
  assert.ok(notice.includes(`/api/items/T-TRUNC/artifacts/${ASSESS_STEP_INDEX}`))
  assert.ok(!notice.includes('**Execute**') && !notice.includes('**Run plan**'), 'evidence files are never named as cut')
  assert.ok(notice.includes('Say in your summary that this input was truncated, and name the section.'))
  assert.ok(notice.includes(`${BUDGET}-char context budget`))

  // Every report is whole or named as omitted — never a partial body.
  let whole = 0
  for (const { path, body } of reports) {
    const marker = sent.slice(sent.lastIndexOf('\n\n[...reduced:'))
    if (sent.includes(body)) {
      whole++
    } else {
      assert.ok(!sent.includes(`"tag": "${path}"`), `${path} was cut mid-file`)
      assert.ok(marker.includes(`"Report: ${path}"`), `${path} is not named as omitted: ${marker}`)
    }
  }
  assert.ok(whole > 0 && whole < reports.length, `sanity: some reports fit and some did not (${whole} whole)`)
})

test('R4: a Verify dispatch that fits gets no notice', async () => {
  const { artifacts, evidence } = await verifyDispatchFor('T-FITS', '## Commands\n1 command(s) run\n\n## Log (this attempt)\nok\n')
  assert.ok(!artifacts.some((a) => a.label === 'Truncation notice'))
  assert.deepEqual(artifacts, [])
  assert.deepEqual(
    evidence.map((e) => e.label),
    ['Run plan', 'Execute'],
  )
})

test('R4: a non-Verify Task step over budget gets no notice and the whole budget', async () => {
  const id = 'T-OTHER'
  seedTaskRow(id, RUN_PLAN_STEP_INDEX)
  // Two big early Task rows, then the small Assess row Run plan requires.
  const [first, second] = STEPS.flatMap((step, i) => (step.itemKind === 'task' ? [i] : []))
  doneRow(id, first, 'x'.repeat(50000))
  doneRow(id, second, 'y'.repeat(50000))
  doneRow(id, kindStepIndex(STEPS[RUN_PLAN_STEP_INDEX].requires[0], 'task'), 'assess: scripts/load.py exists')
  orchestrator.kick(id)
  await wait(30)
  const dispatch = stepDispatch(id, RUN_PLAN_STEP_INDEX)
  assert.ok(dispatch, 'Run plan was dispatched')
  const { artifacts } = dispatch.body
  assert.ok(!artifacts.some((a) => a.label === 'Truncation notice'))
  const keptChars = artifacts.reduce((sum, a) => sum + a.content.split('\n\n[...reduced:')[0].length, 0)
  assert.ok(keptChars > BUDGET - orchestrator.TRUNCATION_NOTICE_MAX_CHARS, `kept ${keptChars}: a reserve was taken off a non-Verify step`)
  assert.ok(keptChars <= BUDGET)
})

test('R4: budgetArtifacts takes no reserve unless asked, and none while the total fits', () => {
  const rows = [
    { step_index: RUN_PLAN_STEP_INDEX, artifact: 'p'.repeat(40000) },
    { step_index: EXECUTE_STEP_INDEX, artifact: 'e'.repeat(40000) },
  ]
  const kept = (budgeted) => budgeted.reduce((sum, b) => sum + b.content.split('\n\n[...reduced:')[0].length, 0)
  assert.ok(kept(orchestrator.budgetArtifacts(rows)) > BUDGET - 2)
  assert.ok(kept(orchestrator.budgetArtifacts(rows, { reserveChars: 1500 })) <= BUDGET - 1500)
  const small = [{ step_index: EXECUTE_STEP_INDEX, artifact: 'fits' }]
  assert.deepEqual(orchestrator.budgetArtifacts(small, { reserveChars: 1500 })[0].content, 'fits')
  assert.equal(orchestrator.budgetVerifyInputs('T-X', small).notice, null)
})
