// HZ-139 success metric 6: "domain/fixtures/lifecycle-cases.json exists and
// covers every helper exported by both bindings. The JS suite and the Python
// suite each assert every case. A test fails if a helper exists in one binding
// with no fixture case."
//
// This is the JS half. farm/tests/test_lifecycle_fixtures.py is the Python
// half, and the two run the SAME `shared` section off the SAME file — which is
// the point. Until HZ-139 the two bindings were independent hand-written
// implementations and nothing ever proved a label lookup, a farm projection or
// a validation rule meant the same thing in both languages.
//
// Three vacuity holes are closed deliberately, because each would let a real
// regression through a green test:
//   1. SET EQUALITY, not subset — a fixture key naming a removed export fails,
//      and a new export with no case fails. A one-directional check misses one.
//   2. NON-EMPTY sections — `"isClosed": []` would satisfy a keys-only guard.
//   3. A PINNED MANIFEST — both suites assert they executed exactly the ids in
//      shared.manifest, so neither can skip a section and still claim the
//      cross-language guarantee.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import * as binding from '../../domain/js/lifecycle.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const cases = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/fixtures/lifecycle-cases.json'), 'utf8'))
const { shared, js } = cases

// Ids this run actually executed, checked against shared.manifest at the end.
const executed = { labelLookup: [], farmProjection: [], validation: [] }

// ---- coverage guard (metric 6) ----

test('every JS export has at least one fixture case, and every fixture key is a real export', () => {
  const exported = Object.keys(binding).filter((k) => k !== 'default').sort()
  const covered = Object.keys(js)
    .filter((k) => !k.startsWith('$'))
    .sort()
  assert.ok(exported.length > 0, 'the binding exports nothing — this guard would pass vacuously')
  assert.deepEqual(
    covered,
    exported,
    'domain/fixtures/lifecycle-cases.json\'s "js" keys must equal domain/js/lifecycle.js\'s exports exactly',
  )
})

test('no fixture section is empty — an empty case list would satisfy the coverage guard vacuously', () => {
  for (const [name, list] of Object.entries(js)) {
    if (name.startsWith('$')) continue
    assert.ok(Array.isArray(list) && list.length > 0, `js.${name} has no cases`)
  }
  for (const section of ['labelLookup', 'farmProjection', 'validation']) {
    assert.ok(shared[section].length > 0, `shared.${section} has no cases`)
  }
})

// ---- shared: validation (assertLifecycleShape vs Python's _validate_source) ----

for (const c of shared.validation) {
  test(`shared/validation: ${c.case}`, () => {
    executed.validation.push(c.case)
    if (c.expect.throws) {
      assert.throws(
        () => binding.assertLifecycleShape(c.input, 'domain/steps.json'),
        (err) => {
          assert.ok(
            err.message.includes(c.expect.messageContains),
            `expected a message containing "${c.expect.messageContains}", got: ${err.message}`,
          )
          return true
        },
      )
    } else {
      assert.equal(binding.assertLifecycleShape(c.input, 'domain/steps.json'), c.input)
    }
  })
}

// ---- shared: label lookup (requiredStepIndex vs Python's _find_by_label) ----

for (const c of shared.labelLookup) {
  test(`shared/labelLookup: ${c.case}`, () => {
    executed.labelLookup.push(c.case)
    if (!c.expect.found) {
      assert.throws(() => binding.requiredStepIndex(c.label), (err) => {
        assert.ok(err.message.includes(c.expect.messageContains), `error does not name the label: ${err.message}`)
        return true
      })
      return
    }
    const step = binding.STEPS[binding.requiredStepIndex(c.label)]
    assert.equal(step.label, c.label)
    for (const [field, value] of Object.entries(c.expect)) {
      if (field === 'found') continue
      assert.equal(step[field], value, `${c.label}.${field}`)
    }
  })
}

// ---- shared: farm projection ----
// The JS binding does NOT own this rule — domain/py/steps.py's
// _project_farm_view does, and there is deliberately no second JS copy of it
// (guardrail 4). So the JS half of this section spawns a real python3 and
// asserts the SAME fixture, which is what makes the two suites agree on a rule
// that only one of them implements.

const projectScript = `
import json, sys
from domain.py import steps
print(json.dumps(steps._project_farm_view(json.loads(sys.argv[1])["steps"])))
`

