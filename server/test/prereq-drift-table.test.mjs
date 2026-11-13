// HO-838: table-driven fail-closed, approval kept, tag tests
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-prereq-table-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const { STEPS, EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX, APPROVE_RUN_GATE_INDEX } = await import('../../domain/js/lifecycle.js')
const { REASON } = await import('../../domain/js/reasons.js')
import { loginFixtureUser } from './helpers/session.mjs'
import * as config from '../src/config.js'
import * as auth from '../src/auth.js'

store.purgeDemoItems()

const alice = loginFixtureUser(auth, config, { email: `alice-${Date.now()}@example.com`, name: 'Alice' })
const PIN = 'pin-table'
{
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(PIN, salt, 32)
  db.prepare('UPDATE user SET gate_pin_hash = ? WHERE id = ?').run(`${salt.toString('hex')}:${hash.toString('hex')}`, alice.user.id)
}
const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex')
const projectId = Number(db.prepare("INSERT INTO project (name, enabled) VALUES (?, 1)").run(`Prereq table ${Date.now()}`).lastInsertRowid)

function makePlan() {
  return `## Commands\n1. run\n\n## Run plan block\n\`\`\`json run-plan\n${JSON.stringify({ cwd: '.', commands: ['echo hi'], budget_minutes: 5 })}\n\`\`\``
}

async function importSeedPreflight() {
  const { seedPreflight } = await import('./helpers/preflight.mjs')
  return seedPreflight
}

