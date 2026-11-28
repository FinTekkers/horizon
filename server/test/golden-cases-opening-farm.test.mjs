// HZ-976 metric line 1 on the farm path (completeFarmRun), beside the mock
// path in golden-cases-opening-run.test.mjs: once "Define how we measure
// success" finishes, the next task the farm is sent is the golden-cases
// sub-step, with its persona and output; its cases are stored and the item
// moves on to "Set guardrails".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-golden-opening-farm-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
process.env.FARM_RECOVERY_POLL_MS = String(60 * 60 * 1000)
for (const key of ['FARM_STEP_INDEXES', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'HORIZON_REPO']) delete process.env[key]

const posts = []
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  if (String(url).includes('/steps/run')) posts.push(body)
  return { ok: true, status: 200, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const golden = await import('../src/goldenCases.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {}, error: () => {} })

const METRIC_STEP = requiredStepIndex('Define how we measure success')
const GUARDRAILS = requiredStepIndex('Set guardrails')
const GOLDEN = {
  id: 'quant-golden-cases',
  label: 'Quant golden cases',
  kind: 'opening',
  anchor: METRIC_STEP,
  persona: 'quant',
  output: 'golden_cases',
  applies: { labels: ['quant'], repos: [], paths: [] },
}
const CASES = [{ id: 'accrual', inputs: { days: 30 }, measure: 'accrued', expected: 4166.67, tolerance: { abs: 0.01 }, source: 'bond-math#accrual' }]
const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Golden farm', 1, 1)").run().lastInsertRowid)

const row = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
const runs = (id) => db.prepare('SELECT id, step_index, substep_id, status FROM step_run WHERE item_id = ? ORDER BY id').all(id)
const activeRun = (id) => runs(id).find((r) => r.status === 'active')

async function nextPost(id, count) {
  const deadline = Date.now() + 3000
  const mine = () => posts.filter((p) => p.item.id === id)
  while (mine().length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  const body = mine()[count - 1]
  assert.ok(body, `${id}: post ${count} reached the farm`)
  return body
}

test('farm path: the golden-cases sub-step is dispatched with its persona after its anchor, and its cases are stored', async () => {
  const id = 'GOF-1'
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, project_id, desc, metric, guardrails, substeps_json) VALUES (?, 'Farm golden', 'Medium', ?, ?, 'Price it.', '1. m', 'Tests pass.', ?)",
  ).run(id, METRIC_STEP, projectId, JSON.stringify([GOLDEN]))

  orchestrator.kick(id)
  const metricTask = await nextPost(id, 1)
  assert.equal(metricTask.step.index, METRIC_STEP)
  assert.equal(metricTask.substep ?? null, null, 'the anchor runs as a global step')
  await orchestrator.completeFarmRun(activeRun(id).id, { summary: 'set the metric', artifacts: { artifact_md: '## Metric\n\n1. m' } })
  assert.deepEqual([row(id).cursor, row(id).substep_cursor], [METRIC_STEP, GOLDEN.id], 'the item entered the sub-step')

  const goldenTask = await nextPost(id, 2)
  assert.equal(goldenTask.step.index, METRIC_STEP)
  assert.equal(goldenTask.substep.id, GOLDEN.id)
  assert.equal(goldenTask.substep.persona, 'quant')
  assert.equal(goldenTask.substep.output, 'golden_cases')
  const substepRun = activeRun(id)
  assert.equal(substepRun.substep_id, GOLDEN.id)
  await orchestrator.completeFarmRun(substepRun.id, {
    summary: 'wrote the golden cases',
    artifacts: { artifact_md: '## Golden cases\n\n```json golden-cases\n' + JSON.stringify({ cases: CASES }) + '\n```' },
  })

  assert.deepEqual([row(id).cursor, row(id).substep_cursor], [GUARDRAILS, null], 'the item moved on')
  const pending = golden.pendingGoldenCases(row(id))
  assert.equal(pending.runId, substepRun.id)
  assert.deepEqual(pending.cases, CASES)
  const guardrailsTask = await nextPost(id, 3)
  assert.equal(guardrailsTask.step.index, GUARDRAILS)
  assert.equal(guardrailsTask.substep ?? null, null)
  orchestrator.cancel(id)
})
