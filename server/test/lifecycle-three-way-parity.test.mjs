// HZ-117: "one declarative step table is the single source of truth. A test
// asserts the JS and Python views agree — same length, same kinds, same
// lane, same budgets — and fails if either drifts. This test must fail if a
// step is inserted into STEPS without the Python side updating." Widened by
// the architecture CORRECTION to three-way: server, farm (Python), and now
// the UI, since ui/src/domain/lifecycle.js's STEPS is also generated from
// the same table (steps_generated.json) rather than hand-copied.
//
// Shape caveat (QA review, pre-execution gate): server's toGeneratedSteps()
// is agent-kind entries ONLY (both the PM and farm lanes — farmd's lane
// routing needs runsIn for both); the UI's toUiSteps()/STEPS is EVERY entry,
// both kinds. A naive whole-array deepEqual across all three would either
// always fail on length or silently skip real drift. So this file:
//   1. Three-way-compares every AGENT-kind step's shared fields (index,
//      label, agent) across live JS, the committed farm JSON, the spawned
//      Python import, and the UI's kind==='agent' subset.
//   2. Separately three-way-compares every agent-kind step's farm-only
//      fields (runsIn, workspaceMutating, providerOverrideEligible,
//      providerLocked, maxTurns, timeoutS) across live JS, farm JSON and
//      Python only — the UI never carries these.
//   3. Two-way-compares every GATE-kind step between live JS and the UI's
//      kind==='gate' subset — farm has zero view into gates (they're never
//      dispatched), so gates can only ever be a two-way check.
//
// Modeled on definitions-parity.test.mjs's spawn-python-and-diff pattern —
// this repo already has this pattern working for prompt-composition parity.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { toGeneratedSteps, toUiSteps } from '../src/lifecycle.js'
import uiSteps from '../../ui/src/domain/steps_generated.json' with { type: 'json' }

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

function pythonFarmSteps() {
  const script = "import json; from farm.steps import STEPS; print(json.dumps(STEPS))"
  const out = execFileSync('python3', ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8' })
  return JSON.parse(out)
}

const liveJs = toGeneratedSteps()
const committedFarmJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'farm/steps_generated.json'), 'utf8'))
const pythonFarm = pythonFarmSteps()
const liveUi = toUiSteps()

test('live JS, the committed farm JSON, and the spawned Python loader all agree on the full farm-shaped view', () => {
  assert.deepEqual(liveJs, committedFarmJson, 'farm/steps_generated.json has drifted from a live gen:steps run')
  assert.deepEqual(liveJs, pythonFarm, 'farm/steps.py is reading something other than what lifecycle.js would generate today')
})

test('the committed UI JSON matches a live toUiSteps() derivation', () => {
  assert.deepEqual(liveUi, uiSteps, 'ui/src/domain/steps_generated.json has drifted from a live gen:steps run')
})

test('every agent-kind step agrees on index/label/agent across server, farm and UI — three-way', () => {
  const uiAgentSteps = liveUi.filter((s) => s.kind === 'agent')
  assert.equal(uiAgentSteps.length, liveJs.length, 'the UI has a different number of agent-kind steps than the farm view')

  for (const farmEntry of liveJs) {
    const uiEntry = uiAgentSteps.find((s) => s.index === farmEntry.index)
    assert.ok(uiEntry, `step "${farmEntry.label}" (index ${farmEntry.index}) is in the farm view but missing from the UI's agent-kind steps`)
    assert.equal(uiEntry.label, farmEntry.label, `label drifted for index ${farmEntry.index}`)
    assert.equal(uiEntry.agent, farmEntry.agent, `agent drifted for index ${farmEntry.index}`)

    const pythonEntry = pythonFarm.find((s) => s.index === farmEntry.index)
    assert.equal(pythonEntry.label, farmEntry.label, `Python's label drifted for index ${farmEntry.index}`)
    assert.equal(pythonEntry.agent, farmEntry.agent, `Python's agent drifted for index ${farmEntry.index}`)
  }
})

test('every agent-kind step agrees on lane, workspace-mutation, provider rules and turn budget across server, farm and Python', () => {
  const FARM_ONLY_FIELDS = ['runsIn', 'workspaceMutating', 'providerOverrideEligible', 'providerLocked', 'maxTurns', 'timeoutS']
  for (const jsEntry of liveJs) {
    const jsonEntry = committedFarmJson.find((s) => s.index === jsEntry.index)
    const pythonEntry = pythonFarm.find((s) => s.index === jsEntry.index)
    for (const field of FARM_ONLY_FIELDS) {
      assert.equal(jsonEntry[field], jsEntry[field], `farm JSON's ${field} drifted for "${jsEntry.label}"`)
      assert.equal(pythonEntry[field], jsEntry[field], `Python's ${field} drifted for "${jsEntry.label}"`)
    }
  }
})

test('every gate-kind step agrees between server and the UI — two-way only, farm never dispatches a gate', () => {
  const jsGates = liveUi.filter((s) => s.kind === 'gate')
  const uiGates = uiSteps.filter((s) => s.kind === 'gate')
  assert.deepEqual(jsGates, uiGates)
  assert.ok(jsGates.length > 0, 'sanity: there should be at least one gate step to compare')

  // Farm's generated view carries zero gate entries at all — confirms the
  // two-way-only claim rather than assuming it. (Farm entries have no
  // `kind` field at all — toGeneratedSteps() never emits one — so this
  // checks by label instead.)
  const gateLabels = new Set(jsGates.map((g) => g.label))
  assert.ok(
    committedFarmJson.every((s) => !gateLabels.has(s.label)),
    'a gate label leaked into the farm-dispatched view',
  )
})