test('approval columns unchanged after dispatch refusal', async () => {
  const seedPreflight = await importSeedPreflight()
  const plan = makePlan()
  const id = `HO-838-APPROVAL-${Date.now()}`
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, approved_plan_hash, approved_runner) VALUES (?, ?, 'High', ?, 'task', ?, ?, 'host')").run(id, `Task ${id}`, APPROVE_RUN_GATE_INDEX, projectId, sha256(plan))
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))").run(id, RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, plan)
  seedPreflight(db, store, id)

  // Fake farm returning MY_VAR failure
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/preflight')) {
      return { ok: true, status: 200, json: async () => ({ ok: false, failed: ['MY_VAR'], unmet: [{ kind: 'env', name: 'MY_VAR', reason: 'missing' }], elapsed_ms: 10 }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const runId = db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')").run(id, EXECUTE_STEP_INDEX, STEPS[EXECUTE_STEP_INDEX].agent).lastInsertRowid
    const before = db.prepare("SELECT approved_plan_hash, approved_runner FROM work_item WHERE id = ?").get(id)
    await orchestrator.refuseUnapprovedRun(runId, id, EXECUTE_STEP_INDEX)
    const after = db.prepare("SELECT approved_plan_hash, approved_runner FROM work_item WHERE id = ?").get(id)
    assert.equal(after.approved_plan_hash, before.approved_plan_hash)
    assert.equal(after.approved_runner, before.approved_runner)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('refusal carries prereq_drift tag, plain work failure does not', async () => {
  const plan = makePlan()
  const id = `HO-838-TAG-${Date.now()}`
  db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, approved_plan_hash, approved_runner) VALUES (?, ?, 'High', ?, 'task', ?, ?, 'host')").run(id, `Task ${id}`, APPROVE_RUN_GATE_INDEX, projectId, sha256(plan))
  db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))").run(id, RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, plan)
  const seedPreflight = await importSeedPreflight()
  seedPreflight(db, store, id)

  const origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/preflight')) {
      return { ok: true, status: 200, json: async () => ({ ok: false, failed: ['MY_VAR'], unmet: [], elapsed_ms: 1 }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const runId = db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')").run(id, EXECUTE_STEP_INDEX, STEPS[EXECUTE_STEP_INDEX].agent).lastInsertRowid
    await orchestrator.refuseUnapprovedRun(runId, id, EXECUTE_STEP_INDEX)
    const event = db.prepare("SELECT text FROM event WHERE item_id = ? ORDER BY id DESC LIMIT 1").get(id)
    assert.ok(event.text.includes('(prereq_drift)'), `should carry prereq_drift tag: ${event.text}`)

    // Plain work failure should not carry prereq_drift
    const id2 = `HO-838-TAG2-${Date.now()}`
    db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, approved_plan_hash, approved_runner) VALUES (?, ?, 'High', ?, 'task', ?, ?, 'host')").run(id2, `Task ${id2}`, EXECUTE_STEP_INDEX, projectId, sha256(plan))
    const runId2 = db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')").run(id2, EXECUTE_STEP_INDEX, STEPS[EXECUTE_STEP_INDEX].agent).lastInsertRowid
    // Simulate failing command result (not prereq_drift)
    orchestrator.failFarmRun(runId2, 'command failed: exit 1', null)
    const event2 = db.prepare("SELECT text FROM event WHERE item_id = ? ORDER BY id DESC LIMIT 1").get(id2)
    assert.ok(!event2.text.includes('prereq_drift'), `plain failure should not carry prereq_drift: ${event2.text}`)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('table-driven fail-closed: 400,500,503,504, connection refused, invalid JSON, no ok field, empty failed', async () => {
  const cases = [
    { name: '400', response: { status: 400, ok: false, json: async () => ({ error: 'bad' }) } },
    { name: '500', response: { status: 500, ok: false, json: async () => ({ error: 'server error' }) } },
    { name: '503', response: { status: 503, ok: false, json: async () => ({ error: 'unavailable' }) } },
    { name: '504', response: { status: 504, ok: false, json: async () => ({ error: 'timeout' }) } },
    { name: 'connection refused', error: new Error('fetch failed') },
    { name: 'invalid JSON', response: { status: 200, ok: true, json: async () => { throw new Error('invalid json') } } },
    { name: '200 no ok field', response: { status: 200, ok: true, json: async () => ({}) } },
    { name: '200 ok false empty failed', response: { status: 200, ok: true, json: async () => ({ ok: false, failed: [] }) } },
  ]

  for (const c of cases) {
    const id = `HO-838-FAIL-${c.name}-${Date.now()}-${Math.random()}`
    const plan = makePlan()
    db.prepare("INSERT INTO work_item (id, title, priority, cursor, kind, project_id, approved_plan_hash, approved_runner) VALUES (?, ?, 'High', ?, 'task', ?, ?, 'host')").run(id, `Task ${id}`, APPROVE_RUN_GATE_INDEX, projectId, sha256(plan))
    db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status, output, artifact, ended_at) VALUES (?, ?, 1, ?, 'done', 'ok', ?, datetime('now'))").run(id, RUN_PLAN_STEP_INDEX, STEPS[RUN_PLAN_STEP_INDEX].agent, plan)
    const seedPreflight = await importSeedPreflight()
    seedPreflight(db, store, id)

    const origFetch = globalThis.fetch
    if (c.error) {
      globalThis.fetch = async () => { throw c.error }
    } else {
      globalThis.fetch = async (url) => {
        if (String(url).includes('/preflight')) {
          if (c.response.status !== 200) {
            const err = new Error(c.response.json ? 'farm error' : 'error')
            err.status = c.response.status
            err.code = 'error'
            throw err
          }
          return c.response
        }
        return { ok: true, status: 200, json: async () => ({}) }
      }
    }

    const dispatches = []
    const origFetch2 = globalThis.fetch
    // Wrap to capture /steps/run calls
    globalThis.fetch = async (url, opts) => {
      const u = String(url)
      if (u.includes('/steps/run')) dispatches.push(u)
      if (u.includes('/preflight')) {
        if (c.error) throw c.error
        if (c.response.status !== 200) {
          const err = new Error('farm error')
          err.status = c.response.status
          throw err
        }
        return c.response
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }

    try {
      const runId = db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, ?, 'active')").run(id, EXECUTE_STEP_INDEX, STEPS[EXECUTE_STEP_INDEX].agent).lastInsertRowid
      const result = await orchestrator.refuseUnapprovedRun(runId, id, EXECUTE_STEP_INDEX)
      assert.ok(result, `should refuse for case ${c.name}`)
      assert.equal(result.error, REASON.PREREQ_DRIFT, `should be prereq_drift for ${c.name}`)
      assert.equal(dispatches.length, 0, `should send no /steps/run for ${c.name}`)
    } finally {
      globalThis.fetch = origFetch
    }
  }
})
