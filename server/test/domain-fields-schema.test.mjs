// HZ-134 success metric 1: "each work-item field's max length is declared once,
// in domain/." A declaration is only a declaration if something enforces its
// shape, so domain/fields.schema.json gets the same treatment
// domain/steps.schema.json and domain/reasons.schema.json get.
//
// The negative cases are one per schema keyword the contract relies on. The
// POSITIVE controls are not decoration: domain/validate.mjs is hand-rolled (no
// ajv — a new dependency is forbidden), and a validator that returned "invalid"
// unconditionally would pass every negative case on its own.
//
// Cross-field rules the Draft-07 subset cannot express — unique names, unique
// columns, minLength strictly below maxLength, at least one intake field, at
// least one agent-revisable field — are enforced at LOAD time by
// domain/js/fields.js's assertFieldsShape, covered at the bottom of this file
// both directly and through a real subprocess import. The cross-LANGUAGE half of
// that (the Python validator agreeing case for case) lives in
// domain/fixtures/fields-cases.json and its two suites.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { validate } from '../../domain/validate.mjs'
import { assertFieldsShape } from '../../domain/js/fields.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/fields.schema.json'), 'utf8'))
const source = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/fields.json'), 'utf8'))

// Fabricated entries, so no real field name or limit is typed into this file.
const INTAKE_FIELD = { name: 'alpha', column: 'alpha_col', minLength: 2, maxLength: 100, settableAtIntake: true, agentRevisable: false }
const REVISABLE_FIELD = { name: 'beta', column: 'beta_col', maxLength: 250, settableAtIntake: true, agentRevisable: true }

function table(...fields) {
  return { fields }
}

test('the real domain/fields.json satisfies its own schema', () => {
  assert.deepEqual(validate(schema, source), [])
})

// ---- positive controls (a broken validator cannot pass these) ----

test('POSITIVE CONTROL: a minimal valid table validates clean', () => {
  assert.deepEqual(validate(schema, table(INTAKE_FIELD, REVISABLE_FIELD)), [])
})

test('POSITIVE CONTROL: a field declaring no minLength validates clean — minLength is optional', () => {
  assert.deepEqual(validate(schema, table(REVISABLE_FIELD)), [])
})

// ---- negative cases, one per keyword the contract leans on ----

function expectInvalid(name, data, fragment) {
  test(`the schema rejects ${name}`, () => {
    const errors = validate(schema, data)
    assert.ok(errors.length > 0, `expected at least one error for ${name}`)
    if (fragment) {
      assert.ok(
        errors.some((e) => e.includes(fragment)),
        `no error mentioned "${fragment}"; got:\n  ${errors.join('\n  ')}`,
      )
    }
  })
}

expectInvalid('a field with no column (required)', table(omit(REVISABLE_FIELD, 'column')), 'column')
expectInvalid('a field with no name (required)', table(omit(REVISABLE_FIELD, 'name')), 'name')
expectInvalid('a field with no maxLength (required)', table(omit(REVISABLE_FIELD, 'maxLength')), 'maxLength')
expectInvalid('a field with no settableAtIntake (required)', table(omit(REVISABLE_FIELD, 'settableAtIntake')), 'settableAtIntake')
expectInvalid('a field with no agentRevisable (required)', table(omit(REVISABLE_FIELD, 'agentRevisable')), 'agentRevisable')
expectInvalid('a string maxLength (type)', table({ ...REVISABLE_FIELD, maxLength: '250' }), 'maxLength')
expectInvalid('a maxLength of zero (minimum)', table({ ...REVISABLE_FIELD, maxLength: 0 }), 'maxLength')
expectInvalid('a minLength of zero (minimum)', table({ ...REVISABLE_FIELD, minLength: 0 }), 'minLength')
expectInvalid('a non-boolean agentRevisable (type)', table({ ...REVISABLE_FIELD, agentRevisable: 'yes' }), 'agentRevisable')
expectInvalid('an empty name (minLength)', table({ ...REVISABLE_FIELD, name: '' }), 'name')
expectInvalid('an unknown extra property (additionalProperties)', table({ ...REVISABLE_FIELD, colour: 'red' }), 'colour')
expectInvalid('an empty fields array (minItems)', table())
expectInvalid('a missing fields array (required)', {}, 'fields')
expectInvalid('a top-level extra key (additionalProperties)', { ...table(REVISABLE_FIELD), version: 2 }, 'version')
expectInvalid(
  'two byte-identical field entries (uniqueItems)',
  table(REVISABLE_FIELD, { ...REVISABLE_FIELD }),
  'unique',
)

// ---- cross-field rules, enforced at LOAD time by the binding itself ----

test('SANITY: assertFieldsShape accepts the real domain/fields.json unchanged', () => {
  assert.equal(assertFieldsShape(source), source)
})

test('assertFieldsShape rejects a duplicate field name, naming it', () => {
  const dupeName = source.fields[0].name
  const broken = table(source.fields[0], { ...source.fields[1], name: dupeName })
  assert.throws(() => assertFieldsShape(broken), (err) => {
    assert.match(err.message, /has duplicate field name\(s\)/)
    assert.ok(err.message.includes(dupeName), `error does not name the duplicated field: ${err.message}`)
    return true
  })
})

