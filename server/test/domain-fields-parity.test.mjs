// HZ-134 success metric 1: "each work-item field's max length is declared once,
// in domain/."
//
// Declared once is only true if both bindings really do read the same document.
// LOAD-BEARING LEG, read this before touching the file: spawnedPython() boots a
// real python3, imports the COMMITTED domain/py/fields.py off disk, and diffs
// what that module actually produced against the JS binding — a separate
// hand-written implementation in a separate language. Do not weaken or skip it.
//
// patch_limits()/patchLimits() is compared as an ORDERED key list as well as a
// mapping. The order is load-bearing on both sides: farm/pm_steps.py's
// validate() iterates PATCH_FIELDS, and server/src/orchestrator.js's
// FARM_PATCH_FIELDS is the same key list on the other side of the wire.
//
// Modeled on domain-reasons-parity.test.mjs's spawn-python-and-diff pattern.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { FIELDS, patchLimits, intakeFields, fieldByName } from '../../domain/js/fields.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

function spawnedPython(expression) {
  const script = `import json; from domain.py import fields; print(json.dumps(${expression}))`
  return JSON.parse(execFileSync('python3', ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8' }))
}

const source = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/fields.json'), 'utf8'))
const pythonFields = spawnedPython('fields.FIELDS')

test('the JS binding exposes domain/fields.json verbatim, entry for entry', () => {
  assert.ok(FIELDS.length > 0, 'sanity: the JS binding exports an empty table')
  assert.deepEqual(FIELDS, source.fields, 'domain/js/fields.js does not expose domain/fields.json as authored')
})

test('the Python binding, imported by a real python3, exposes the same table — entry for entry', () => {
  assert.ok(pythonFields.length > 0, 'sanity: the spawned Python import produced an empty table')
  assert.deepEqual(pythonFields, FIELDS, 'domain/py/fields.py disagrees with domain/js/fields.js about a field')
})

test('both bindings derive the same patch limits, with the same key ORDER', () => {
  const pythonLimits = spawnedPython('fields.patch_limits(fields.FIELDS)')
  const jsLimits = patchLimits()
  assert.ok(Object.keys(jsLimits).length > 0, 'sanity: the JS binding derives no patch limits')
  assert.deepEqual(pythonLimits, jsLimits)
  // JSON object key order survives JSON.parse in V8 for string keys, so this is
  // a real order comparison rather than a repeat of the deepEqual above.
  assert.deepEqual(Object.keys(pythonLimits), Object.keys(jsLimits))
})

test('both bindings agree on every field name -> maxLength pair, looked up by name', () => {
  const pythonAnswers = spawnedPython('{f["name"]: fields.field_by_name(fields.FIELDS, f["name"])["maxLength"] for f in fields.FIELDS}')
  assert.deepEqual(pythonAnswers, Object.fromEntries(FIELDS.map((f) => [f.name, fieldByName(f.name).maxLength])))
})

test('both bindings agree on the name -> column mapping, which is the one place it lives', () => {
  const pythonMapping = spawnedPython('{name: field["column"] for name, field in fields.BY_NAME.items()}')
  assert.deepEqual(pythonMapping, Object.fromEntries(FIELDS.map((f) => [f.name, f.column])))
  // Positive control: the mapping is not the identity everywhere — at least one
  // field's API name differs from its column, which is the whole reason the
  // mapping exists.
  assert.ok(FIELDS.some((f) => f.name !== f.column), 'no field renames its column — this check would be vacuous')
})

test("Python's BY_COLUMN covers every column, and agrees with the JS table", () => {
  const pythonByColumn = spawnedPython('{column: field["maxLength"] for column, field in fields.BY_COLUMN.items()}')
  assert.deepEqual(pythonByColumn, Object.fromEntries(FIELDS.map((f) => [f.column, f.maxLength])))
})

// intakeFields has no Python counterpart on purpose: the farm never serves the
// create form. Asserted here against the authored flag so the JS-only helper is
// still pinned to the document rather than to itself.
test('intakeFields is exactly the settableAtIntake entries, in authored order', () => {
  assert.deepEqual(intakeFields(), source.fields.filter((f) => f.settableAtIntake))
  assert.ok(intakeFields().length > 0)
  assert.ok(intakeFields().length < FIELDS.length, 'every field is settable at intake — the filter is vacuous')
})

test('the spawned Python import resolves the committed binding, not some other fields module on sys.path', () => {
  const resolved = execFileSync('python3', ['-c', 'from domain.py import fields; print(fields.__file__)'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  assert.equal(resolved, path.join(REPO_ROOT, 'domain/py/fields.py'))
})

test('the Python binding reads domain/fields.json from its own location, not the process cwd', () => {
  const resolved = execFileSync('python3', ['-c', 'from domain.py import fields; print(fields._SOURCE_PATH)'], {
    cwd: path.join(REPO_ROOT, 'server'),
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    encoding: 'utf8',
  }).trim()
  assert.equal(resolved, path.join(REPO_ROOT, 'domain/fields.json'))
})
