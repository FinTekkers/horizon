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
  test(`${consumer.root} imports the model from domain/ by relative path`, () => {
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
  for (const file of ['farm/farmd.py', 'farm/step_agent.py']) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    assert.match(text, /^from domain\.py import steps$/m, `${file} does not import the relocated model`)
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
