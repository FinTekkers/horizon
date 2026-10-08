// HZ-128 success criterion 6: "server, UI and farm each import the model from
// domain/ by relative path."
//
// e2e/ is a FOURTH consumer — e2e/global-setup.js and two specs import the step
// table directly. It gets checked here, under `node --test`, on purpose:
// farm/checks.py skips `npm run test:e2e` on hosts without Playwright's
// Chromium build, so an e2e-only assertion would silently not run at the gate.
//
// This is also the permanent exit check for "did every import site actually get
// repointed": server/src/lifecycle.js was deleted rather than gutted, so a miss
// is an import-time crash — but this catches a stale path in a comment or a
// doc-adjacent script too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { repoFiles, relative, filesMatching, stripComments, MIN_EXPECTED_FILES, REPO_ROOT } from './helpers/repoFiles.mjs'

// Each consumer root, with the relative specifier its files use to reach the
// model, and one file that must be importing it.
const CONSUMERS = [
  { root: 'server/src', specifier: '../../domain/js/lifecycle.js', witness: 'server/src/store.js' },
  { root: 'server/test', specifier: '../../domain/js/lifecycle.js', witness: 'server/test/store.test.mjs' },
  { root: 'ui/src', specifier: 'domain/js/lifecycle.js', witness: 'ui/src/App.jsx' },
  { root: 'e2e', specifier: 'domain/js/lifecycle.js', witness: 'e2e/global-setup.js' },
  // HZ-132 moved the failure-reason vocabulary into domain/ under the same
  // rule, so it gets the same check: the server classifies and the UI renders
  // from one document, by relative path, with no npm workspace in between.
  { root: 'server/src', specifier: '../../domain/js/reasons.js', witness: 'server/src/orchestrator.js' },
  { root: 'ui/src', specifier: 'domain/js/reasons.js', witness: 'ui/src/domain/pauseReason.js' },
  // HZ-134 moved the work-item field limits into domain/ under the same rule.
  // Two server consumers: app.js derives the POST /api/items body schema from it,
  // orchestrator.js derives which columns an agent may patch. There is no UI
  // consumer — ui/src sets no maxLength on the create form (pre-existing, and
  // unchanged by HZ-134), so listing one here would fail as a stale entry.
  { root: 'server/src', specifier: '../../domain/js/fields.js', witness: 'server/src/app.js' },
  // HZ-135 moved the work-item priority vocabulary into domain/ under the same
  // rule. Unlike the field limits this one HAS a UI consumer — two, in fact: the
  // intake picker renders the vocabulary and ui/src/domain/lifecycle.js keys its
  // theme tokens off it — so both roots are listed.
  { root: 'server/src', specifier: '../../domain/js/priorities.js', witness: 'server/src/store.js' },
  { root: 'ui/src', specifier: 'domain/js/priorities.js', witness: 'ui/src/components/NewItemModal.jsx' },
]

const files = repoFiles()
const codeFiles = files.filter((f) => /\.(js|mjs|jsx|py)$/.test(f))

test('the walk is not vacuous', () => {
  assert.ok(files.length >= MIN_EXPECTED_FILES, `walk visited only ${files.length} file(s)`)
  assert.ok(codeFiles.length > 100, `only ${codeFiles.length} code file(s) found`)
})

