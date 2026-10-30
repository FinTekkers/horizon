// HZ-541 guardrail 4: golden cases are off for a project with its definitions
// switch off (with or without a golden_cases sub-step in the snapshot) and
// for an item whose snapshot has no golden_cases sub-step. Off, the item
// serves no goldenCases key, its first gate approves with no hash, and
// Draft implementation plan, Implement and Review dispatch exactly as an item
// with no definitions at all: same step, same personas, same artifacts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-golden-off-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
delete process.env.FARM_STEP_INDEXES
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.GITHUB_TOKEN

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX, requiredStepIndex } = await import('../../domain/js/lifecycle.js')

const posts = []
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  if (String(url).includes('/steps/run')) posts.push(body)
  return { ok: true, status: 200, json: async () => ({}) }
}

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {} })
const app = buildApp({ logger: false })
const { cookie, pin } = loginFixtureUser(auth, config)
await app.ready()

const FIRST_GATE = requiredStepIndex('Approve & prioritize this work')
const PLAN_STEP = requiredStepIndex('Draft implementation plan')
const GOLDEN = { id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: 1, persona: null, output: 'golden_cases', applies: { labels: ['x'], repos: [], paths: [] } }
const AUDIT = { id: 'impl-audit', label: 'Audit the change', kind: 'audit', anchor: IMPLEMENT_STEP_INDEX, persona: null, output: 'findings', applies: { labels: ['x'], repos: [], paths: [] } }
const project = (name, on) => Number(db.prepare('INSERT INTO project (name, enabled, definitions_enabled) VALUES (?, 1, ?)').run(name, on ? 1 : 0).lastInsertRowid)
const OFF = project('Switch off', false)
const ON = project('Switch on', true)

const SETUPS = [
  ['switch off, no definitions', OFF, null],
  ['switch off, a golden_cases sub-step', OFF, [GOLDEN]],
  ['switch on, no golden_cases sub-step', ON, [AUDIT]],
]

function seed(id, cursor, projectId, substeps) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id, substeps_json) VALUES (?, 'Same title', 'Medium', ?, ?, ?)").run(
    id,
    cursor,
    projectId,
    substeps && JSON.stringify(substeps),
  )
}

async function dispatched(id) {
  orchestrator.kick(id)
  const deadline = Date.now() + 3000
  while (!posts.some((p) => p.item.id === id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  orchestrator.cancel(id)
  return posts.find((p) => p.item.id === id) ?? null
}

// What must not differ between an item and its no-definitions twin.
const shape = (body) => ({ step: body.step, personas: body.item.personas, persona: body.item.persona, artifacts: body.artifacts.map((a) => a.label), golden: Object.hasOwn(body, 'golden_cases') })

// The twin: no project, no snapshot — the feature cannot apply.
const baseline = {}
for (const stepIndex of [PLAN_STEP, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX]) {
  seed(`BASE-${stepIndex}`, stepIndex, null, null)
  baseline[stepIndex] = shape(await dispatched(`BASE-${stepIndex}`))
}

SETUPS.forEach(([name, projectId, substeps], n) => {
  test(`${name}: no goldenCases key, and the first gate approves with no hash`, async () => {
    const id = `OFF-GATE-${n}`
    seed(id, FIRST_GATE, projectId, substeps)
    assert.ok(!Object.hasOwn(store.itemViewById(id), 'goldenCases'))
    const res = await app.inject({ method: 'POST', url: `/api/items/${id}/gates/${FIRST_GATE}/approve`, headers: { cookie, 'x-human-key': pin }, payload: {} })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM golden_case_set').get().n, 0)
  })

  test(`${name}: Draft implementation plan, Implement and Review dispatch as with no definitions`, async () => {
    for (const stepIndex of [PLAN_STEP, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX]) {
      const id = `OFF-RUN-${n}-${stepIndex}`
      seed(id, stepIndex, projectId, substeps)
      const body = await dispatched(id)
      assert.ok(body, `step ${stepIndex} was dispatched`)
      assert.deepEqual(shape(body), baseline[stepIndex])
    }
  })
})
