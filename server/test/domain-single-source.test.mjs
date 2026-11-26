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
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { repoFiles, relative, MIN_EXPECTED_FILES, REPO_ROOT } from './helpers/repoFiles.mjs'

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

// HO-854 (owner ruling): a project's sub-step definitions,
// farm/projects/<slug>/steps.json (server/src/substeps.js), share the
// filename, so that one path shape is allowed beside domain/steps.json.
// Anywhere else, domain/steps.json is still the only steps.json.
const PROJECT_SUBSTEPS_FILE = /^farm\/projects\/[a-z0-9]+(?:-[a-z0-9]+)*\/steps\.json$/

test('exactly one steps.json exists outside farm/projects/<slug>/, and it is domain/steps.json', () => {
  const found = relPaths.filter((p) => path.basename(p) === 'steps.json' && !PROJECT_SUBSTEPS_FILE.test(p))
  assert.deepEqual(found, ['domain/steps.json'])
})

test('the project path carve-out admits only farm/projects/<slug>/steps.json', () => {
  assert.ok(PROJECT_SUBSTEPS_FILE.test('farm/projects/horizon/steps.json'))
  assert.ok(PROJECT_SUBSTEPS_FILE.test('farm/projects/acme-capital/steps.json'))
  for (const elsewhere of [
    'steps.json',
    'farm/steps.json',
    'farm/projects/steps.json',
    'farm/projects/horizon/nested/steps.json',
    'farm/projects/Horizon/steps.json',
    'server/projects/horizon/steps.json',
    'ui/farm/projects/horizon/steps.json',
  ]) {
    assert.ok(!PROJECT_SUBSTEPS_FILE.test(elsewhere), `${elsewhere} must not be allowed as a second steps.json`)
  }
})

test('farm/projects/horizon/steps.json is a project sub-step file, not a second step model', () => {
  // Positive control: the walk finds it, so the carve-out above is exercised.
  assert.ok(relPaths.includes('farm/projects/horizon/steps.json'))
  const projectFiles = relPaths.filter((p) => PROJECT_SUBSTEPS_FILE.test(p))
  assert.ok(projectFiles.length >= 1)
  const model = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/steps.json'), 'utf8'))
  const modelKeys = Object.keys(model)
  for (const rel of projectFiles) {
    const raw = JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
    // The sub-step shape, { substeps: [...] }, and none of the step model's
    // own top-level keys.
    assert.deepEqual(Object.keys(raw), ['substeps'], `${rel} must hold only "substeps"`)
    assert.ok(Array.isArray(raw.substeps) && raw.substeps.length > 0, `${rel} must list sub-steps`)
    for (const key of modelKeys) assert.ok(!Object.hasOwn(raw, key), `${rel} carries the step model's "${key}"`)
    // Each entry follows a global step by index; none declares a step.
    for (const entry of raw.substeps) {
      assert.ok(Number.isInteger(entry.anchor), `${rel}: ${entry.id} must anchor to a global step index`)
      assert.ok(['opening', 'audit'].includes(entry.kind), `${rel}: ${entry.id} kind must be opening or audit`)
      assert.ok(!Object.hasOwn(entry, 'key') && !Object.hasOwn(entry, 'phase'), `${rel}: ${entry.id} looks like a step declaration`)
    }
  }
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

// HZ-133: the persona registry — ids, agent membership, defaults, legacy aliases
// and persona-to-provider — is the FIFTH thing domain/ owns, added under the
// same rule — one JSON, one schema, one hand-written binding per language, plus
// the cross-language fixture both suites run.
test('domain/ also holds the persona registry: source, schema, both bindings and its fixture', () => {
  for (const expected of [
    'domain/personas.json',
    'domain/personas.schema.json',
    'domain/js/personas.js',
    'domain/py/personas.py',
    'domain/fixtures/personas-cases.json',
  ]) {
    assert.ok(relPaths.includes(expected), `${expected} is missing`)
  }
})

// HZ-535/HZ-972: a project's own personas, farm/projects/<slug>/personas.json
// (domain/projectPersonas.schema.json), share the filename, as a project's
// steps.json does above. Anywhere else, domain/personas.json is the only one.
const PROJECT_PERSONAS_FILE = /^farm\/projects\/[a-z0-9]+(?:-[a-z0-9]+)*\/personas\.json$/

test('exactly one personas.json exists outside farm/projects/<slug>/, and it is domain/personas.json', () => {
  const found = relPaths.filter((p) => path.basename(p) === 'personas.json' && !PROJECT_PERSONAS_FILE.test(p))
  assert.deepEqual(found, ['domain/personas.json'])
})

test('a farm/projects/<slug>/personas.json is a project persona file, not a second registry', () => {
  for (const elsewhere of ['personas.json', 'farm/personas.json', 'farm/projects/personas.json', 'farm/projects/a/b/personas.json', 'ui/farm/projects/a/personas.json']) {
    assert.ok(!PROJECT_PERSONAS_FILE.test(elsewhere), elsewhere)
  }
  for (const rel of relPaths.filter((p) => PROJECT_PERSONAS_FILE.test(p))) {
    const raw = JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
    assert.deepEqual(Object.keys(raw), ['personas'], rel)
    assert.ok(!Object.hasOwn(raw, 'agents'), `${rel} declares the registry's agents`)
  }
})
