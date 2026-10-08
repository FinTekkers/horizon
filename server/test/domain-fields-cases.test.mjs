// HZ-134, the cross-language fixture the architecture review required: the two
// field bindings are independent hand-written implementations, and
// domain-fields-parity.test.mjs only compares their DATA output. Without this
// file the Python validator's rejection rules would carry zero coverage, and the
// two validators' messages could drift apart silently — exactly the gap
// domain/fixtures/lifecycle-cases.json was added to close for the step table.
//
// This is the JS half. farm/tests/test_fields_fixtures.py is the Python half,
// and the two run the SAME `shared` section off the SAME
// domain/fixtures/fields-cases.json.
//
// Three vacuity holes are closed deliberately, matching domain-fixture-cases.test.mjs:
//   1. SET EQUALITY, not subset — a fixture key naming a removed export fails,
//      and a new export with no case fails.
//   2. NON-EMPTY sections — `"patchLimits": []` would satisfy a keys-only guard.
//   3. A PINNED MANIFEST — both suites assert they executed exactly the ids in
//      shared.manifest, so neither can skip a section and still claim the
//      cross-language guarantee.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import * as binding from '../../domain/js/fields.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const cases = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/fixtures/fields-cases.json'), 'utf8'))
const { shared, js } = cases

// Ids this run actually executed, checked against shared.manifest at the end.
const executed = { validation: [], fieldLookup: [], patchLimits: [], lineLimits: [], criteriaLines: [], lineBudget: [] }

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
    'domain/fixtures/fields-cases.json\'s "js" keys must equal domain/js/fields.js\'s exports exactly',
  )
})

test('no fixture section is empty — an empty case list would satisfy the coverage guard vacuously', () => {
  for (const [name, list] of Object.entries(js)) {
    if (name.startsWith('$')) continue
    assert.ok(Array.isArray(list) && list.length > 0, `js.${name} has no cases`)
  }
  for (const section of ['validation', 'fieldLookup', 'patchLimits', 'lineLimits', 'criteriaLines', 'lineBudget']) {
    assert.ok(shared[section].length > 0, `shared.${section} has no cases`)
  }
})

// ---- shared: validation (assertFieldsShape vs Python's _validate_source) ----

for (const c of shared.validation) {
  test(`shared/validation: ${c.case}`, () => {
    executed.validation.push(c.case)
    if (c.expect.throws) {
      assert.throws(
        () => binding.assertFieldsShape(c.input, 'domain/fields.json'),
        (err) => {
          assert.ok(
            err.message.includes(c.expect.messageContains),
            `expected a message containing "${c.expect.messageContains}", got: ${err.message}`,
          )
          return true
        },
      )
    } else {
      assert.equal(binding.assertFieldsShape(c.input, 'domain/fields.json'), c.input)
    }
  })
}

// ---- shared: field lookup (fieldByName vs Python's field_by_name) ----

for (const c of shared.fieldLookup) {
  test(`shared/fieldLookup: ${c.case}`, () => {
    executed.fieldLookup.push(c.case)
    const fields = c.input.fields
    if (!c.expect.found) {
      assert.throws(() => binding.fieldByName(c.name, fields), (err) => {
        assert.ok(err.message.includes(c.expect.messageContains), `unexpected message: ${err.message}`)
        assert.ok(err.message.includes(c.name), `error does not name the missing field: ${err.message}`)
        return true
      })
      return
    }
    const field = binding.fieldByName(c.name, fields)
    assert.equal(field.name, c.name)
    for (const [key, value] of Object.entries(c.expect)) {
      if (key === 'found') continue
      assert.equal(field[key], value, `${c.name}.${key}`)
    }
  })
}

// ---- shared: patch-limit derivation (patchLimits vs Python's patch_limits) ----

for (const c of shared.patchLimits) {
  test(`shared/patchLimits: ${c.case}`, () => {
    executed.patchLimits.push(c.case)
    const got = binding.patchLimits(c.input.fields)
    assert.deepEqual(got, c.expect)
    assert.deepEqual(Object.keys(got), c.expectOrder, 'the derived key order does not match the authored order')
  })
}

// ---- shared: line budgets (HZ-345 — lineLimits/criteriaLines/countCriteriaLines vs Python) ----

for (const c of shared.lineLimits) {
  test(`shared/lineLimits: ${c.case}`, () => {
    executed.lineLimits.push(c.case)
    const got = binding.lineLimits(c.input.fields)
    assert.deepEqual(got, c.expect)
    assert.deepEqual(Object.keys(got), c.expectOrder)
  })
}

for (const c of shared.criteriaLines) {
  test(`shared/criteriaLines: ${c.case}`, () => {
    executed.criteriaLines.push(c.case)
    assert.deepEqual(binding.criteriaLines(c.input), c.expect)
  })
}

for (const c of shared.lineBudget) {
  test(`shared/lineBudget: ${c.case}`, () => {
    executed.lineBudget.push(c.case)
    const count = binding.countCriteriaLines(c.input)
    assert.equal(count, c.expect.count)
    assert.equal(count <= binding.lineLimits(c.fields)[c.column], c.expect.within)
  })
}

// ---- js-only helpers ----

test('js/lineLimits, criteriaLines, countCriteriaLines: covered by the shared sections above', () => {
  assert.equal(js.lineLimits[0].drivenBy, 'shared.lineLimits')
  assert.equal(js.criteriaLines[0].drivenBy, 'shared.criteriaLines')
  assert.equal(js.countCriteriaLines[0].drivenBy, 'shared.lineBudget')
})

test('js/addedCriteriaLines: every non-blank line is compared, and the Deferred line is exempt', () => {
  for (const c of js.addedCriteriaLines) {
    assert.deepEqual(binding.addedCriteriaLines(c.before, c.after), c.expect, c.case)
  }
})

test('js/FIELDS: the live table is non-empty', () => {
  for (const c of js.FIELDS) assert.ok(binding.FIELDS.length > 0, `FIELDS: ${c.case}`)
})

test('js/assertFieldsShape: covered by shared.validation above', () => {
  assert.equal(js.assertFieldsShape[0].drivenBy, 'shared.validation')
  assert.equal(executed.validation.length, shared.validation.length)
})

test('js/fieldByName: covered by shared.fieldLookup above', () => {
  assert.equal(js.fieldByName[0].drivenBy, 'shared.fieldLookup')
  assert.equal(executed.fieldLookup.length, shared.fieldLookup.length)
})

test('js/patchLimits: covered by shared.patchLimits above', () => {
  assert.equal(js.patchLimits[0].drivenBy, 'shared.patchLimits')
  assert.equal(executed.patchLimits.length, shared.patchLimits.length)
})

test('js/intakeFields: settableAtIntake entries only, in authored order', () => {
  for (const c of js.intakeFields) {
    assert.deepEqual(
      binding.intakeFields(c.input.fields).map((f) => f.name),
      c.expectNames,
      c.case,
    )
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
