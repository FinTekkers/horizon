// HZ-539 guardrail 1: a sub-step run keeps its anchor's step_index, so a done
// sub-step row written after its anchor's must never shadow the anchor's row.
// Every reader of one global step's runs filters `substep_id IS NULL`: with a
// later 'impl-audit' row at Implement, each one still returns Implement's own.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginFixtureUser } from './helpers/session.mjs'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-substep-shadowing-')), 'test.db')
process.env.FARM_URL = 'http://farm.test'
process.env.FARM_RUN_STATE_POLL_MS = String(60 * 60 * 1000)
delete process.env.FARM_STEP_INDEXES
delete process.env.GITHUB_WEBHOOK_SECRET

const { db } = await import('../src/db.js')
const store = await import('../src/store.js')
const orchestrator = await import('../src/orchestrator.js')
const storedTestResults = await import('../src/storedTestResults.js')
const { buildApp } = await import('../src/app.js')
const auth = await import('../src/auth.js')
const config = await import('../src/config.js')
const { STEPS, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX } = await import('../../domain/js/lifecycle.js')

const posts = []
globalThis.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null
  if (String(url).includes('/steps/run')) posts.push(body)
  return { ok: true, status: 200, json: async () => ({}) }
}

store.purgeDemoItems()
orchestrator.init({ info: () => {}, warn: () => {} })
const app = buildApp({ logger: false })
const { cookie } = loginFixtureUser(auth, config)
const get = (url) => app.inject({ method: 'GET', url, headers: { cookie } })

const ID = 'S-SHADOW'
db.prepare("INSERT INTO work_item (id, title, priority, cursor) VALUES (?, 'Shadowing', 'Medium', ?)").run(ID, REVIEW_STEP_INDEX)
const insertRun = db.prepare(
  "INSERT INTO step_run (item_id, step_index, substep_id, attempt, agent, status, output, artifact, started_at, ended_at) VALUES (?, ?, ?, ?, ?, 'done', ?, ?, '2026-10-01 10:00:00', '2026-10-01 10:05:00')",
)
const anchorRunId = insertRun.run(ID, IMPLEMENT_STEP_INDEX, null, 1, 'Eng', 'anchor output', 'anchor artifact').lastInsertRowid
// The audit after Implement, done later: same step_index, a higher id.
insertRun.run(ID, IMPLEMENT_STEP_INDEX, 'impl-audit', 1, 'Eng', 'audit output', 'audit findings')

test('the store reads Implement’s own row: latest artifact, attempt history, next attempt and the item view', () => {
  assert.equal(store.latestArtifact(ID, IMPLEMENT_STEP_INDEX), 'anchor artifact')
  assert.equal(store.listStepAttempts(ID, IMPLEMENT_STEP_INDEX).length, 1)
  assert.equal(store.nextStepAttempt(ID, IMPLEMENT_STEP_INDEX).attempt, 2)
  const item = store.getItem(ID)
  assert.ok(!JSON.stringify(item).includes('audit'), 'no sub-step output or artifact reaches the item view')
})

test('the stored test results read Implement’s own run', () => {
  assert.equal(storedTestResults.latestImplementRunId(ID), Number(anchorRunId))
})

test('the artifact and output pages, with no ?substep, show Implement’s own row', async () => {
  const artifact = await get(`/api/items/${ID}/artifacts/${IMPLEMENT_STEP_INDEX}`)
  assert.equal(artifact.statusCode, 200)
  assert.match(artifact.body, /anchor artifact/)
  assert.doesNotMatch(artifact.body, /audit findings/)
  const version = await get(`/api/items/${ID}/artifacts/${IMPLEMENT_STEP_INDEX}/1`)
  assert.equal(version.statusCode, 200)
  assert.match(version.body, /anchor artifact/)
  const output = await get(`/api/items/${ID}/steps/${IMPLEMENT_STEP_INDEX}/output`)
  assert.equal(output.statusCode, 200)
  assert.match(output.body, /anchor output/)
  assert.doesNotMatch(output.body, /audit output/)
})

test('the next global step’s prior artifacts carry Implement’s own row, not the audit’s', async () => {
  orchestrator.kick(ID)
  const deadline = Date.now() + 2000
  while (!posts.some((p) => p.item.id === ID) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  orchestrator.cancel(ID)
  const body = posts.find((p) => p.item.id === ID)
  assert.ok(body, 'review was dispatched')
  assert.equal(body.step.index, REVIEW_STEP_INDEX)
  const implement = body.artifacts.filter((a) => a.label === STEPS[IMPLEMENT_STEP_INDEX].label)
  assert.deepEqual(implement.map((a) => a.content), ['anchor artifact'])
  assert.ok(!JSON.stringify(body.artifacts).includes('audit'))
})

test('gate_decision has a nullable substep_id, and a global decision reads NULL', () => {
  const column = db.prepare('PRAGMA table_info(gate_decision)').all().find((c) => c.name === 'substep_id')
  assert.deepEqual(column && { type: column.type, notnull: column.notnull, dflt: column.dflt_value }, { type: 'TEXT', notnull: 0, dflt: null })
  const id = db.prepare("INSERT INTO gate_decision (item_id, step_index, decision) VALUES (?, 13, 'approved')").run(ID).lastInsertRowid
  assert.equal(db.prepare('SELECT substep_id FROM gate_decision WHERE id = ?').get(id).substep_id, null)
})

// The readers the cases above cannot reach without a whole gate or caretaker
// setup (planReview, split, heldAccept, caretaker*, the duration samples):
// every SQL statement that reads step_run for one step_index — a bound `?`,
// a gate's `w.cursor - 1` or an interpolated index — names `substep_id IS NULL`.
// A reader by run id, or one over every step, is not a single-step reader.
test('every single-step step_run reader in server/src filters substep_id IS NULL', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url))
  const missing = []
  let readers = 0
  for (const file of readdirSync(SRC).filter((f) => f.endsWith('.js') && f !== 'db.js')) {
    const text = readFileSync(join(SRC, file), 'utf8')
    for (const match of text.matchAll(/FROM step_run\b/g)) {
      const rest = text.slice(match.index)
      // The statement's WHERE runs to the next statement, subquery close or string end.
      const end = rest.slice(1).search(/FROM step_run\b|\),\s*0\)|[`"]\s*[,)]|'\)(?:\s*$|\.)|',\s*$/m)
      const sql = end === -1 ? rest : rest.slice(0, end + 1)
      if (!/\bstep_index\s*(?:=|<)/.test(sql)) continue
      if (/^FROM step_run\s+WHERE status = 'active' AND step_index IN/.test(sql)) continue
      readers++
      if (!/substep_id IS NULL/.test(sql)) {
        const line = text.slice(0, match.index).split('\n').length
        missing.push(`${file}:${line}`)
      }
    }
  }
  assert.deepEqual(missing, [])
  assert.ok(readers >= 30, `found ${readers} single-step readers — the scan no longer sees them`)
})
