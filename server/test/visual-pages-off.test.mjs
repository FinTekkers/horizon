// HO-862 metric 4: web-page visuals are off by default. With the project's
// switch off — and on any tenant project even with the column at 1 — no
// /steps/run body carries `visual_pages`, the item view has no `visualPage`,
// and a result's `artifacts.page` records nothing. Off, a step dispatches
// exactly as on an item with no project: same step, personas and artifacts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-visual-pages-off-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
delete process.env.FARM_STEP_INDEXES
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.GITHUB_TOKEN

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const visualPages = await import('../src/visualPages.js')
const { requiredStepIndex } = await import('../../domain/js/lifecycle.js')

const posts = []
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  if (String(url).includes('/steps/run')) posts.push(body)
  return { ok: true, status: 200, json: async () => ({}) }
}

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {} })

const OPTIONS_STEP = requiredStepIndex('Plan options & trade-offs (pros / cons)')
const PLAN_STEP = requiredStepIndex('Draft implementation plan')
const ARCH_STEP = requiredStepIndex('Architecture review')
const project = (name, columns = {}) => {
  const row = { name, enabled: 1, ...columns }
  const keys = Object.keys(row)
  return Number(db.prepare(`INSERT INTO project (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...Object.values(row)).lastInsertRowid)
}
const DEFAULT = project('Default project')
const ON = project('Switch on', { visual_pages_enabled: 1 })
const TENANT = project('Tenant on', { visual_pages_enabled: 1, isolation: 'tenant', github_token_ref: '$TENANT_TOKEN', run_user: 'tenantrun' })

function seed(id, cursor, projectId) {
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, 'Same title', 'Medium', ?, ?)").run(id, cursor, projectId)
}

async function dispatched(id) {
  orchestrator.kick(id)
  const deadline = Date.now() + 3000
  while (!posts.some((p) => p.item.id === id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  orchestrator.cancel(id)
  return posts.find((p) => p.item.id === id) ?? null
}

const shape = (body) => ({ step: body.step, personas: body.item.personas, artifacts: body.artifacts.map((a) => a.label), visual: Object.hasOwn(body, 'visual_pages') })
const PAGE = { round: 1, sha256: 'a'.repeat(64), bytes: 120, shots: { desktop: 'page-r1-desktop.png', phone: 'page-r1-phone.png' } }

const baseline = {}
for (const stepIndex of [OPTIONS_STEP, PLAN_STEP]) {
  seed(`VP-BASE-${stepIndex}`, stepIndex, null)
  baseline[stepIndex] = shape(await dispatched(`VP-BASE-${stepIndex}`))
}

test('a new project has the switch off, and the project view says so', () => {
  assert.equal(db.prepare('SELECT visual_pages_enabled FROM project WHERE id = ?').get(store.createProject('Fresh').id).visual_pages_enabled, 0)
  assert.ok(!Object.hasOwn(store.listProjects().find((p) => p.id === DEFAULT), 'visualPagesEnabled'))
  assert.equal(store.listProjects().find((p) => p.id === ON).visualPagesEnabled, true)
})

test('switch off: the page steps dispatch as with no project, with no visual_pages key and no visualPage', async () => {
  for (const stepIndex of [OPTIONS_STEP, PLAN_STEP]) {
    const id = `VP-OFF-${stepIndex}`
    seed(id, stepIndex, DEFAULT)
    const body = await dispatched(id)
    assert.ok(body, `step ${stepIndex} was dispatched`)
    assert.deepEqual(shape(body), baseline[stepIndex])
    assert.ok(!Object.hasOwn(store.itemViewById(id), 'visualPage'))
  }
})

test('switch off: a result page is not recorded', () => {
  seed('VP-OFF-REC', OPTIONS_STEP, DEFAULT)
  const run = db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES ('VP-OFF-REC', ?, 1, 'Ensemble', 'done')").run(OPTIONS_STEP)
  assert.ok(visualPages.recordPageRound(Number(run.lastInsertRowid), store.getItem('VP-OFF-REC'), OPTIONS_STEP, PAGE).error)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_page_round').get().n, 0)
  assert.ok(!Object.hasOwn(store.itemViewById('VP-OFF-REC'), 'visualPage'))
})

test('a tenant project stays off with the column at 1: no flag, nothing recorded, and it cannot be switched on', async () => {
  seed('VP-TENANT', OPTIONS_STEP, TENANT)
  const item = store.getItem('VP-TENANT')
  assert.equal(visualPages.visualPagesEnabled(item), false)
  assert.equal(visualPages.visualPagesFor(item, OPTIONS_STEP), false)
  const body = await dispatched('VP-TENANT')
  if (body) assert.ok(!Object.hasOwn(body, 'visual_pages'))
  const run = db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES ('VP-TENANT', ?, 1, 'Ensemble', 'done')").run(OPTIONS_STEP)
  assert.ok(visualPages.recordPageRound(Number(run.lastInsertRowid), item, OPTIONS_STEP, PAGE).error)
  db.prepare('UPDATE project SET visual_pages_enabled = 0 WHERE id = ?').run(TENANT)
  assert.deepEqual(store.setProjectVisualPagesEnabled(TENANT, true, 'test'), { error: 'tenant' })
  assert.equal(db.prepare('SELECT visual_pages_enabled FROM project WHERE id = ?').get(TENANT).visual_pages_enabled, 0)
})

test('switch on: only the page steps carry visual_pages — a reviewer step does not', async () => {
  seed('VP-ON-OPT', OPTIONS_STEP, ON)
  assert.equal((await dispatched('VP-ON-OPT')).visual_pages, true)
  seed('VP-ON-ARCH', ARCH_STEP, ON)
  const arch = await dispatched('VP-ON-ARCH')
  assert.ok(arch, 'Architecture review was dispatched')
  assert.ok(!Object.hasOwn(arch, 'visual_pages'))
})
