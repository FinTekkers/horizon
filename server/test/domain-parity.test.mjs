// HZ-117's cross-language parity guarantee, relocated to domain/ by HZ-128:
// "one declarative step table is the single source of truth. A test asserts
// the JS and Python views agree — same length, same kinds, same lane, same
// budgets — and fails if either drifts. This test must fail if a step is
// inserted into STEPS without the Python side updating."
//
// LOAD-BEARING LEG, read this before touching the file. spawnedPythonSteps()
// boots a real python3, imports the COMMITTED domain/py/steps.py off disk, and
// diffs what that module actually produced against what the JS binding — a
// separate hand-written implementation in a separate language — implies. Do not
// weaken or skip it.
//
// HZ-139 made this stronger. Under HZ-128 both sides of the comparison came out
// of the same generator, so it was close to tautological and said so. Now the
// two bindings are independent hand-written source, and the farm projection is
// reimplemented below rather than imported from either of them, so a drift in
// _project_farm_view is caught by a third opinion instead of by its own author.
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
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { STEPS as jsSteps, PHASES as jsPhases } from '../../domain/js/lifecycle.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

// The farm-shaped projection, reimplemented here on purpose (HZ-139). It used
// to be imported from the generator that also PRODUCED the Python table, which
// made the comparison below generator-output vs generator-output. The rule now
// lives once in production code (domain/py/steps.py's _project_farm_view) and
// once here, in a test whose whole job is to disagree with it. That is what
// turns this file into a real cross-language check rather than a tautology.
// HZ-377 extends the rule this reimplementation encodes: runner-less rows
// reach no lane, so they are out of the farm view alongside the gates.
function expectedFarmViewOf(steps) {
  return steps
    .map((s, index) => ({ ...s, index }))
    .filter((s) => s.kind === 'agent' && s.runsIn !== 'none')
    .map((s) => ({
      index: s.index,
      label: s.label,
      agent: s.agent,
      runsIn: s.runsIn,
      workspaceMutating: s.workspaceMutating ?? null,
      providerOverrideEligible: s.providerOverrideEligible ?? null,
      providerLocked: s.providerLocked ?? null,
      maxTurns: s.maxTurns ?? null,
      timeoutS: s.timeoutS ?? null,
    }))
}

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

const source = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/steps.json'), 'utf8'))
const expectedFarmView = expectedFarmViewOf(jsSteps)
const pythonFarm = spawnedPythonSteps()

test('the Python binding, imported by a real python3, projects the same farm view the JS binding implies', () => {
  assert.ok(pythonFarm.length > 0, 'sanity: the spawned Python import produced an empty table')
  assert.deepEqual(
    pythonFarm,
    expectedFarmView,
    'domain/py/steps.py disagrees with domain/js/lifecycle.js about the farm projection',
  )
})

test('the JS binding exposes domain/steps.json verbatim, entry for entry', () => {
  assert.ok(jsSteps.length > 0, 'sanity: the JS binding exports an empty table')
  assert.deepEqual(jsSteps, source.steps, 'domain/js/lifecycle.js does not expose domain/steps.json as authored')
  assert.deepEqual(jsPhases, source.phases)
})

test('both bindings agree on PHASES', () => {
  assert.deepEqual(spawnedPythonPhases(), jsPhases)
})

test('every agent-kind step agrees on index/label/agent across the authored table, the JS binding and the spawned Python import', () => {
  const jsAgentSteps = jsSteps.filter((s) => s.kind === 'agent' && s.runsIn !== 'none')
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
