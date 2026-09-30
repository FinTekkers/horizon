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
  assert.ok(!relPaths.includes('server/scripts/gen-steps.mjs'), 'gen-steps.mjs was replaced by domain/generate.mjs')
  // Positive control for the same predicate: the relocated files DO exist.
  assert.ok(relPaths.includes('domain/py/steps.py'))
  assert.ok(relPaths.includes('domain/js/lifecycle.js'))
  assert.ok(relPaths.includes('domain/generate.mjs'))
})

test('domain/ holds the whole model: source, schema, generator, templates, both bindings and its README', () => {
  for (const expected of [
    'domain/steps.json',
    'domain/steps.schema.json',
    'domain/validate.mjs',
    'domain/generate.mjs',
    'domain/templates/lifecycle.js.tmpl',
    'domain/templates/steps.py.tmpl',
    'domain/js/lifecycle.js',
    'domain/py/steps.py',
    'domain/README.md',
  ]) {
    assert.ok(relPaths.includes(expected), `${expected} is missing`)
  }
})
