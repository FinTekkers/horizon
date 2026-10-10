// HZ-383: a Task's Assess, Run plan and Impact review run on the farm. The
// dispatch carries the item's kind (farmd and step_agent route by it), each
// step's input carries the earlier Task steps' artifacts whole, a farm that
// refuses a step of the wrong kind pauses the item, and each step's summary
// and artifact are saved on its step_run row.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-task-steps-')), 'test.db')
// FARM_URL set => kick() dispatches to the farm (the stubbed fetch below).
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
delete process.env.FARM_STEP_INDEXES

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const { kindStepIndex, STEPS } = await import('../../domain/js/lifecycle.js')
const orchestrator = await import('../src/orchestrator.js')

store.purgeDemoItems()

const ASSESS = kindStepIndex('Assess', 'task')
const RUN_PLAN = kindStepIndex('Run plan', 'task')
const IMPACT_REVIEW = kindStepIndex('Impact review', 'task')

// The fake farm: records every call. A payload for item id KIND-MISMATCH is
// refused the way farmd refuses a step of the wrong kind.
const dispatches = []
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  dispatches.push({ url: String(url), body })
  if (String(url).includes('/runs/status')) return { ok: true, json: async () => ({ states: {} }) }
  if (String(url).includes('/steps/run') && body?.item?.id === 'T-MISMATCH') {
    return { ok: false, status: 400, json: async () => ({ error: 'step kind mismatch' }) }
  }
  return { ok: true, json: async () => ({}) }
}

orchestrator.init({ info: () => {}, warn: () => {} })

const insertTask = db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind) VALUES (?, ?, 'Medium', ?, 'task')")
const doneStepRun = (itemId, stepIndex, artifact) =>
  db
    .prepare(
      "INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))",
    )
    .run(itemId, stepIndex, STEPS[stepIndex].agent, artifact)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const dispatchOf = (id) => dispatches.find((d) => d.url.includes('/steps/run') && d.body?.item?.id === id)

async function dispatchFor(id) {
  orchestrator.kick(id)
  await wait(20) // dispatch is fire-and-forget
  const dispatch = dispatchOf(id)
  assert.ok(dispatch, `no /steps/run dispatch captured for ${id}`)
  orchestrator.cancel(id) // clear the watchdog so the test process can exit
  return dispatch
}

const artifactsByLabel = (dispatch) => Object.fromEntries(dispatch.body.artifacts.map((a) => [a.label, a.content]))

test('Assess is handed to the farm, and the payload names the item kind and the step', async () => {
  insertTask.run('T-ASSESS', 'Backfill', ASSESS)
  const dispatch = await dispatchFor('T-ASSESS')
  assert.equal(dispatch.body.item.kind, 'task')
  assert.deepEqual(dispatch.body.step, { index: ASSESS, label: 'Assess', agent: 'Eng' })
})

test('Run plan gets the Assess artifact in full', async () => {
  insertTask.run('T-PLAN', 'Backfill', RUN_PLAN)
  doneStepRun('T-PLAN', ASSESS, '## Scripts found\n- `scripts/backfill.sh`')
  const dispatch = await dispatchFor('T-PLAN')
  assert.equal(dispatch.body.item.kind, 'task')
  assert.deepEqual(artifactsByLabel(dispatch), { Assess: '## Scripts found\n- `scripts/backfill.sh`' })
})

test('Impact review gets the Assess and Run plan artifacts in full', async () => {
  insertTask.run('T-IMPACT', 'Backfill', IMPACT_REVIEW)
  doneStepRun('T-IMPACT', ASSESS, 'assess artifact')
  doneStepRun('T-IMPACT', RUN_PLAN, 'run plan artifact')
  const dispatch = await dispatchFor('T-IMPACT')
  assert.deepEqual(artifactsByLabel(dispatch), { Assess: 'assess artifact', 'Run plan': 'run plan artifact' })
})

test('a truncated Assess artifact refuses the dispatch: nothing reaches the farm and the item pauses', async () => {
  insertTask.run('T-TRUNC', 'Backfill', IMPACT_REVIEW)
  doneStepRun('T-TRUNC', ASSESS, 'a'.repeat(40000)) // older — loses the recency-weighting fight
  doneStepRun('T-TRUNC', RUN_PLAN, 'r'.repeat(40000))
  orchestrator.kick('T-TRUNC')
  await wait(20)

  assert.equal(dispatchOf('T-TRUNC'), undefined, 'a step whose required input was truncated must never reach the farm')
  assert.equal(store.getItem('T-TRUNC').paused, true)
  const event = db.prepare("SELECT text FROM event WHERE item_id = 'T-TRUNC' ORDER BY id DESC LIMIT 1").get()
  assert.match(event.text, /agent step failed \(required_input_incomplete\)/)
  assert.match(event.text, /"Assess" needs 40000 chars/)
})

test('a farm that refuses the step as the wrong kind fails the run with that reason and pauses the item', async () => {
  insertTask.run('T-MISMATCH', 'Backfill', ASSESS)
  orchestrator.kick('T-MISMATCH')
  await wait(30)

  assert.ok(dispatchOf('T-MISMATCH'), 'the step was handed to the farm')
  assert.equal(store.getItem('T-MISMATCH').paused, true, 'the item pauses for a human')
  const runs = db.prepare("SELECT status FROM step_run WHERE item_id = 'T-MISMATCH'").all()
  assert.equal(runs.length, 1, 'nothing retries')
  assert.notEqual(runs[0].status, 'active')
  const event = db.prepare("SELECT text FROM event WHERE item_id = 'T-MISMATCH' ORDER BY id DESC LIMIT 1").get()
  assert.ok(event.text.includes("this step does not belong to the item's kind"), event.text)
})

for (const [label, index] of [
  ['Assess', ASSESS],
  ['Run plan', RUN_PLAN],
  ['Impact review', IMPACT_REVIEW],
]) {
  test(`a farm completion for ${label} saves its summary and artifact on the step`, async () => {
    const id = `T-DONE-${index}`
    insertTask.run(id, 'Backfill', index)
    const runId = db
      .prepare('INSERT INTO step_run (item_id, step_index, attempt, agent) VALUES (?, ?, 1, ?)')
      .run(id, index, STEPS[index].agent).lastInsertRowid
    const result = await orchestrator.completeFarmRun(runId, {
      summary: `did ${label}`,
      artifacts: { artifact_md: `## ${label}\nbody` },
    })
    assert.deepEqual(result, { ok: true })
    const row = db.prepare('SELECT status, output, artifact FROM step_run WHERE id = ?').get(runId)
    assert.equal(row.status, 'done')
    assert.equal(row.output, `did ${label}`)
    assert.equal(row.artifact, `## ${label}\nbody`)
    orchestrator.cancel(id)
  })
}
