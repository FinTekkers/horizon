// HZ-117's cross-language parity guarantee, relocated to domain/ by HZ-128:
// "one declarative step table is the single source of truth. A test asserts
// the JS and Python views agree — same length, same kinds, same lane, same
// budgets — and fails if either drifts. This test must fail if a step is
// inserted into STEPS without the Python side updating."
//
// LOAD-BEARING LEG, read this before touching the file. HZ-128 collapsed the
// two committed step-table mirrors into one generated binding per language, so
// the two JS legs below are now generator-output vs generator-output — close
// to tautological, and honestly so. The ONE genuinely cross-language,
// cross-artifact comparison left is spawnedPythonSteps(): it boots a real
// python3, imports the COMMITTED domain/py/steps.py off disk, and diffs what
// that module actually produced against what the generator would render from
// domain/steps.json right now. That is what still fails if the Python binding
// is stale, hand-edited, or unimportable. Do not weaken or skip it.
//
// The Python side backs this up from its own end:
// farm/tests/test_domain_import.py (the module resolves and loads),
// farm/tests/test_steps.py (shape, duplicate labels, failure modes) and
// farm/tests/test_step_agent.py (STEP_CONFIG drift against the real table).
//
// Shape caveat, unchanged from HZ-117: the farm-shaped projection is
// agent-kind entries ONLY (both the PM and farm lanes — farmd's lane routing
// needs runsIn for both); the JS binding is EVERY entry, both kinds. A naive
// whole-array deepEqual across both would either always fail on length or
// silently skip real drift, so the comparisons below are per-kind.
//
// Modeled on definitions-parity.test.mjs's spawn-python-and-diff pattern.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { loadSource, toGeneratedSteps, REPO_ROOT } from '../../domain/generate.mjs'
import { STEPS as jsSteps, PHASES as jsPhases } from '../../domain/js/lifecycle.js'

function spawnedPythonSteps() {
  const script = 'import json; from domain.py import steps; print(json.dumps(steps.STEPS))'
  const out = execFileSync('python3', ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8' })
  return JSON.parse(out)
}

function spawnedPythonPhases() {
  const script = 'import json; from domain.py import steps; print(json.dumps(steps.PHASES))'
  const out = execFileSync('python3', ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8' })
  return JSON.parse(out)
}

const source = loadSource()
const expectedFarmView = toGeneratedSteps(source.steps)
const pythonFarm = spawnedPythonSteps()

test('the committed Python binding, imported by a real python3, matches what the generator renders from domain/steps.json today', () => {
  assert.ok(pythonFarm.length > 0, 'sanity: the spawned Python import produced an empty table')
  assert.deepEqual(
    pythonFarm,
    expectedFarmView,
    'domain/py/steps.py is stale or hand-edited — run `npm run gen:domain`',
  )
})

test('the committed JS binding matches the authored table in domain/steps.json, entry for entry', () => {
  assert.ok(jsSteps.length > 0, 'sanity: the JS binding exports an empty table')
  assert.deepEqual(jsSteps, source.steps, 'domain/js/lifecycle.js is stale or hand-edited — run `npm run gen:domain`')
  assert.deepEqual(jsPhases, source.phases)
})

test('both bindings agree on PHASES', () => {
  assert.deepEqual(spawnedPythonPhases(), jsPhases)
})

test('every agent-kind step agrees on index/label/agent across the authored table, the JS binding and the spawned Python import', () => {
  const jsAgentSteps = jsSteps.filter((s) => s.kind === 'agent')
  assert.equal(
    jsAgentSteps.length,
    pythonFarm.length,
    'the JS binding has a different number of agent-kind steps than the Python farm view',
  )

  for (const farmEntry of pythonFarm) {
    // The authored table has no `index` field — a farm entry's index IS its
    // position in the full table, so this is positional lookup, not a find().
    const jsEntry = jsSteps[farmEntry.index]
    assert.ok(jsEntry, `step "${farmEntry.label}" (index ${farmEntry.index}) is in the Python view but off the end of the JS table`)
    assert.equal(jsEntry.kind, 'agent', `index ${farmEntry.index} is a ${jsEntry.kind} in JS but reached the farm view`)
    assert.equal(jsEntry.label, farmEntry.label, `label drifted for index ${farmEntry.index}`)
    assert.equal(jsEntry.agent, farmEntry.agent, `agent drifted for index ${farmEntry.index}`)
  }
})

test('every agent-kind step agrees on lane, workspace-mutation, provider rules and turn budget between the authored table and the spawned Python import', () => {
  const FARM_ONLY_FIELDS = ['runsIn', 'workspaceMutating', 'providerOverrideEligible', 'providerLocked', 'maxTurns', 'timeoutS']
  for (const expected of expectedFarmView) {
    const pythonEntry = pythonFarm.find((s) => s.index === expected.index)
    assert.ok(pythonEntry, `index ${expected.index} ("${expected.label}") is missing from the Python view`)
    for (const field of FARM_ONLY_FIELDS) {
      assert.equal(pythonEntry[field], expected[field], `Python's ${field} drifted for "${expected.label}"`)
    }
  }
})

test('no gate ever reaches the farm view — gates are human-only and never dispatched', () => {
  const gates = jsSteps.filter((s) => s.kind === 'gate')
  assert.ok(gates.length > 0, 'sanity: there should be at least one gate step')
  const gateLabels = new Set(gates.map((g) => g.label))
  assert.ok(
    pythonFarm.every((s) => !gateLabels.has(s.label)),
    'a gate label leaked into the farm-dispatched view',
  )
  for (const gate of gates) {
    assert.equal(gate.gate, 'required')
    assert.ok(!('agent' in gate), `gate "${gate.label}" names an agent`)
    assert.ok(!('runsIn' in gate), `gate "${gate.label}" declares a lane`)
  }
})

test('the spawned Python import resolves the committed binding, not some other steps module on sys.path', () => {
  const script = 'from domain.py import steps; print(steps.__file__)'
  const resolved = execFileSync('python3', ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  assert.equal(resolved, path.join(REPO_ROOT, 'domain/py/steps.py'))
})