test('nothing imports the deleted server/src/lifecycle.js any more', () => {
  const hits = filesMatching(
    (text) => /from\s+['"][^'"]*src\/lifecycle\.js['"]/.test(text) || /import\s*\(\s*['"][^'"]*src\/lifecycle\.js['"]/.test(text),
    codeFiles,
  )
  assert.deepEqual(hits, [], `still importing the deleted module: ${hits.join(', ')}`)
})

test('nothing loads the deleted steps_generated.json or the relocated farm.steps any more', () => {
  // Import/read SYNTAX only. Several tests in this directory legitimately name
  // the deleted files in a string, asserting they are gone.
  const LOAD_SITES = [
    /from\s+['"][^'"]*steps_generated\.json['"]/, // JS import
    /readFileSync\([^)]*steps_generated\.json/, // JS read
    /Path\([^)]*\)\s*\/\s*"steps_generated\.json"/, // Python path join
    /^from farm import[^\n]*\bsteps\b/m, // Python package import
    /^from farm\.steps\b/m,
    /^import farm\.steps\b/m,
  ]
  const hits = filesMatching((text) => LOAD_SITES.some((re) => re.test(stripComments(text))), codeFiles)
  assert.deepEqual(hits, [], `still loading a relocated module: ${hits.join(', ')}`)
})

for (const consumer of CONSUMERS) {
  test(`${consumer.root} imports ${path.basename(consumer.specifier)} from domain/ by relative path`, () => {
    const inRoot = codeFiles.filter((f) => relative(f).startsWith(`${consumer.root}/`))
    assert.ok(inRoot.length > 0, `no code files found under ${consumer.root}`)

    const importers = filesMatching((text) => text.includes(consumer.specifier), inRoot)
    assert.ok(
      importers.length > 0,
      `${consumer.root} has no file importing '${consumer.specifier}' — criterion 6 is not met for this consumer`,
    )
    assert.ok(importers.includes(consumer.witness), `${consumer.witness} is not importing the model`)
  })
}

test('the farm imports the model as domain.py, from the repo root, in both production modules', () => {
  // HZ-132 added `reasons` alongside `steps` on the same import line, so the
  // match is on the imported NAMES rather than the whole line — both modules
  // must still come from domain.py and from nowhere else.
  // HZ-345: step_agent.py also reads `fields` for the criteria-line rule.
  const expected = { 'farm/farmd.py': ['reasons', 'steps'], 'farm/step_agent.py': ['fields', 'reasons', 'steps'] }
  for (const [file, names] of Object.entries(expected)) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    const line = text.match(/^from domain\.py import (.+)$/m)
    assert.ok(line, `${file} does not import the relocated model`)
    const imported = line[1].split(',').map((name) => name.trim()).sort()
    assert.deepEqual(imported, names, `${file} imports ${line[1]} from domain.py`)
  }
})

// HZ-134: architecture review asked for the same pin on the new Python import.
// farm/pm_agent.py's PATCH_FIELDS and farm/tools/measure_text_caps.py's CAPS
// table both read domain/fields.json, and both must reach it the same way the
// other farm modules reach domain.py — off the repo root, not by a relative path
// or a sys.path insert.
test('the farm modules that carry a field limit import it as domain.py, from the repo root', () => {
  // Matched on the imported NAMES rather than the whole line: farm/pm_agent.py
  // reaches for `reasons` on the same line, the way farmd.py and step_agent.py
  // already do.
  for (const file of ['farm/pm_agent.py', 'farm/tools/measure_text_caps.py']) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    const line = text.match(/^from domain\.py import (.+)$/m)
    assert.ok(line, `${file} does not import anything from domain.py`)
    const imported = line[1].split(',').map((name) => name.trim())
    assert.ok(imported.includes('fields'), `${file} imports ${line[1]} from domain.py, not the field limits`)
  }
})

test('the farm tests that exercise the step table import it from domain.py too', () => {
  for (const file of ['farm/tests/test_steps.py', 'farm/tests/test_steps_insertion.py', 'farm/tests/test_e2e_muse.py']) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    assert.match(text, /^from domain\.py import steps$/m, `${file} does not import the relocated model`)
  }
})