for (const c of shared.farmProjection) {
  test(`shared/farmProjection: ${c.case}`, () => {
    executed.farmProjection.push(c.case)
    const out = execFileSync('python3', ['-c', projectScript, JSON.stringify(c.input)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    assert.deepEqual(JSON.parse(out), c.expect)
  })
}

// ---- js-only helpers ----

const FABRICATED = [
  { phase: 0, kind: 'agent', agent: 'PM', label: 'First', runsIn: 'pm' },
  { phase: 0, kind: 'gate', gate: 'required', label: 'Second' },
  { phase: 0, kind: 'agent', agent: 'Eng', label: 'Third', runsIn: 'pm' },
]

test('js/PHASES and js/STEPS: the live tables are non-empty', () => {
  for (const name of ['PHASES', 'STEPS']) {
    for (const c of js[name]) assert.ok(binding[name].length > 0, `${name}: ${c.case}`)
  }
})

test('js/index constants: each resolves to its own step BY LABEL, never by a pinned integer', () => {
  // Deliberately not an integer comparison: domain-step-pins.test.mjs already
  // owns "step 11 is the implement step". Asserting the label here means
  // inserting a step breaks one file, not two.
  for (const name of ['IMPLEMENT_STEP_INDEX', 'REVIEW_STEP_INDEX', 'ACCEPT_GATE_INDEX', 'DEPLOY_STEP_INDEX']) {
    for (const c of js[name]) {
      assert.equal(binding.STEPS[binding[name]].label, c.expectLabel, `${name}: ${c.case}`)
    }
  }
})

test('js/assertLifecycleShape: covered by shared.validation above', () => {
  assert.equal(js.assertLifecycleShape[0].drivenBy, 'shared.validation')
  assert.equal(executed.validation.length, shared.validation.length)
})

test('js/requiredStepIndex: resolves by label, throws when renamed', () => {
  for (const c of js.requiredStepIndex) {
    if (c.expect?.throws) {
      assert.throws(() => binding.requiredStepIndex(c.label, FABRICATED), (err) => {
        assert.ok(err.message.includes(c.expect.messageContains))
        return true
      }, c.case)
    } else {
      assert.equal(binding.requiredStepIndex(c.label, FABRICATED), c.expect, c.case)
    }
  }
})

test('js/agentStepIndexes: agent entries only, in order', () => {
  for (const c of js.agentStepIndexes) {
    assert.deepEqual(binding.agentStepIndexes(FABRICATED), c.expect, c.case)
  }
})

test('js/gateStepIndexes: gate entries only, in order', () => {
  for (const c of js.gateStepIndexes) {
    assert.deepEqual(binding.gateStepIndexes(FABRICATED), c.expect, c.case)
  }
})

// The two index helpers partition the table — no step is both kinds and none is
// neither. Asserted over the LIVE table, not FABRICATED, because that is where a
// step added with a typo'd kind would actually land.
test('js/agentStepIndexes and js/gateStepIndexes partition the live step table', () => {
  const agents = binding.agentStepIndexes()
  const gates = binding.gateStepIndexes()
  assert.ok(agents.length > 0 && gates.length > 0, 'one half is empty — the partition claim is vacuous')
  assert.deepEqual(
    [...agents, ...gates].sort((a, b) => a - b),
    binding.STEPS.map((_, i) => i),
  )
})

for (const name of ['isClosed', 'isAbandoned']) {
  test(`js/${name}`, () => {
    for (const c of js[name]) assert.equal(binding[name](c.item), c.expect, c.case)
  })
}

test('js/curStep', () => {
  for (const c of js.curStep) {
    const got = binding.curStep(c.item)
    if (c.expectNull) assert.equal(got, null, c.case)
    else assert.equal(got.label, binding.STEPS[c.item.cursor].label, c.case)
  }
})

test('js/phaseIdx', () => {
  for (const c of js.phaseIdx) assert.equal(binding.phaseIdx(c.item), c.expect, c.case)
})

test('js/awaitingGate', () => {
  for (const c of js.awaitingGate) assert.equal(binding.awaitingGate(c.item), c.expect, c.case)
})

test('js/stepStatus', () => {
  for (const c of js.stepStatus) assert.equal(binding.stepStatus(c.item, c.i), c.expect, c.case)
})

test('js/phaseStepIndexes', () => {
  for (const c of js.phaseStepIndexes) assert.deepEqual(binding.phaseStepIndexes(c.phase), c.expect, c.case)
})

for (const name of ['isBlocked', 'isBlockedByAbandoned']) {
  test(`js/${name}`, () => {
    for (const c of js[name]) assert.equal(binding[name](c.blockers), c.expect, c.case)
  })
}

test('js/reworkTargets: every target is an agent step strictly earlier than the gate', () => {
  for (const c of js.reworkTargets) {
    const gateIndex = binding.requiredStepIndex(c.gateLabel)
    const targets = binding.reworkTargets(gateIndex)
    for (const t of targets) {
      assert.ok(t.index < gateIndex, `${c.case}: target ${t.index} is not earlier than gate ${gateIndex}`)
      assert.equal(binding.STEPS[t.index].kind, 'agent', `${c.case}: target ${t.label} is not an agent step`)
      assert.equal(t.label, binding.STEPS[t.index].label)
    }
    // Positive control: the rule is not passing because nothing was returned.
    const expectedCount = binding.STEPS.slice(0, gateIndex).filter((s) => s.kind === 'agent').length
    assert.equal(targets.length, expectedCount, c.case)
  }
})

test('js/defaultReworkTarget', () => {
  for (const c of js.defaultReworkTarget) {
    const gateIndex = binding.requiredStepIndex(c.gateLabel)
    assert.equal(binding.STEPS[binding.defaultReworkTarget(gateIndex)].label, c.expectLabel, c.case)
  }
})

// ---- the manifest: this suite really ran every shared case ----

test('MANIFEST: the JS suite executed exactly the shared cases the fixture pins', () => {
  for (const [section, ids] of Object.entries(shared.manifest)) {
    assert.deepEqual(
      executed[section].sort(),
      [...ids].sort(),
      `the JS suite did not run shared.${section} as pinned — the cross-language guarantee is only as good as this list`,
    )
  }
})
