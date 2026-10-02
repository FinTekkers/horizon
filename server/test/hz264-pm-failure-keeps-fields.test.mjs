// HZ-264 metric 3: "if the retry is also over budget, the step fails ... The
// stored metric and guardrails stay byte-identical to their pre-step values."
//
// farm/tests/test_hz264_pm_budget.py proves the AGENT side: a second
// over-budget reply posts {ok: false, error} with no patch. This file is the
// other half, driven over real HTTP through the real route:
//
//   POST /api/farm/steps/:runId/fail  ->  failFarmRun
//
// The item's metric and guardrails must be untouched, the operator must see
// the agent's reason verbatim on the run, and the run must pause for a human
// rather than auto-retry (it carries no reason, so it is not TURN_CAP).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-hz264-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_QUEUE_TIMEOUT_MS = '600000' // real timers must never fire here
process.env.FARM_STEP_TIMEOUT_MS = '600000'
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const { FARM_SHARED_SECRET } = await import('../src/config.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { patchLimits } = await import('../../domain/js/fields.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

// The farm is a stub: every dispatch POST succeeds.
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const app = buildApp({ logger: false })

const GUARDRAILS_STEP = requiredStepIndex('Set guardrails')
const LIMITS = patchLimits()

const METRIC = '1. Each line is pass/fail.\n2. Second line — with “curly quotes” and trailing space. '
const GUARDRAILS = '- Do not raise the budget.\n- Keep desc truncation as it is.\n'

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

test('a PM step that fails over budget leaves metric and guardrails byte-identical and pauses', async () => {
  const id = 'HZ264-FAIL'
  db.prepare('INSERT INTO work_item (id, title, priority, cursor, metric, guardrails) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    'Over-budget PM failure',
    'Medium',
    GUARDRAILS_STEP,
    METRIC,
    GUARDRAILS,
  )
  orchestrator.kick(id)
  await wait(10)
  const run = db.prepare("SELECT id, auto_retry_count FROM step_run WHERE item_id = ? AND status = 'active'").get(id)
  assert.ok(run, `no active run was dispatched for ${id}`)

  // The exact shape farm/pm_agent.py's FieldOverBudgetError produces.
  const length = LIMITS.guardrails + 77
  const error = `guardrails is ${length} chars; budget is ${LIMITS.guardrails} chars (domain/fields.json). Tighten the wording to fit; do not drop lines`
  const res = await app.inject({
    method: 'POST',
    url: `/api/farm/steps/${run.id}/fail`,
    headers: { 'x-farm-secret': FARM_SHARED_SECRET },
    payload: { error },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.notEqual(res.json().stale, true, 'the run was treated as stale — the fixture is wrong')
  assert.notEqual(res.json().retried, true, 'an over-budget failure must not auto-retry')

  const item = db.prepare('SELECT metric, guardrails, paused, cursor FROM work_item WHERE id = ?').get(id)
  assert.equal(item.metric, METRIC)
  assert.equal(item.guardrails, GUARDRAILS)
  assert.equal(item.paused, 1, 'the item must pause for a human')
  assert.equal(item.cursor, GUARDRAILS_STEP, 'the item must not advance past the failed step')

  const ended = db.prepare('SELECT status, output FROM step_run WHERE id = ?').get(run.id)
  assert.equal(ended.status, 'cancelled')
  assert.equal(ended.output, `FAILED: ${error}`, 'the operator must see the agent reason verbatim')

  const active = db.prepare("SELECT COUNT(*) AS n FROM step_run WHERE item_id = ? AND status = 'active'").get(id).n
  assert.equal(active, 0, 'no new run was dispatched')
})
