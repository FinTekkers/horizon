// HO-838 metric 1, end to end against a real farmd: a plan approved while
// MY_VAR resolves (from the repo's .env, which Execute reads first) is
// dispatched after MY_VAR is removed. The server's re-check (farmd POST
// /preflight, farm/preflight.py) refuses: the event names MY_VAR with the
// prereq_drift tag, farmd writes no job task file, the secret value never
// shows, and the approval is kept.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-prereq-e2e-')), 'test.db')
process.env.FARM_QUEUE_TIMEOUT_MS = '600000'
process.env.FARM_STEP_TIMEOUT_MS = '600000'

import { startTestFarmd } from './helpers/farmd.mjs'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'

const farmd = await startTestFarmd({ repoRoot: REPO_ROOT })
process.env.FARM_URL = farmd.url
after(() => farmd.stop())

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { STEPS, EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { REASON } = await import('../../domain/js/reasons.js')

store.purgeDemoItems()

const REPO = 'acme/prereq-e2e'
const SECRET = 'sentinel-9f2c'
const repoDir = mkdtempSync(join(tmpdir(), 'horizon-prereq-repo-'))
await useDeployTargetRows([{ key: 'prereq-e2e', repo: REPO, repoDir, stateKey: `prereq-e2e-${process.pid}` }])

const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const jobFiles = () => {
  const dir = join(farmd.home, 'queue', 'jobs', 'active')
  return existsSync(dir) ? readdirSync(dir) : []
}

test('real farm: MY_VAR removed after approval — dispatch refuses naming it, tagged prereq_drift, no job reaches farmd', async () => {
  const plan =
    '## Commands\n1. run\n\n## Run plan block\n```json run-plan\n' +
    JSON.stringify({ cwd: '.', commands: ['echo hi'], budget_minutes: 5, env: { MY_VAR: '$MY_VAR' } }) +
    '\n```'
  const id = 'HO-838-E2E'
  writeFileSync(join(repoDir, '.env'), `MY_VAR=${SECRET}\n`)
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, kind, repo, approved_plan_hash, approved_runner) VALUES (?, 'Prereq e2e', 'High', ?, 'task', ?, ?, 'host')",
  ).run(id, EXECUTE_STEP_INDEX, REPO, sha256(plan))
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
  ).run(id, RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, plan)
  const approvedBefore = db.prepare('SELECT approved_plan_hash, approved_runner FROM work_item WHERE id = ?').get(id)

  // At approval the real probe passes: MY_VAR resolves from the repo's .env.
  const atApproval = await (
    await fetch(`${farmd.url}/preflight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orchestrator.jobRequest(id)) })
  ).json()
  assert.equal(atApproval.ok, true, JSON.stringify(atApproval))

  // The host drifts: MY_VAR is gone from the source Execute reads.
  writeFileSync(join(repoDir, '.env'), 'OTHER=1\n')
  orchestrator.kick(id)
  let item
  for (let i = 0; i < 200; i++) {
    await wait(50)
    item = store.getItem(id)
    if (item.paused) break
  }
  assert.ok(item.paused, 'the refusal pauses the item')

  const execRuns = db.prepare('SELECT status, output FROM step_run WHERE item_id = ? AND step_index = ?').all(id, EXECUTE_STEP_INDEX)
  assert.equal(execRuns.length, 1)
  assert.notEqual(execRuns[0].status, 'active')
  assert.match(execRuns[0].output, /^FAILED: prerequisites changed since approval — failed: MY_VAR/)

  const events = db.prepare('SELECT text FROM event WHERE item_id = ?').all(id).map((e) => e.text)
  const refusal = events.find((t) => t.includes(`(${REASON.PREREQ_DRIFT})`))
  assert.ok(refusal, `an event carries the prereq_drift tag: ${JSON.stringify(events)}`)
  assert.match(refusal, /MY_VAR/)
  for (const text of [...events, execRuns[0].output]) assert.ok(!text.includes(SECRET), 'the secret value never shows')

  assert.deepEqual(jobFiles(), [], 'farmd got no /steps/run: no job task file')
  assert.deepEqual(db.prepare('SELECT approved_plan_hash, approved_runner FROM work_item WHERE id = ?').get(id), approvedBefore)
})
