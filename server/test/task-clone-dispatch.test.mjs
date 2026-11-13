// HZ-738: Assess, Run plan and Impact review fast-forward the target's task
// clone before they read it, so all three dispatches carry the clone the
// Execute dispatch does — repo_dir is the taskDir, never the deploy checkout,
// with task_clone set. A target with no taskDir sends no task_clone, so the
// farm never fast-forwards its repoDir. The keys are the ones
// farm/tests/test_step_agent_task_clone.py builds its task dict from.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-clone-dispatch-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const dispatches = []
globalThis.fetch = async (url, opts) => {
  dispatches.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
  if (String(url).includes('/preflight') || (typeof u !== 'undefined' && String(u).includes('/preflight'))) return { ok: true, status: 200, json: async () => ({ ok: true, failed: [], unmet: [], elapsed_ms: 0 }) }
  return { ok: true, status: 200, json: async () => ({}) }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { STEPS, ASSESS_STEP_INDEX, RUN_PLAN_STEP_INDEX, IMPACT_REVIEW_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
after(() => db.close?.())

const MDI = 'FinTekkers/market-data-inputs'
const REPO_DIR = '/opt/fintekkers/market-data-inputs'
const TASK_DIR = '/opt/fintekkers/market-data-inputs-tasks'
const STEP_INDEXES = [ASSESS_STEP_INDEX, RUN_PLAN_STEP_INDEX, IMPACT_REVIEW_STEP_INDEX]
const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Clone project', 1)").run().lastInsertRowid)

async function dispatchAll(suffix) {
  const bodies = []
  for (const stepIndex of STEP_INDEXES) {
    const id = `T-738-${suffix}-${stepIndex}`
    db.prepare(
      "INSERT INTO work_item (id, title, priority, cursor, kind, project_id, repo) VALUES (?, 'Task', 'High', ?, 'task', ?, ?)",
    ).run(id, stepIndex, projectId, MDI)
    orchestrator.kick(id)
    await new Promise((r) => setTimeout(r, 30))
    const sent = dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === id)
    assert.ok(sent, `${STEPS[stepIndex].label} was dispatched`)
    assert.equal(sent.body.step.index, stepIndex)
    orchestrator.cancel(id)
    bodies.push(sent.body)
  }
  return bodies
}

test('the step indexes name the three Task steps', () => {
  assert.deepEqual(
    STEP_INDEXES.map((i) => STEPS[i].label),
    ['Assess', 'Run plan', 'Impact review'],
  )
})

test('with a taskDir, Assess, Run plan and Impact review carry it as repo_dir with task_clone', async () => {
  db.prepare('UPDATE deploy_target SET task_dir = ? WHERE repo = ?').run(TASK_DIR, MDI)
  try {
    const [assess, runPlan, impact] = await dispatchAll('SET')
    for (const body of [assess, runPlan, impact]) {
      assert.equal(body.repo_dir, TASK_DIR)
      assert.notEqual(body.repo_dir, REPO_DIR)
      assert.equal(body.task_clone, true)
      for (const key of ['venv_dir', 'container_image', 'cpu_limit', 'memory_limit']) {
        assert.ok(Object.hasOwn(body, key), `${body.step.label} carries ${key}`)
      }
    }
    // Only Run plan's prompt names the runner.
    assert.equal(typeof runPlan.runner, 'string')
    assert.equal(Object.hasOwn(assess, 'runner'), false)
    assert.equal(Object.hasOwn(impact, 'runner'), false)
  } finally {
    db.prepare('UPDATE deploy_target SET task_dir = NULL WHERE repo = ?').run(MDI)
  }
})

test('without a taskDir, none of the three carries task_clone, and Assess and Impact review carry no checkout', async () => {
  const [assess, runPlan, impact] = await dispatchAll('UNSET')
  for (const body of [assess, runPlan, impact]) assert.equal(Object.hasOwn(body, 'task_clone'), false)
  assert.equal(runPlan.repo_dir, REPO_DIR)
  for (const body of [assess, impact]) {
    for (const key of ['repo_dir', 'venv_dir', 'container_image', 'cpu_limit', 'memory_limit']) {
      assert.equal(Object.hasOwn(body, key), false, `${body.step.label} carries no ${key}`)
    }
  }
})