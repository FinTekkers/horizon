// HZ-128 success criteria 2 and 5:
//   2. "Exactly one steps.json in the repo. A test globs for it and asserts a
//      count of one."
//   5. "No steps_generated.json remains under farm/ or ui/."
//
// Every assertion here is a "there is exactly N of these in the tree" claim, so
// each one is paired with a positive control: the walk must find the file we
// KNOW exists, and must have visited a plausible number of files overall.
// Otherwise a mis-scoped walk passes every count silently.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { repoFiles, relative, MIN_EXPECTED_FILES } from './helpers/repoFiles.mjs'

const files = repoFiles()
const relPaths = files.map((f) => relative(f))
const basenames = files.map((f) => path.basename(f))

test('the walk itself is not vacuous', () => {
  assert.ok(
    files.length >= MIN_EXPECTED_FILES,
    `the repo walk visited only ${files.length} file(s) — every count below would pass vacuously`,
  )
  // Positive control: three files that certainly exist.
  assert.ok(relPaths.includes('domain/steps.json'))
  assert.ok(relPaths.includes('package.json'))
  assert.ok(relPaths.includes('server/src/store.js'))
})

test('exactly one steps.json exists, and it is domain/steps.json', () => {
  const found = relPaths.filter((p) => path.basename(p) === 'steps.json')
  assert.deepEqual(found, ['domain/steps.json'])
})

test('no steps_generated.json survives anywhere', () => {
  assert.equal(basenames.filter((b) => b === 'steps_generated.json').length, 0)
})

test('the step model is not declared under farm/ or ui/ any more', () => {
  assert.ok(!relPaths.includes('farm/steps.py'), 'farm/steps.py was relocated to domain/py/steps.py')
  assert.ok(!relPaths.includes('server/src/lifecycle.js'), 'server/src/lifecycle.js was relocated to domain/js/lifecycle.js')
  assert.ok(!relPaths.includes('server/scripts/gen-steps.mjs'), 'gen-steps.mjs was superseded and deleted')
  // Positive control for the same predicate: the relocated files DO exist.
  assert.ok(relPaths.includes('domain/py/steps.py'))
  assert.ok(relPaths.includes('domain/js/lifecycle.js'))
})

// HZ-139 inverted this pair. The generator and its templates used to be
// required to exist; both bindings are now hand-written source that read
// domain/steps.json directly, so the generator must be GONE. Same assertion
// count, same strictness, opposite polarity — and the positive control below
// is what stops the must-not-exist half passing because the walk broke.
test('the generator and its templates are gone — nothing in domain/ is generated any more', () => {
  for (const removed of [
    'domain/generate.mjs',
    'domain/templates/lifecycle.js.tmpl',
    'domain/templates/steps.py.tmpl',
  ]) {
    assert.ok(!relPaths.includes(removed), `${removed} still exists — HZ-139 deleted the generator`)
  }
  // The DIRECTORY, not just the two files it held: a stray
  // domain/templates/README.md would satisfy the loop above and still leave a
  // templates/ folder behind.
  const strays = relPaths.filter((p) => p.startsWith('domain/templates/'))
  assert.deepEqual(strays, [], 'domain/templates/ still holds files')
})

test('domain/ holds the whole model: source, schema, validator, both bindings, fixtures and its README', () => {
  for (const expected of [
    'domain/steps.json',
    'domain/steps.schema.json',
    'domain/validate.mjs',
    'domain/js/lifecycle.js',
    'domain/py/steps.py',
    'domain/fixtures/lifecycle-cases.json',
    'domain/README.md',
  ]) {
    assert.ok(relPaths.includes(expected), `${expected} is missing`)
  }
})

// HZ-132: the failure-reason vocabulary is the SECOND thing domain/ owns, added
// under the same rule — one JSON, one schema, one hand-written binding per
// language. Inclusion-only, like the check above: this is what makes a deletion
// visible rather than silently leaving a consumer importing nothing.
test('domain/ also holds the failure-reason vocabulary: source, schema and both bindings', () => {
  for (const expected of [
    'domain/reasons.json',
    'domain/reasons.schema.json',
    'domain/js/reasons.js',
    'domain/py/reasons.py',
  ]) {
    assert.ok(relPaths.includes(expected), `${expected} is missing`)
  }
})

test('exactly one reasons.json exists, and it is domain/reasons.json', () => {
  const found = relPaths.filter((p) => path.basename(p) === 'reasons.json')
  assert.deepEqual(found, ['domain/reasons.json'])
})

// HZ-134: the work-item field limits are the THIRD thing domain/ owns, added
// under the same rule — one JSON, one schema, one hand-written binding per
// language, plus the cross-language fixture both suites run.
test('domain/ also holds the work-item field limits: source, schema, both bindings and its fixture', () => {
  for (const expected of [
    'domain/fields.json',
    'domain/fields.schema.json',
    'domain/js/fields.js',
    'domain/py/fields.py',
    'domain/fixtures/fields-cases.json',
  ]) {
    assert.ok(relPaths.includes(expected), `${expected} is missing`)
  }
})

test('exactly one fields.json exists, and it is domain/fields.json', () => {
  const found = relPaths.filter((p) => path.basename(p) === 'fields.json')
  assert.deepEqual(found, ['domain/fields.json'])
})

// HZ-135: the work-item priority vocabulary is the FOURTH thing domain/ owns,
// added under the same rule — one JSON, one schema, one hand-written binding per
// language, plus the cross-language fixture both suites run.
test('domain/ also holds the priority vocabulary: source, schema, both bindings and its fixture', () => {
  for (const expected of [
    'domain/priorities.json',
    'domain/priorities.schema.json',
    'domain/js/priorities.js',
    'domain/py/priorities.py',
    'domain/fixtures/priorities-cases.json',
  ]) {
    assert.ok(relPaths.includes(expected), `${expected} is missing`)
  }
})

test('exactly one priorities.json exists, and it is domain/priorities.json', () => {
  const found = relPaths.filter((p) => path.basename(p) === 'priorities.json')
  assert.deepEqual(found, ['domain/priorities.json'])
})
