// HO-843: in demo mode (no farm) the mock Run plan step hands a waiting owner
// patch back byte for byte, as the farm's patch check does, instead of
// writing its own plan — so a demo Task reaches Approve the run with the
// patched command's diff (the e2e journey, 53-task-patch-command.spec.js,
// depends on it). Mock Impact review and Preflight then run as usual, and
// HO-845's mock per-command checks pass before the card may approve.
//
// Its own file because config.js reads the environment at import time.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-run-plan-patch-demo-')), 'test.db')
process.env.MOCK_STEP_LATENCY_MS = '5'
for (const key of ['FARM_URL', 'GITHUB_WEBHOOK_SECRET', 'FARM_STEP_INDEXES', 'WA_POLL_ENABLED']) delete process.env[key]

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { mintHumanProof } = await import('../src/humanProof.js')
const { STEPS, kindStepIndex, APPROVE_RUN_GATE_INDEX, RUN_PLAN_STEP_INDEX, EXECUTE_STEP_INDEX } = await import('../../domain/js/lifecycle.js')
const { seedPreflight } = await import('./helpers/preflight.mjs')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })

after(() => {
  for (const row of db.prepare('SELECT id FROM work_item').all()) orchestrator.cancel(row.id)
})

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const PLAN =
  '## Commands\n1. lint\n2. test\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands: ['make lint', 'make test'], budget_minutes: 5 }, null, 2) +
  '\n```'

async function waitFor(fn, what) {
  for (let i = 0; i < 300; i += 1) {
    if (fn()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('demo mode: a waiting patch completes Run plan with the byte-identical patched artifact and reaches the per-command card', async () => {
  const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES ('HO-843 demo', 1)").run().lastInsertRowid)
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id) VALUES ('T-DEMO', 'Demo task', 'High', ?, 'task', ?)").run(
    APPROVE_RUN_GATE_INDEX,
    projectId,
  )
  for (const [label, artifact] of [
    ['Assess', '## Scripts found\n- make'],
    ['Run plan', PLAN],
    ['Impact review', '## Verdict\n**pass**'],
  ]) {
    const index = kindStepIndex(label, 'task')
    db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES ('T-DEMO', ?, 1, ?, 'done', 'ok', ?, datetime('now'))").run(
      index,
      STEPS[index].agent,
      artifact,
    )
  }
  seedPreflight(db, store, 'T-DEMO')
  const proof = mintHumanProof({ userId: 1 })
  assert.equal(store.approveGate('T-DEMO', APPROVE_RUN_GATE_INDEX, '', 'Owner', { proof, planHash: sha256(PLAN) }).ok, true)
  orchestrator.cancel('T-DEMO') // no Execute job runs, as after a Stop

  const patched = store.patchRunPlan('T-DEMO', { from: 'task.execute', planHash: sha256(PLAN), index: 1, command: 'make test -k fast' }, 'Owner')
  assert.equal(patched.ok, true, JSON.stringify(patched))
  assert.equal(patched.mode, 'command')
  const artifact = store.commandPatchState('T-DEMO').artifact

  await waitFor(() => db.prepare("SELECT cursor FROM work_item WHERE id = 'T-DEMO'").get().cursor === APPROVE_RUN_GATE_INDEX, 'the gate')
  assert.equal(store.latestArtifact('T-DEMO', RUN_PLAN_STEP_INDEX), artifact, 'the mock Run plan wrote the patched artifact byte for byte')
  assert.equal(sha256(artifact), patched.patchedHash)
  const view = store.itemViewById('T-DEMO').runPlan
  assert.deepEqual(view.commandPatch, { index: 1, count: 2, before: 'make test', after: 'make test -k fast', commandHash: sha256('make test -k fast') })
  assert.equal(view.preflight.status, 'passed')
  // HO-845: the mock contract audit, preflight and rehearsal of command 2 pass,
  // in order, and only then may its card approve.
  await waitFor(() => store.itemViewById('T-DEMO').runPlan.patchedCommand?.approvable === true, 'the three per-command checks')
  assert.deepEqual(
    store.itemViewById('T-DEMO').runPlan.patchedCommand.stages.map((s) => [s.stage, s.status]),
    [['audit', 'pass'], ['preflight', 'pass'], ['rehearsal', 'pass']],
  )

  const ok = store.approveGate('T-DEMO', APPROVE_RUN_GATE_INDEX, '', 'Owner', {
    proof,
    planHash: view.hash,
    commandIndex: 1,
    commandHash: view.commandPatch.commandHash,
  })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(db.prepare("SELECT cursor FROM work_item WHERE id = 'T-DEMO'").get().cursor, EXECUTE_STEP_INDEX)
  orchestrator.cancel('T-DEMO')
})