test('assertFieldsShape rejects a duplicate column, naming it', () => {
  const dupeColumn = source.fields[0].column
  const broken = table(source.fields[0], { ...source.fields[1], column: dupeColumn })
  assert.throws(() => assertFieldsShape(broken), (err) => {
    assert.match(err.message, /has duplicate column\(s\)/)
    assert.ok(err.message.includes(dupeColumn), `error does not name the duplicated column: ${err.message}`)
    return true
  })
})

test('assertFieldsShape rejects a minLength at or above its own maxLength', () => {
  const broken = table({ ...REVISABLE_FIELD, minLength: REVISABLE_FIELD.maxLength })
  assert.throws(() => assertFieldsShape(broken), /at or above maxLength .* no value could satisfy it/)
})

test('assertFieldsShape rejects a table with nothing settable at intake', () => {
  const broken = table({ ...REVISABLE_FIELD, settableAtIntake: false })
  assert.throws(() => assertFieldsShape(broken), /no field is settableAtIntake/)
})

test('assertFieldsShape rejects a table with nothing agent-revisable', () => {
  const broken = table({ ...INTAKE_FIELD, agentRevisable: false })
  assert.throws(() => assertFieldsShape(broken), /no field is agentRevisable/)
})

// ---- the IMPORT itself rejects a broken table ----
// Calling assertFieldsShape directly only proves the validator works. This
// proves the BINDING calls it: a future edit that drops the call site leaves
// every test above green and this one red. Runs a real `node` against a
// tampered copy of domain/ in a temp dir and asserts both a non-zero exit AND
// the specific message — a syntax error also exits non-zero.

function tamperedDomain(newSource) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-fields-')), 'domain')
  cpSync(path.join(REPO_ROOT, 'domain'), dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'fields.json'),
    typeof newSource === 'string' ? newSource : `${JSON.stringify(newSource, null, 2)}\n`,
  )
  return dir
}

function importBinding(domainDir) {
  return spawnSync(process.execPath, ['-e', `import(${JSON.stringify(path.join(domainDir, 'js/fields.js'))})`], {
    encoding: 'utf8',
  })
}

function importPythonBinding(domainDir) {
  return spawnSync('python3', ['-c', 'from domain.py import fields'], {
    cwd: path.dirname(domainDir),
    encoding: 'utf8',
  })
}

test('SANITY: importing an UNtampered copy of domain/ succeeds — the temp-dir harness itself works', () => {
  const dir = tamperedDomain(source)
  assert.equal(importBinding(dir).status, 0, 'importing an untouched copy failed')
  assert.equal(importPythonBinding(dir).status, 0, 'importing an untouched copy failed in Python')
})

test('importing the JS binding over a fields.json with a duplicate column fails, naming it', () => {
  const dupeColumn = source.fields[0].column
  const broken = table(source.fields[0], { ...source.fields[1], column: dupeColumn })
  const result = importBinding(tamperedDomain(broken))
  assert.notEqual(result.status, 0, 'the JS binding imported a table with a duplicate column')
  assert.match(result.stderr, /has duplicate column\(s\)/)
  assert.ok(result.stderr.includes(dupeColumn), `the import error does not name the column: ${result.stderr}`)
})

// The same tamper, through the OTHER binding. Both do file-level validation at
// import, so both have to be proven to call it — the fixture suites compare the
// two validators case for case, but only a real import proves each is wired in.
test('importing the Python binding over the same tampered fields.json fails too', () => {
  const dupeColumn = source.fields[0].column
  const broken = table(source.fields[0], { ...source.fields[1], column: dupeColumn })
  const result = importPythonBinding(tamperedDomain(broken))
  assert.notEqual(result.status, 0, 'domain/py/fields.py imported a table with a duplicate column')
  assert.match(result.stderr, /has duplicate column\(s\)/)
})

test('importing the JS binding over a fields.json with nothing agent-revisable fails', () => {
  const broken = { fields: source.fields.map((f) => ({ ...f, agentRevisable: false })) }
  const result = importBinding(tamperedDomain(broken))
  assert.notEqual(result.status, 0, 'the JS binding imported a table with no agent-revisable field')
  assert.match(result.stderr, /no field is agentRevisable/)
})

test('importing the JS binding over malformed JSON fails — the one case a .json fixture cannot express', () => {
  const result = importBinding(tamperedDomain('{ "fields": [], }'))
  assert.notEqual(result.status, 0, 'the JS binding imported malformed JSON')
})

test('importing the Python binding over malformed JSON fails with its own message', () => {
  const result = importPythonBinding(tamperedDomain('{ "fields": [], }'))
  assert.notEqual(result.status, 0, 'domain/py/fields.py imported malformed JSON')
  assert.match(result.stderr, /is not valid JSON/)
})

function omit(obj, key) {
  const { [key]: _dropped, ...rest } = obj
  return rest
}
