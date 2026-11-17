// HO-852 guardrail 2: an item without a design keeps today's flow. A project
// with its definitions switch off — even with a design sub-step in the
// snapshot — and an item with no design sub-step both ignore
// designSkipReason (200, no row), serve no designSpec, and send no canvas,
// no shots and no design_canvas, even with a stray design_spec row.
// substep-parity.test.mjs pins every other /steps/run body byte for byte.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-design-spec-off-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
for (const key of ['FARM_STEP_INDEXES', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'HORIZON_REPO', 'WA_NOTIFY_ENABLED']) delete process.env[key]

const posts = []
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/steps/run')) posts.push(JSON.parse(opts.body))
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
}

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const spec = await import('../src/designSpec.js')
const { REVIEW_SHOTS_LABEL } = await import('../src/screenshots.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { canvasUrlFor } = await import('../../domain/js/designCanvas.js')
const { IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, requiredStepIndex, stepKeyAt } = await import('../../domain/js/lifecycle.js')

store.purgeDemoItems()
orchestrator.init({ info() {}, warn() {}, error() {} })
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const PLAN_OPTIONS = requiredStepIndex('Plan options & trade-offs (pros / cons)')
const DESIGN_SNAPSHOT = JSON.stringify([
  { id: 'design-screens', label: 'Design the screens', kind: 'opening', anchor: 1, persona: null, output: 'design', applies: { labels: ['design'], repos: [], paths: [] } },
])
const offProject = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Definitions off', 1, 0)").run().lastInsertRowid)
const onProject = Number(db.prepare("INSERT INTO project (name, enabled, definitions_enabled) VALUES ('Definitions on', 1, 1)").run().lastInsertRowid)

const CASES = [
  ['a project with definitions off, a design sub-step in its snapshot', 'OFF-DEFS', offProject, DESIGN_SNAPSHOT],
  ['an item with no design sub-step', 'OFF-NODESIGN', onProject, null],
]

function seed(id, projectId, snapshot) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, substeps_json) VALUES (?, ?, 'Medium', ?, ?, ?)").run(id, `Item ${id}`, FIRST_GATE, projectId, snapshot)
  db.prepare(
    "INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, artifact) VALUES (?, 1, 'design-screens', 1, 'Design', 'done', ?)",
  ).run(id, `**Canvas:** [Open the design canvas](${canvasUrlFor('stray')}) · slug \`stray\` · version 1`)
}
async function waitForPost(id, stepIndex) {
  const deadline = Date.now() + 3000
  const find = () => posts.find((p) => p.item.id === id && p.step.index === stepIndex)
  while (!find() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  return find() ?? null
}

for (const [name, id, projectId, snapshot] of CASES) {
  test(`${name}: approve ignores designSkipReason (200, no row) and serves no designSpec`, async () => {
    seed(id, projectId, snapshot)
    assert.equal(spec.designRequired(store.getItem(id)), false)
    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${id}/move`,
      headers: { cookie, 'x-human-key': pin },
      payload: { action: 'approve', from: stepKeyAt(FIRST_GATE), designSkipReason: 'ignored here' },
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM design_spec WHERE item_id = ?').get(id).n, 0)
    assert.equal(Object.hasOwn(store.itemViewById(id), 'designSpec'), false)
    await waitForPost(id, PLAN_OPTIONS)
    orchestrator.cancel(id)
  })

  test(`${name}: no step is sent a canvas, shots or design_canvas, even with a stray design_spec row`, async () => {
    db.prepare("INSERT INTO design_spec (item_id, canvas_url, approved_by) VALUES (?, ?, 'Ada')").run(id, canvasUrlFor('stray'))
    for (const stepIndex of [PLAN_OPTIONS, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX]) {
      orchestrator.cancel(id)
      posts.length = 0
      db.prepare('UPDATE work_item SET cursor = ?, paused = 0 WHERE id = ?').run(stepIndex, id)
      orchestrator.kick(id)
      const body = await waitForPost(id, stepIndex)
      orchestrator.cancel(id)
      assert.ok(body, `step ${stepIndex} was dispatched`)
      const labels = body.artifacts.map((a) => a.label)
      assert.ok(!labels.includes(spec.CANVAS_LABEL))
      assert.ok(!labels.includes(REVIEW_SHOTS_LABEL))
      assert.ok(!Object.hasOwn(body, 'design_canvas'))
    }
  })
}
