// HO-837: pipeline_v4_preflight_shift. Inserting task.preflight before Approve
// the run moves every stored step position from it on up by one — cursor and
// notified_step, every step_index and gate_index column, the provider-choice
// keys and each stored sub-step's anchor — once, and never again.
//
// A database is booted once (the current schema), its shift setting removed
// and rows seeded at their pre-HO-837 positions, then db.js boots on it again
// in its own process, as a deploy does.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { PREFLIGHT_STEP_INDEX, stepIndexOf } from '../../domain/js/lifecycle.js'

const DB_MODULE = fileURLToPath(new URL('../src/db.js', import.meta.url))
const SETTING = 'pipeline_v4_preflight_shift'

function boot(path) {
  const env = { ...process.env, HORIZON_DB: path }
  delete env.HORIZON_REPO
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(DB_MODULE)})`], { env })
}

// Where a step sat before Preflight was inserted: one lower from it on.
const before = (key) => {
  const index = stepIndexOf(key)
  return index > PREFLIGHT_STEP_INDEX ? index - 1 : index
}

test('the shift boundary is the Preflight step, read from the step table', () => {
  assert.equal(PREFLIGHT_STEP_INDEX, stepIndexOf('task.preflight'))
  assert.equal(stepIndexOf('task.approve-run'), PREFLIGHT_STEP_INDEX + 1)
  assert.equal(before('task.approve-run'), PREFLIGHT_STEP_INDEX)
})

test('a pre-HO-837 database shifts every step position at or after Preflight once; a second boot changes nothing', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-preflight-shift-')), 'test.db')
  boot(path)
  const IMPACT = before('task.impact-review')
  const GATE = before('task.approve-run')
  const EXECUTE = before('task.execute')
  const INVENTORY = before('plan.inventory')
  const PLAN_QUESTION = before('plan.define-question')
  const PLAN_GUARDRAILS = before('plan.set-guardrails')
  {
    const db = new Database(path)
    db.prepare('DELETE FROM work_item').run()
    db.prepare('DELETE FROM setting WHERE key = ?').run(SETTING)
    const projectId = Number(db.prepare("INSERT INTO project (name, provider_defaults_json) VALUES ('Shift', ?)").run(JSON.stringify({ [PLAN_QUESTION]: 'muse', 2: 'claude' })).lastInsertRowid)
    const item = db.prepare('INSERT INTO work_item (id, title, priority, cursor, kind, project_id, notified_step, provider_choices_json, substeps_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    item.run('SH-IMPACT', 'impact', 'High', IMPACT, 'task', projectId, null, null, null)
    item.run('SH-GATE', 'gate', 'High', GATE, 'task', projectId, GATE, null, JSON.stringify([{ id: 'exec-audit', label: 'Audit', kind: 'audit', anchor: EXECUTE }, { id: 'verify', label: 'Verify', kind: 'opening', anchor: 17 }]))
    item.run('SH-PLAN', 'plan', 'High', INVENTORY, 'plan', projectId, null, JSON.stringify({ [PLAN_QUESTION]: 'muse', [PLAN_GUARDRAILS]: 'claude', 11: 'muse' }), null)
    const run = db.prepare("INSERT INTO step_run (item_id, step_index, attempt, agent, status) VALUES (?, ?, 1, 'X', 'done')")
    run.run('SH-IMPACT', IMPACT)
    const gateRun = Number(run.run('SH-GATE', GATE).lastInsertRowid)
    run.run('SH-PLAN', INVENTORY)
    db.prepare("INSERT INTO gate_decision (item_id, step_index, decision, decided_by) VALUES ('SH-GATE', ?, 'approved', 'x')").run(GATE)
    db.prepare("INSERT INTO caretaker_eval (item_id, gate_index, arrival_run_id, mode, decision, reason) VALUES ('SH-GATE', ?, ?, 'shadow', 'wait', 'r')").run(GATE, gateRun)
    db.close()
  }

  boot(path)
  const read = () => {
    const db = new Database(path, { readonly: true })
    const out = {
      items: db.prepare('SELECT id, cursor, notified_step, provider_choices_json, substeps_json FROM work_item ORDER BY id').all(),
      runs: db.prepare('SELECT item_id, step_index FROM step_run ORDER BY id').all(),
      decisions: db.prepare('SELECT step_index FROM gate_decision').all().map((r) => r.step_index),
      evals: db.prepare('SELECT gate_index FROM caretaker_eval').all().map((r) => r.gate_index),
      defaults: db.prepare("SELECT provider_defaults_json FROM project WHERE name = 'Shift'").get().provider_defaults_json,
      setting: db.prepare('SELECT value FROM setting WHERE key = ?').get(SETTING)?.value ?? null,
    }
    db.close()
    return out
  }
  const after = read()
  const byId = Object.fromEntries(after.items.map((r) => [r.id, r]))
  assert.equal(byId['SH-IMPACT'].cursor, stepIndexOf('task.impact-review'), 'a position before Preflight stays')
  assert.equal(byId['SH-GATE'].cursor, stepIndexOf('task.approve-run'))
  assert.equal(byId['SH-GATE'].notified_step, stepIndexOf('task.approve-run'))
  assert.equal(byId['SH-PLAN'].cursor, stepIndexOf('plan.inventory'))
  assert.deepEqual(
    after.runs.map((r) => r.step_index),
    [stepIndexOf('task.impact-review'), stepIndexOf('task.approve-run'), stepIndexOf('plan.inventory')],
  )
  assert.deepEqual(after.decisions, [stepIndexOf('task.approve-run')])
  assert.deepEqual(after.evals, [stepIndexOf('task.approve-run')], 'a gate_index column is found and shifted too')
  assert.deepEqual(JSON.parse(byId['SH-PLAN'].provider_choices_json), {
    11: 'muse',
    [stepIndexOf('plan.define-question')]: 'muse',
    [stepIndexOf('plan.set-guardrails')]: 'claude',
  })
  assert.deepEqual(JSON.parse(after.defaults), { 2: 'claude', [stepIndexOf('plan.define-question')]: 'muse' })
  assert.deepEqual(
    JSON.parse(byId['SH-GATE'].substeps_json).map((s) => s.anchor),
    [stepIndexOf('task.execute'), 17],
  )
  assert.equal(after.setting, 'done')

  boot(path)
  assert.deepEqual(read(), after, 'a second boot is a no-op')
})

test('a fresh database runs the shift on no rows and records it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'horizon-preflight-shift-fresh-')), 'test.db')
  boot(path)
  const db = new Database(path, { readonly: true })
  assert.equal(db.prepare('SELECT value FROM setting WHERE key = ?').get(SETTING).value, 'done')
  db.close()
})
