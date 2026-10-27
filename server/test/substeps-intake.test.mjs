// HZ-538 metrics 2 and 3, and the no-dispatch and byte-identical guardrails:
// the sub-step snapshot at intake, through the real store and orchestrator.
//
// Each scenario is its own process and database (helpers/substepsIntakeChild.mjs):
// six issues are synced in with upsertFromGithub, the orchestrator dispatches
// each one's first step to a stub farm, and the child reports the rows and
// the /steps/run bodies. 'none' — the project has no steps.json — is the
// baseline every other scenario's dispatch must equal.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CHILD = fileURLToPath(new URL('./helpers/substepsIntakeChild.mjs', import.meta.url))

function run(scenario) {
  const env = { ...process.env }
  delete env.HORIZON_FARM_DIR
  delete env.HORIZON_DB
  const out = execFileSync(process.execPath, [CHILD, scenario], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 })
  return JSON.parse(out.trim().split('\n').at(-1))
}

const SCENARIOS = Object.fromEntries(['on', 'off', 'none', 'bad'].map((s) => [s, run(s)]))
const IDS = ['AC-1', 'LG-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6']
const snapshotIds = (item) => (item.substeps_json === null ? null : JSON.parse(item.substeps_json).map((s) => s.id))

// project_context carries each item's updated_at, which is wall-clock time
// and so differs between two processes; everything else must match exactly.
const stable = (body) => JSON.parse(JSON.stringify(body, (key, value) => (key === 'updated_at' ? '<time>' : value)))

test('switch on: label, repo and path matches each hold exactly their sub-steps; a non-match keeps null', () => {
  const { items } = SCENARIOS.on
  assert.deepEqual(
    Object.fromEntries(IDS.map((id) => [id, snapshotIds(items[id])])),
    {
      'AC-1': ['golden-cases', 'impl-audit'], // by label, case-insensitively
      'LG-2': ['ledger-opening'], // by repo
      'AC-3': ['pricing-paths'], // by a path in the description
      'AC-4': null, // matches nothing
      'AC-5': ['dual-change'], // a change gets only the anchor-1 sub-step
      'AC-6': ['dual-task'], // a task with the same label only the anchor-17 one
    },
  )
  assert.deepEqual(JSON.parse(items['AC-1'].substeps_json)[0], {
    id: 'golden-cases',
    label: 'Golden test cases',
    kind: 'opening',
    anchor: 1,
    persona: 'data_integrity',
    output: 'golden_cases',
    applies: { labels: ['valuation'], repos: [], paths: [] },
  })
})

test('switch on: every item dispatches the same step, step_index and agent as a project with no definitions', () => {
  for (const id of IDS) {
    const on = SCENARIOS.on.items[id]
    const none = SCENARIOS.none.items[id]
    assert.ok(on.runs.length >= 1 && none.runs.length >= 1, `${id} really dispatched`)
    assert.equal(on.cursor, none.cursor, id)
    assert.equal(on.label, none.label, id)
    assert.deepEqual(on.runs, none.runs, id)
  }
  assert.equal(SCENARIOS.on.items['AC-6'].runs[0].step_index, 16, 'the task really is a task')
})

test('no sub-step is dispatched: substep_cursor and every substep_id stay null, and the farm body names none', () => {
  for (const scenario of ['on', 'off', 'none', 'bad']) {
    for (const id of IDS) {
      const item = SCENARIOS[scenario].items[id]
      assert.equal(item.substep_cursor, null, `${scenario} ${id}`)
      assert.ok(item.runs.every((r) => r.substep_id === null), `${scenario} ${id}`)
      assert.ok(item.body, `${scenario} ${id} was posted to the farm`)
      const text = JSON.stringify(item.body)
      for (const key of ['substeps_json', 'substep_id', 'substep_cursor']) assert.ok(!text.includes(key), `${scenario} ${id} body has ${key}`)
    }
  }
})

test('the /steps/run body for a matched item equals the no-definitions body, switch on or off', () => {
  for (const scenario of ['on', 'off']) {
    for (const id of IDS) {
      assert.deepEqual(stable(SCENARIOS[scenario].items[id].body), stable(SCENARIOS.none.items[id].body), `${scenario} ${id}`)
    }
  }
})

test('switch off: a matching item keeps null, and steps.json is never read', () => {
  const { items, reads } = SCENARIOS.off
  for (const id of IDS) assert.equal(items[id].substeps_json, null, id)
  assert.deepEqual(reads, [])
  for (const id of IDS) {
    assert.equal(items[id].cursor, SCENARIOS.none.items[id].cursor, id)
    assert.deepEqual(items[id].runs, SCENARIOS.none.items[id].runs, id)
  }
})

test('a file that fails to load: the sync does not throw, nothing is snapshotted, and the error names the id', () => {
  const { items, errors } = SCENARIOS.bad
  for (const id of IDS) {
    assert.equal(items[id].substeps_json, null, id)
    assert.deepEqual(items[id].runs, SCENARIOS.none.items[id].runs, id)
  }
  assert.ok(errors.some((e) => e.includes('substep "gated-audit": a sub-step has no gate of its own')), errors.join('\n'))
})

test('a later sync keeps the first snapshot even after the file changes', () => {
  const { resynced, items } = SCENARIOS.on
  assert.equal(resynced.title, 'Matched by label (edited)')
  assert.equal(resynced.substeps_json, items['AC-1'].substeps_json)
})
