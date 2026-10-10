// HZ-378 R21: on an Autopilot project the Task stops at the approve gate —
// Autopilot never approves it, so no job is ever dispatched.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-job-autopilot-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const dispatches = []
globalThis.fetch = async (url, opts) => {
  dispatches.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  return { ok: true, status: 200, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { STEPS, APPROVE_RUN_GATE_INDEX, RUN_PLAN_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Autopilot project', 1)").run().lastInsertRowid)
db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(projectId)

const PLAN =
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '/tmp', commands: ['scripts/a.sh'], budget_minutes: 20 }, null, 2) +
  '\n```'

db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id) VALUES ('T-R21', 'Autopilot task', 'High', ?, 'task', ?)").run(
  APPROVE_RUN_GATE_INDEX,
  projectId,
)
db.prepare(
  "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES ('T-R21', ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
).run(RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, PLAN)

test('R21: Autopilot cannot approve the run, and no job is ever dispatched', async () => {
  assert.deepEqual(store.approveGate('T-R21', APPROVE_RUN_GATE_INDEX, '', 'Autopilot'), { error: 'human_pin_required' })
  assert.equal(store.getItem('T-R21').cursor, APPROVE_RUN_GATE_INDEX)

  orchestrator.kick('T-R21')
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(
    dispatches.filter((d) => d.url.includes('/steps/run') && d.body?.item?.id === 'T-R21'),
    [],
  )

  // The refusal is visible in Activity, so the stop is observable, not silent.
  const events = db.prepare('SELECT text FROM event WHERE item_id = ? ORDER BY id').all('T-R21')
  assert.equal(events.length, 1)
  assert.ok(events[0].text.includes('needs a human with the gate PIN'), events[0].text)
})
