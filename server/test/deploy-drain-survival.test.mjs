// HZ-469: the drain lists each running agent step with its `kind` and whether
// it `survives` a restart, from RESTART_SURVIVAL (server/src/deployDrain.js).
// The table must cover every runsIn kind in domain/steps.json, and a kind it
// does not know counts as lost. The restart itself is proven in
// farm/tests/test_step_survives_restart.py; the helper's wait/skip choice in
// infra/host/test/deploy-drain.test.sh.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-deploy-drain-survival-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_SHARED_SECRET = 'farm-secret-hz469'
process.env.HOME = mkdtempSync(join(tmpdir(), 'horizon-deploy-drain-survival-home-'))

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { buildApp } = await import('../src/app.js')
const deployDrain = await import('../src/deployDrain.js')
const { STEPS } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
store.registerAgentRunner({ kick: () => {}, cancel: () => {} })
after(() => deployDrain.endDrain())

const indexOf = (runsIn) => STEPS.findIndex((s) => s.kind === 'agent' && s.runsIn === runsIn)

test('every runsIn kind in the step table has a survival entry', () => {
  const kinds = new Set(STEPS.filter((s) => s.kind === 'agent').map((s) => s.runsIn))
  for (const kind of kinds) {
    assert.ok(Object.hasOwn(deployDrain.RESTART_SURVIVAL, kind), `RESTART_SURVIVAL has no entry for runsIn '${kind}'`)
    assert.ok(['survives', 'lost'].includes(deployDrain.RESTART_SURVIVAL[kind]))
  }
  assert.ok(Object.isFrozen(deployDrain.RESTART_SURVIVAL))
})

test('a kind the table does not know, or a step index with no row, never survives', () => {
  const gate = STEPS.findIndex((s) => s.kind === 'gate')
  assert.equal(deployDrain.survivesRestart(gate), false)
  assert.equal(deployDrain.survivesRestart(STEPS.length + 5), false)
  assert.equal(deployDrain.survivesRestart(-1), false)
  // An inherited key is not an entry.
  assert.equal(Object.hasOwn(deployDrain.RESTART_SURVIVAL, 'toString'), false)
  for (const kind of Object.keys(deployDrain.RESTART_SURVIVAL)) {
    assert.equal(deployDrain.survivesRestart(indexOf(kind)), deployDrain.RESTART_SURVIVAL[kind] === 'survives')
  }
})

test('beginDrain and drainStatus tag steps from different projects with their kind and survival', async () => {
  const fintekkers = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('FinTekkers', 1)").run().lastInsertRowid)
  const horizon = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('Horizon', 1)").run().lastInsertRowid)
  const seed = (id, projectId, repo, runsIn) => {
    const index = indexOf(runsIn)
    db.prepare('INSERT INTO work_item (id, title, priority, cursor, repo, project_id) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, 'Medium', index, repo, projectId)
    return Number(
      db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'Eng', 'active')").run(id, index).lastInsertRowid,
    )
  }
  const farmRun = seed('US-225', fintekkers, 'FinTekkers/ui-service', 'farm')
  const serverRun = seed('HZ-9001', horizon, 'FinTekkers/horizon', 'server')
  const jobRun = seed('HZ-9002', horizon, 'FinTekkers/horizon', 'job')

  const expected = (runId, runsIn) => ({ runId, kind: runsIn, survives: deployDrain.RESTART_SURVIVAL[runsIn] === 'survives' })
  const pick = (steps) => steps.map(({ runId, kind, survives }) => ({ runId, kind, survives }))
  const want = [expected(farmRun, 'farm'), expected(serverRun, 'server')]

  const began = deployDrain.beginDrain({ ttlS: 60 })
  assert.deepEqual(pick(began.steps), want)
  assert.deepEqual(pick(deployDrain.drainStatus().steps), want)
  assert.ok(!began.steps.some((s) => s.runId === jobRun), 'a job step is never listed')
  assert.equal(began.steps[0].itemId, 'US-225')

  // The same shape over the loopback route the helper polls.
  const app = buildApp({ logger: false })
  const res = await app.inject({ method: 'GET', url: '/api/farm/deploy-drain', headers: { 'x-farm-secret': 'farm-secret-hz469' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(pick(res.json().steps), want)
  await app.close()
})
