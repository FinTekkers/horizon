// HZ-771: every Change and Task agent step dispatched in its own process
// (db.js opens one database per process), for verify-evidence-files.test.mjs
// and the golden script (server/scripts/hz-771-prompts-before.mjs).
//
// For every agent step, one item sits at that step with a big done artifact at
// each earlier agent step of its kind, so the later steps' inputs are over
// TOTAL_ARTIFACT_BUDGET_CHARS and get digested. A Task item's Execute artifact
// is the 300 KB log whose only failure is its last command. The real
// orchestrator dispatches each item to a stub farm; prints one JSON line: per
// step index its /steps/run bodies.

import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_FARM_DIR = mkdtempSync(join(tmpdir(), 'horizon-hz771-prompts-farm-'))
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-hz771-prompts-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
process.env.FARM_STEP_TIMEOUT_MS = '600000'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.FARM_RECOVERY_POLL_MS = String(60 * 60 * 1000)
delete process.env.FARM_STEP_INDEXES
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.HORIZON_REPO

const { db } = await import('../../src/db.js')
const store = await import('../../src/store.js')
const orchestrator = await import('../../src/orchestrator.js')
const { STEPS, agentStepIndexes, RUN_PLAN_STEP_INDEX, EXECUTE_STEP_INDEX } = await import('../../../domain/js/lifecycle.js')

const COMMANDS = Array.from({ length: 10 }, (_, i) => `python3 step${i + 1}.py`)
const RUN_PLAN =
  '## Commands\n' +
  COMMANDS.map((c, i) => `${i + 1}. ${c}`).join('\n') +
  '\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands: COMMANDS, budget_minutes: 30 }, null, 2) +
  '\n```'
const RUN_PLAN_HASH = crypto.createHash('sha256').update(RUN_PLAN, 'utf8').digest('hex')

// The Execute artifact as farm/farmd.py's job_artifact_md renders it: ten
// commands, only the last one failed, then ~300 KB of this attempt's log.
function executeArtifact() {
  const lines = COMMANDS.map((c, i) => `- exit ${i === COMMANDS.length - 1 ? 1 : 0} — \`${c}\``)
  const log = COMMANDS.map(
    (c, i) =>
      `$ ${c}\n` +
      Array.from({ length: 1300 }, (_, n) => `step${i + 1} row ${n} loaded ok\n`).join('') +
      (i === COMMANDS.length - 1 ? 'ERROR: step10 row 1300 checksum mismatch\nexit 1\n' : 'exit 0\n'),
  ).join('')
  return `## Commands\n10 command(s) run, 9 passed, 1 failed\n${lines.join('\n')}\n\n## Log (this attempt)\n${log}\n`
}

const priorArtifact = (index) => {
  if (index === RUN_PLAN_STEP_INDEX) return RUN_PLAN
  if (index === EXECUTE_STEP_INDEX) return executeArtifact()
  return `## ${STEPS[index].label}\n` + `artifact of step ${index}. `.repeat(900)
}

const posts = []
globalThis.fetch = async (url, opts) => {
  const path = new URL(String(url)).pathname
  const body = opts?.body ? JSON.parse(opts.body) : null
  if (path === '/steps/run') posts.push(body)
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data })
  if (path === '/farm/status') return reply(200, { status: 'running' })
  if (path === '/runs/alive') return reply(200, { alive: Object.fromEntries((body.run_ids || []).map((id) => [id, true])) })
  return reply(200, { ok: true })
}

store.purgeDemoItems()
const project = store.createProject('Acme Capital')
// Quiet: the budget logs one line per dispatch, and stdout carries the result.
const log = console.log
console.log = () => {}
await orchestrator.init({ info: () => {}, warn: () => {}, error: () => {} })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const insertItem = db.prepare(
  `INSERT INTO work_item (id, title, priority, desc, metric, guardrails, project_id, cursor, kind, approved_plan_hash, approved_runner)
   VALUES (?, ?, 'High', 'Backfill the book.', 'It backfills.', 'Nothing else moves.', ?, ?, ?, ?, ?)`,
)
const insertDone = db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', ?, ?, '2026-11-01 00:00:00')",
)

const steps = {}
for (const kind of ['change', 'task']) {
  const indexes = agentStepIndexes(undefined, kind)
  for (const stepIndex of indexes) {
    const id = `B-${stepIndex}`
    insertItem.run(
      id,
      `Budget at ${STEPS[stepIndex].label}`,
      project.id,
      stepIndex,
      kind,
      kind === 'task' ? RUN_PLAN_HASH : null,
      kind === 'task' ? 'host' : null,
    )
    for (const prior of indexes.filter((i) => i < stepIndex)) {
      insertDone.run(id, prior, STEPS[prior].agent, `did ${STEPS[prior].label}`, priorArtifact(prior))
    }
    const before = posts.length
    orchestrator.kick(id)
    const deadline = Date.now() + 2000
    while (posts.length === before && Date.now() < deadline) await wait(10)
    await wait(20)
    orchestrator.cancel(id)
    steps[stepIndex] = posts.slice(before)
  }
}

console.log = log
// Exits once the pipe has taken it all: the bodies run to megabytes.
process.stdout.write(`${JSON.stringify({ steps })}\n`, () => process.exit(0))