test('every import of the model resolves to a real file, from every consumer', async () => {
  // Resolution, not just string matching: a wrong number of `../` segments
  // would satisfy a grep and still fail at runtime.
  const fromHere = await import('../../domain/js/lifecycle.js')
  assert.ok(Array.isArray(fromHere.STEPS))

  for (const file of ['server/src/store.js', 'ui/src/App.jsx', 'e2e/global-setup.js', 'ui/src/domain/status.js']) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    const match = text.match(/from\s+'([^']*domain\/js\/lifecycle\.js)'/)
    assert.ok(match, `${file} has no domain/ import to resolve`)
    const resolved = path.resolve(path.dirname(path.join(REPO_ROOT, file)), match[1])
    assert.equal(resolved, path.join(REPO_ROOT, 'domain/js/lifecycle.js'), `${file}'s relative path does not land on the model`)
  }
})

test('every import of the reason vocabulary resolves to a real file, from every consumer (HZ-132)', async () => {
  const fromHere = await import('../../domain/js/reasons.js')
  assert.ok(Array.isArray(fromHere.REASON_IDS) && fromHere.REASON_IDS.length > 0)

  for (const file of ['server/src/orchestrator.js', 'ui/src/domain/pauseReason.js']) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    const match = text.match(/from\s+'([^']*domain\/js\/reasons\.js)'/)
    assert.ok(match, `${file} has no domain/ import to resolve`)
    const resolved = path.resolve(path.dirname(path.join(REPO_ROOT, file)), match[1])
    assert.equal(resolved, path.join(REPO_ROOT, 'domain/js/reasons.js'), `${file}'s relative path does not land on the vocabulary`)
  }
})

// HZ-135: the same pin on the new Python import. farm/wizard.py builds its
// numbered prompt from the order and farm/concierge_agent.py validates a
// set_priority action against the vocabulary; both must reach it the way every
// other farm module reaches domain.py — off the repo root, not by a relative path
// or a sys.path insert.
test('the farm modules that speak about priority import it as domain.py, from the repo root', () => {
  for (const file of ['farm/wizard.py', 'farm/concierge_agent.py']) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    const line = text.match(/^from domain\.py import (.+)$/m)
    assert.ok(line, `${file} does not import anything from domain.py`)
    const imported = line[1].split(',').map((name) => name.trim())
    assert.ok(imported.includes('priorities'), `${file} imports ${line[1]} from domain.py, not the vocabulary`)
  }
})

test('every import of the priority vocabulary resolves to a real file, from every consumer (HZ-135)', async () => {
  const fromHere = await import('../../domain/js/priorities.js')
  assert.ok(Array.isArray(fromHere.PRIORITIES) && fromHere.PRIORITIES.length > 0)

  for (const file of [
    'server/src/db.js',
    'server/src/store.js',
    'server/src/github.js',
    'server/src/app.js',
    'server/src/priorityLabels.js',
    'ui/src/components/NewItemModal.jsx',
    'ui/src/domain/lifecycle.js',
    'ui/src/api/mockApi.js',
  ]) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    const match = text.match(/from\s+'([^']*domain\/js\/priorities\.js)'/)
    assert.ok(match, `${file} has no domain/ import to resolve`)
    const resolved = path.resolve(path.dirname(path.join(REPO_ROOT, file)), match[1])
    assert.equal(
      resolved,
      path.join(REPO_ROOT, 'domain/js/priorities.js'),
      `${file}'s relative path does not land on the vocabulary`,
    )
  }
})

test('every import of the field limits resolves to a real file, from every consumer (HZ-134)', async () => {
  const fromHere = await import('../../domain/js/fields.js')
  assert.ok(Array.isArray(fromHere.FIELDS) && fromHere.FIELDS.length > 0)

  for (const file of ['server/src/app.js', 'server/src/orchestrator.js']) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    const match = text.match(/from\s+'([^']*domain\/js\/fields\.js)'/)
    assert.ok(match, `${file} has no domain/ import to resolve`)
    const resolved = path.resolve(path.dirname(path.join(REPO_ROOT, file)), match[1])
    assert.equal(resolved, path.join(REPO_ROOT, 'domain/js/fields.js'), `${file}'s relative path does not land on the field limits`)
  }
})
