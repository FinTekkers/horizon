// HZ-538: one intake scenario in its own process (db.js opens one database per
// process), for substeps-intake.test.mjs. Argument: 'on' | 'off' | 'none' |
// 'bad' — definitions present with the switch on, present with it off, no
// file, or a file that fails to load.
//
// The real store and orchestrator run against a stub farm (globalThis.fetch):
// each issue is synced in through store.upsertFromGithub, the orchestrator
// dispatches its first step, and the /steps/run body is recorded. Prints one
// JSON line: per item its sub-step columns, cursor, step_run rows and
// dispatch body; every steps.json read; every console.error line.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scenario = process.argv[2]
const farmDir = mkdtempSync(join(tmpdir(), `horizon-substeps-intake-${scenario}-farm-`))
process.env.HORIZON_FARM_DIR = farmDir
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), `horizon-substeps-intake-${scenario}-`)), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
process.env.FARM_STEP_TIMEOUT_MS = '600000'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.FARM_RECOVERY_POLL_MS = String(60 * 60 * 1000)
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.HORIZON_REPO

export const DEFINITIONS = {
  substeps: [
    { id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: 1, persona: 'data_integrity', output: 'golden_cases', applies: { labels: ['valuation'] } },
    { id: 'impl-audit', label: 'Audit the change', kind: 'audit', anchor: 11, output: 'findings', applies: { labels: ['valuation'] } },
    { id: 'ledger-opening', label: 'Ledger invariants', kind: 'opening', anchor: 1, output: 'artifact', applies: { repos: ['Acme/ledger'] } },
    { id: 'pricing-paths', label: 'Pricing review', kind: 'opening', anchor: 1, output: 'artifact', applies: { paths: ['server/src/pricing/**/*.js'] } },
    { id: 'dual-change', label: 'Dual (change)', kind: 'opening', anchor: 1, output: 'artifact', applies: { labels: ['dual'] } },
    { id: 'dual-task', label: 'Dual (task)', kind: 'opening', anchor: 17, output: 'artifact', applies: { labels: ['dual'] } },
  ],
}

const stepsFile = join(farmDir, 'projects', 'acme-capital', 'steps.json')
if (scenario !== 'none') {
  mkdirSync(join(farmDir, 'projects', 'acme-capital'), { recursive: true })
  const defs =
    scenario === 'bad'
      ? { substeps: [DEFINITIONS.substeps[0], { ...DEFINITIONS.substeps[1], id: 'gated-audit', gate: 'required' }] }
      : DEFINITIONS
  writeFileSync(stepsFile, JSON.stringify(defs))
}

const errors = []
const originalError = console.error
console.error = (...args) => {
  errors.push(args.join(' '))
  originalError(...args)
}

const { db } = await import('../../src/db.js')
const store = await import('../../src/store.js')
const orchestrator = await import('../../src/orchestrator.js')
const substeps = await import('../../src/substeps.js')
const { STEPS } = await import('../../../domain/js/lifecycle.js')

const reads = []
const readFile = substeps.deps.readFile
substeps.deps.readFile = (file) => {
  reads.push(file)
  return readFile(file)
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
db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'Acme/core', 'AC')").run(project.id)
db.prepare("INSERT INTO project_repo (project_id, repo, prefix) VALUES (?, 'Acme/ledger', 'LG')").run(project.id)
if (scenario === 'off') store.setProjectDefinitionsEnabled(project.id, false, 'test')

const silentLog = { info: () => {}, warn: () => {}, error: () => {} }
await orchestrator.init(silentLog)

const label = (name) => ({ name })
const ISSUES = [
  ['Acme/core', { number: 1, title: 'Matched by label', body: 'Reprice the book.', labels: [label('Valuation')] }],
  ['Acme/ledger', { number: 2, title: 'Matched by repo', body: 'Post the journal.', labels: [] }],
  ['Acme/core', { number: 3, title: 'Matched by path', body: 'Fix the curve in `server/src/pricing/curves/zero.js`.', labels: [] }],
  ['Acme/core', { number: 4, title: 'Matches nothing', body: 'Touches `server/src/other.js` only.', labels: [label('chore')] }],
  ['Acme/core', { number: 5, title: 'Dual, a change', body: '', labels: [label('dual')] }],
  ['Acme/core', { number: 6, title: 'Dual, a task', body: '', labels: [label('dual'), label('task')] }],
]
for (const [repo, issue] of ISSUES) store.upsertFromGithub({ state: 'open', ...issue }, repo)

const ids = ['AC-1', 'LG-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6']
const deadline = Date.now() + 5000
while (!ids.every((id) => posts.some((p) => p.item.id === id))) {
  if (Date.now() > deadline) break
  await new Promise((r) => setTimeout(r, 10))
}

// O1: a later sync never re-reads the definitions.
let resynced = null
if (scenario === 'on') {
  writeFileSync(stepsFile, JSON.stringify({ substeps: [] }))
  store.upsertFromGithub({ state: 'open', ...ISSUES[0][1], title: 'Matched by label (edited)' }, 'Acme/core')
  resynced = db.prepare("SELECT title, substeps_json FROM work_item WHERE id = 'AC-1'").get()
}

const items = Object.fromEntries(
  ids.map((id) => {
    const row = db.prepare('SELECT substeps_json, substep_cursor, cursor FROM work_item WHERE id = ?').get(id)
    return [
      id,
      {
        ...row,
        label: STEPS[row.cursor].label,
        runs: db.prepare('SELECT step_index, agent, substep_id FROM step_run WHERE item_id = ? ORDER BY id').all(id),
        body: posts.find((p) => p.item.id === id) ?? null,
      },
    ]
  }),
)
process.stdout.write(`${JSON.stringify({ items, reads, errors, resynced, stepsFile })}\n`)
process.exit(0)
