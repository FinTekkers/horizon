// HO-851 metric lines 1 and 3 on the farm path (completeFarmRun), beside the
// mock path in design-substep.test.mjs: the metric step of an item with a
// design sub-step is asked for its verdict; a `no` verdict skips the sub-step
// with no run; a design-only send-back's run is told its round and brief, and
// comes straight back to the gate without "Set guardrails". A task for an
// item without a design carries none of these fields.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-design-farm-')), 'test.db')
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
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { requiredStepIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {}, error: () => {} })
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

const METRIC_STEP = requiredStepIndex('Define how we measure success')
const GUARDRAILS = requiredStepIndex('Set guardrails')
const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const DESIGN = { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: METRIC_STEP, persona: null, output: 'design', applies: { labels: ['design'], repos: [], paths: [] } }
const projectId = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Design farm', 1, 1)").run().lastInsertRowid)

const row = (id) => db.prepare('SELECT * FROM work_item WHERE id = ?').get(id)
const runs = (id) => db.prepare('SELECT id, step_index, substep_id, status FROM step_run WHERE item_id = ? ORDER BY id').all(id)
const roundRows = (id) => db.prepare('SELECT * FROM substep_round WHERE item_id = ? ORDER BY round').all(id)
const DESIGN_KEYS = ['design_verdict', 'design_round']

async function nextPost(id, count) {
  const deadline = Date.now() + 3000
  const mine = () => posts.filter((p) => p.item.id === id)
  while (mine().length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  const body = mine()[count - 1]
  assert.ok(body, `${id}: post ${count} reached the farm`)
  return body
}
const activeRun = (id) => runs(id).find((r) => r.status === 'active')

test('farm path: a `no` verdict skips with no run, and a design-only send-back returns straight to the gate', async () => {
  const id = 'DF-FARM'
  db.prepare(
    "INSERT INTO work_item (id, title, priority, cursor, project_id, desc, metric, guardrails, substeps_json) VALUES (?, 'Farm design', 'Medium', ?, ?, 'Ship it.', '1. m', 'Tests pass.', ?)",
  ).run(id, METRIC_STEP, projectId, JSON.stringify([DESIGN]))

  orchestrator.kick(id)
  const metricTask = await nextPost(id, 1)
  assert.equal(metricTask.design_verdict, true, 'the metric step is asked for the verdict')
  assert.equal(Object.hasOwn(metricTask, 'design_round'), false)
  await orchestrator.completeFarmRun(activeRun(id).id, { summary: 'set the metric', artifacts: { artifact_md: '## Metric\n\n- **design_needed:** no — backend only' } })

  assert.equal(row(id).cursor, GUARDRAILS, 'the item moved on')
  assert.equal(runs(id).filter((r) => r.substep_id === DESIGN.id).length, 0, 'a farm-path skip writes no run')
  assert.deepEqual(roundRows(id).map((r) => [r.kind, r.brief]), [['skip', 'backend only']])

  const guardrailsTask = await nextPost(id, 2)
  for (const key of DESIGN_KEYS) assert.equal(Object.hasOwn(guardrailsTask, key), false, `"Set guardrails" carries no ${key}`)
  await orchestrator.completeFarmRun(activeRun(id).id, { summary: 'set guardrails', artifacts: {} })
  assert.equal(row(id).cursor, FIRST_GATE)

  const res = await app.inject({
    method: 'POST',
    url: `/api/items/${id}/move`,
    headers: { cookie, 'x-human-key': pin },
    payload: { stepKey: `${stepKeyAt(METRIC_STEP)}#${DESIGN.id}`, from: stepKeyAt(FIRST_GATE), note: 'Draw the board after all.' },
  })
  assert.equal(res.statusCode, 200, res.body)
  const designTask = await nextPost(id, 3)
  assert.equal(designTask.substep.output, 'design')
  assert.deepEqual(designTask.design_round, { n: 2, brief: 'Draw the board after all.' })
  assert.equal(Object.hasOwn(designTask, 'design_verdict'), false)
  const before = runs(id).length
  await orchestrator.completeFarmRun(activeRun(id).id, {
    summary: 'drew the board',
    artifacts: { artifact_md: 'New canvas.\n\nwhat_changed: drew the board and its filters' },
  })

  const it = row(id)
  assert.deepEqual([it.cursor, it.substep_cursor, it.substep_pending_json], [FIRST_GATE, null, null], 'straight back to the gate')
  assert.equal(runs(id).length, before, 'no other run started')
  assert.equal(runs(id).filter((r) => r.step_index === GUARDRAILS).length, 1, 'the "Set guardrails" run count is unchanged')
  assert.equal(posts.filter((p) => p.item.id === id).length, 3)
  assert.deepEqual(
    roundRows(id).map((r) => [r.round, r.kind, r.brief, r.what_changed]),
    [
      [1, 'skip', 'backend only', null],
      [2, 'run', 'Draw the board after all.', 'drew the board and its filters'],
    ],
  )
})

test('farm path: an item without a design sub-step gets no design field on its metric step', async () => {
  const id = 'DF-PLAIN'
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, metric) VALUES (?, 'Plain', 'Medium', ?, ?, '1. m')").run(id, METRIC_STEP, projectId)
  orchestrator.kick(id)
  const body = await nextPost(id, 1)
  orchestrator.cancel(id)
  for (const key of DESIGN_KEYS) assert.equal(Object.hasOwn(body, key), false)
})
