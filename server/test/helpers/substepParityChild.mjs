// HZ-539: one sub-step parity variant in its own process (db.js opens one
// database per process), for substep-parity.test.mjs and the golden script
// (server/scripts/substep-parity-golden.mjs). Argument:
//   'none'   — no snapshot: the switch on, a steps.json present, and every
//              item's substeps_json NULL.
//   'off'    — the switch off: the same steps.json, and every item holding a
//              snapshot of the audit sub-steps (anchored after Implement and
//              Execute) as if taken at intake while the switch was on.
//   'nodefs' — no definitions: the switch on and no steps.json at all.
//
// For every Change and Task agent step, one item sits at that step with a done
// artifact at each earlier agent step of its kind. The real orchestrator
// dispatches it to a stub farm, and every /steps/run body is recorded. Prints
// one JSON line: per step index its dispatch bodies, then each item's
// substep_cursor and step_run (step_index, substep_id) rows.

import crypto from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const variant = process.argv[2]
if (!['none', 'off', 'nodefs'].includes(variant)) throw new Error(`unknown variant ${JSON.stringify(variant)}`)
const farmDir = mkdtempSync(join(tmpdir(), `horizon-substep-parity-${variant}-farm-`))
process.env.HORIZON_FARM_DIR = farmDir
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), `horizon-substep-parity-${variant}-`)), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
process.env.FARM_STEP_TIMEOUT_MS = '600000'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.FARM_RECOVERY_POLL_MS = String(60 * 60 * 1000)
delete process.env.FARM_STEP_INDEXES
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.HORIZON_REPO

const AUDITS = [
  { id: 'impl-audit', label: 'Audit the change', kind: 'audit', anchor: 11, persona: null, output: 'findings', applies: { labels: ['valuation'], repos: [], paths: [] } },
  { id: 'exec-audit', label: 'Audit the run', kind: 'audit', anchor: 24, persona: null, output: 'findings', applies: { labels: ['valuation'], repos: [], paths: [] } },
]
if (variant !== 'nodefs') {
  mkdirSync(join(farmDir, 'projects', 'acme-capital'), { recursive: true })
  writeFileSync(join(farmDir, 'projects', 'acme-capital', 'steps.json'), JSON.stringify({ substeps: AUDITS }))
}

const { db } = await import('../../src/db.js')
const store = await import('../../src/store.js')
const orchestrator = await import('../../src/orchestrator.js')
const { STEPS, agentStepIndexes, RUN_PLAN_STEP_INDEX } = await import('../../../domain/js/lifecycle.js')

// Execute runs only on an approved run plan: the Run plan artifact every Task
// item carries, approved by its hash.
const RUN_PLAN =
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '/tmp', commands: ['scripts/a.sh'], budget_minutes: 20 }, null, 2) +
  '\n```'
const RUN_PLAN_HASH = crypto.createHash('sha256').update(RUN_PLAN, 'utf8').digest('hex')

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
if (variant === 'off') store.setProjectDefinitionsEnabled(project.id, false, 'test')

await orchestrator.init({ info: () => {}, warn: () => {}, error: () => {} })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const snapshot = (kind) => {
  const matched = AUDITS.filter((s) => (STEPS[s.anchor].itemKind ?? 'change') === kind)
  return variant === 'off' && matched.length ? JSON.stringify(matched) : null
}
const insertItem = db.prepare(
  `INSERT INTO work_item (id, title, priority, desc, metric, guardrails, project_id, cursor, kind, personas_json, substeps_json, approved_plan_hash, approved_runner)
   VALUES (?, ?, 'Medium', 'Reprice the book.', 'It reprices.', 'Nothing else moves.', ?, ?, ?, ?, ?, ?, ?)`,
)
const insertDone = db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', ?, ?, '2026-10-01 00:00:00')",
)

const steps = {}
for (const kind of ['change', 'task']) {
  const indexes = agentStepIndexes(undefined, kind)
  for (const stepIndex of indexes) {
    const id = `P-${stepIndex}`
    insertItem.run(
      id,
      `Parity at ${STEPS[stepIndex].label}`,
      project.id,
      stepIndex,
      kind,
      JSON.stringify({ eng: 'python', qa: 'data_integrity', architect: 'distributed_systems' }),
      snapshot(kind),
      kind === 'task' ? RUN_PLAN_HASH : null,
      kind === 'task' ? 'host' : null,
    )
    for (const prior of indexes.filter((i) => i < stepIndex)) {
      const artifact = prior === RUN_PLAN_STEP_INDEX ? RUN_PLAN : `## ${STEPS[prior].label}\nartifact of step ${prior}`
      insertDone.run(id, prior, STEPS[prior].agent, `did ${STEPS[prior].label}`, artifact)
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

const items = Object.fromEntries(
  Object.keys(steps).map((stepIndex) => {
    const id = `P-${stepIndex}`
    return [
      id,
      {
        substep_cursor: db.prepare('SELECT substep_cursor FROM work_item WHERE id = ?').get(id).substep_cursor,
        runs: db.prepare('SELECT step_index, substep_id FROM step_run WHERE item_id = ? ORDER BY id').all(id),
      },
    ]
  }),
)
process.stdout.write(`${JSON.stringify({ steps, items })}\n`)
process.exit(0)
