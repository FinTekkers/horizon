// HZ-408 metric line 2: a job running in one repo never holds another repo's
// deploy. With an Execute job active in FinTekkers/ui-service, a release of
// FinTekkers/horizon deploys at once, its drain (HZ-250) has nothing to wait
// for so it settles within its TTL, and the ui-service job is still running
// afterwards — nobody asked the farm to stop it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDeployTargetRows } from './helpers/deployTargetRows.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-hold-cross-repo-')), 'test.db')
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-hold-cross-repo-home-'))
process.env.FARM_URL = 'http://farm.test'

const farmCalls = []
globalThis.fetch = async (url) => {
  farmCalls.push(new URL(String(url)).pathname)
  return { ok: true, status: 200, json: async () => ({}) }
}

await useDeployTargetRows([
  { key: 'horizon', repo: 'FinTekkers/horizon', stateKey: 'horizon', script: 'horizon.sh', service: 'horizon-svc' },
  { key: 'ui-service', repo: 'FinTekkers/ui-service', stateKey: 'ui-service', script: 'ui.sh', service: 'ui-svc' },
])

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const deploy = await import('../src/deploy.js')
const deployDrain = await import('../src/deployDrain.js')
const deployQueue = await import('../src/deployQueue.js')
const { STEPS, EXECUTE_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()

db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, repo) VALUES ('T-UI', 'Job', 'High', ?, 'task', 'FinTekkers/ui-service')").run(
  EXECUTE_STEP_INDEX,
)
const jobRun = Number(
  db
    .prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES ('T-UI', ?, 1, ?, 'active')")
    .run(EXECUTE_STEP_INDEX, STEPS[EXECUTE_STEP_INDEX].agent).lastInsertRowid,
)

test('line 2: a job in ui-service never holds a horizon deploy, the drain settles within its TTL, and the job keeps running', async () => {
  const spawns = []
  deploy.runner.spawn = (target, tag) => spawns.push(`${target.key}:${tag}`)

  deploy.runDeploy('FinTekkers/horizon', 'v-cross')
  assert.deepEqual(spawns, ['horizon:v-cross'], 'the horizon release deploys at once')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deploy_hold').get().n, 0)

  // deploy-horizon.sh's drain stage: begin, then wait until nothing is listed.
  const ttlS = 60
  const started = Date.now()
  const begun = deployDrain.beginDrain({ ttlS }, started)
  assert.ok(!begun.steps.some((s) => s.runId === jobRun), 'the job is not drained')
  assert.deepEqual(deployDrain.drainStatus().steps, [], 'nothing for the drain to wait on')
  assert.deepEqual(deployDrain.drainStatus().running, [])
  const ended = new Promise((resolve) => deployDrain.onDrainEnd(resolve))
  deployDrain.endDrain()
  await ended
  assert.ok(Date.now() - started < ttlS * 1000, 'the drain settled within its TTL')

  await deployQueue.tick()
  assert.deepEqual(spawns, ['horizon:v-cross'], 'still exactly one deploy')
  assert.equal(db.prepare('SELECT status FROM step_run WHERE id = ?').get(jobRun).status, 'active', 'the ui-service job is still running')
  assert.equal(farmCalls.filter((p) => p === '/jobs/stop').length, 0, 'the farm was never asked to stop the job')
})
