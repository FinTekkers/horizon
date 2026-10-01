// HZ-135's cross-language fixture, the JS half. farm/tests/test_priorities_fixtures.py
// is the Python half, and the two run the SAME `shared` section off the SAME
// domain/fixtures/priorities-cases.json.
//
// Why it exists: the two priority bindings are independent hand-written
// implementations, and domain-priorities-parity.test.mjs only compares their DATA
// output. Without this file the Python validator's rejection rules would carry
// zero coverage, and the two validators' messages could drift apart silently —
// the same gap domain/fixtures/lifecycle-cases.json and fields-cases.json were
// added to close.
//
// Three vacuity holes are closed deliberately, matching domain-fields-cases.test.mjs:
//   1. SET EQUALITY, not subset — a fixture key naming a removed export fails,
//      and a new export with no case fails.
//   2. NON-EMPTY sections — `"membership": []` would satisfy a keys-only guard.
//   3. A PINNED MANIFEST — both suites assert they executed exactly the ids in
//      shared.manifest, so neither can skip a section and still claim the
//      cross-language guarantee.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import * as binding from '../../domain/js/priorities.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const cases = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/fixtures/priorities-cases.json'), 'utf8'))
const { shared, js } = cases

// Ids this run actually executed, checked against shared.manifest at the end.
const executed = { validation: [], membership: [] }

// ---- coverage guard ----

test('every JS export has at least one fixture case, and every fixture key is a real export', () => {
  const exported = Object.keys(binding).filter((k) => k !== 'default').sort()
  const covered = Object.keys(js)
    .filter((k) => !k.startsWith('$'))
    .sort()
  assert.ok(exported.length > 0, 'the binding exports nothing — this guard would pass vacuously')
  assert.deepEqual(
    covered,
    exported,
    'domain/fixtures/priorities-cases.json\'s "js" keys must equal domain/js/priorities.js\'s exports exactly',
  )
})

test('no fixture section is empty — an empty case list would satisfy the coverage guard vacuously', () => {
  for (const [name, list] of Object.entries(js)) {
    if (name.startsWith('$')) continue
    assert.ok(Array.isArray(list) && list.length > 0, `js.${name} has no cases`)
  }
  for (const section of ['validation', 'membership']) {
    assert.ok(shared[section].length > 0, `shared.${section} has no cases`)
  }
})

// ---- shared: validation (assertPrioritiesShape vs Python's _validate_source) ----

for (const c of shared.validation) {
  test(`shared/validation: ${c.case}`, () => {
    executed.validation.push(c.case)
    if (c.expect.throws) {
      assert.throws(
        () => binding.assertPrioritiesShape(c.input, 'domain/priorities.json'),
        (err) => {
          assert.ok(
            err.message.includes(c.expect.messageContains),
            `expected a message containing "${c.expect.messageContains}", got: ${err.message}`,
          )
          return true
        },
      )
    } else {
      assert.equal(binding.assertPrioritiesShape(c.input, 'domain/priorities.json'), c.input)
    }
  })
}

// ---- shared: membership (isPriority vs Python's is_priority) ----

for (const c of shared.membership) {
  test(`shared/membership: ${c.case}`, () => {
    executed.membership.push(c.case)
    assert.equal(binding.isPriority(c.value, c.priorities), c.expect)
  })
}

// ---- js-only exports ----

test('js/PRIORITIES: the live vocabulary is non-empty', () => {
  for (const c of js.PRIORITIES) assert.ok(binding.PRIORITIES.length > 0, `PRIORITIES: ${c.case}`)
})

test('js/DEFAULT_PRIORITY: the live default is a member of the live vocabulary', () => {
  for (const c of js.DEFAULT_PRIORITY) {
    assert.ok(c.expectMember)
    assert.ok(binding.PRIORITIES.includes(binding.DEFAULT_PRIORITY), `DEFAULT_PRIORITY: ${c.case}`)
  }
})

// PRIORITY is derived from the module-level vocabulary rather than from an
// argument, so the fabricated input drives assertPrioritiesShape (proving the
// input is legal) and the KEY DERIVATION is then asserted against that input's
// own values. That keeps the case honest without inventing a parameter the
// production code has no use for.
test('js/PRIORITY: keyed by the upper-case form of each value, in authored order', () => {
  for (const c of js.PRIORITY) {
    const accepted = binding.assertPrioritiesShape(c.input, 'fabricated')
    assert.deepEqual(
      accepted.priorities.map((value) => value.toUpperCase()),
      c.expectKeys,
      c.case,
    )
    // And the real export follows the same rule against the real document.
    assert.deepEqual(Object.keys(binding.PRIORITY), binding.PRIORITIES.map((value) => value.toUpperCase()))
  }
})

test('js/assertPrioritiesShape: covered by shared.validation above', () => {
  assert.equal(js.assertPrioritiesShape[0].drivenBy, 'shared.validation')
  assert.equal(executed.validation.length, shared.validation.length)
})

test('js/isPriority: covered by shared.membership above', () => {
  assert.equal(js.isPriority[0].drivenBy, 'shared.membership')
  assert.equal(executed.membership.length, shared.membership.length)
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
