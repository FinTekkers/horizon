// HZ-972 metric 1: the rust_quant (eng) and quant (qa) personas exist in the
// registry with role files and badges, and an outcome-step patch
// `"personas": {"eng": "rust_quant"}` on a valuation-service calculator item
// is accepted and stored.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-hz972-personas-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'HORIZON_REPO']) delete process.env[key]
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })

const REPO_ROOT = join(import.meta.dirname, '../..')

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { PERSONAS, isPersona } = await import('../src/personas.js')
const uiPersonas = await import('../../ui/src/domain/personas.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

// The step PM picks personas on, by key, so no label is typed here.
const DEFINE_OUTCOME = STEPS.findIndex((step) => step.key === 'change.define-outcome')

test('rust_quant is an eng persona and quant a qa persona, each with a role file and a badge', () => {
  assert.ok(isPersona('eng', 'rust_quant'))
  assert.ok(isPersona('qa', 'quant'))
  assert.ok(!isPersona('qa', 'rust_quant') && !isPersona('eng', 'quant'), 'each stays in its own bucket')
  assert.equal(PERSONAS.eng.rust_quant.file, 'eng_rust_quant.md')
  assert.equal(PERSONAS.qa.quant.file, 'qa_quant.md')
  for (const file of ['eng_rust_quant.md', 'qa_quant.md']) assert.ok(existsSync(join(REPO_ROOT, 'farm/roles/personas', file)), file)
  assert.equal(PERSONAS.eng.rust_quant.initials, 'RQ')
  assert.equal(PERSONAS.qa.quant.initials, 'QT')
  assert.equal(uiPersonas.PERSONAS.eng.rust_quant.initials, 'RQ')
  assert.equal(uiPersonas.PERSONAS.qa.quant.initials, 'QT')
})

test('an outcome-step patch {"eng": "rust_quant"} on a valuation-service calculator item is accepted and stored', async () => {
  const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('FinTekkers', 1, 1)").run().lastInsertRowid)
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, project_id, repo, desc) VALUES ('VS-1', 'Stub-aware duration', 'High', ?, ?, 'FinTekkers/valuation-service', ?)",
  ).run(DEFINE_OUTCOME, projectId, 'Fix the first-period stub in `src/calculators/bond_calculator/modified_duration.rs`.')
  const runId = db
    .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)')
    .run('VS-1', DEFINE_OUTCOME, STEPS[DEFINE_OUTCOME].agent).lastInsertRowid

  const result = await orchestrator.completeFarmRun(runId, {
    summary: 'Kept the outcome; Rust calculator work, so rust_quant.',
    patch: { personas: { eng: 'rust_quant' } },
    artifacts: { artifact_md: 'Kept the description.' },
  })
  orchestrator.cancel('VS-1')
  assert.deepEqual(result, { ok: true })
  const item = store.getItem('VS-1')
  assert.deepEqual(item.personas, { eng: 'rust_quant' })
  assert.equal(JSON.parse(db.prepare("SELECT personas_json FROM work_item WHERE id = 'VS-1'").get().personas_json).eng, 'rust_quant')
  assert.equal(item.cursor, DEFINE_OUTCOME + 1)
})
