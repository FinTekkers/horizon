// HZ-132: domain/reasons.schema.json validates domain/reasons.json, and the
// rules a Draft-07 subset cannot express are enforced at LOAD time by the
// binding itself.
//
// Same two-layer shape as domain-schema.test.mjs, for the same reasons:
// domain/validate.mjs is hand-rolled (no ajv — a new dependency is forbidden),
// so a validator that returned "invalid" unconditionally would pass every
// negative case below. The POSITIVE controls are what rule that out.
//
// The load-time rules are id shape, unique ids, a strictly-boolean retryable,
// and at-least-one-retryable. The id-shape rule is load-bearing: REASON's keys
// are derived by id.toUpperCase().
//
// This file fabricates reason documents, valid and invalid, so it is on
// domain-reason-literals.test.mjs's allowlist — but the ids it fabricates are
// deliberately NOT the real vocabulary, so it is not a second declaration.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { validate } from '../../domain/validate.mjs'
import { assertReasonsShape } from '../../domain/js/reasons.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/reasons.schema.json'), 'utf8'))
const source = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/reasons.json'), 'utf8'))

// Fabricated ids, not the real vocabulary.
const RETRYABLE = { id: 'a_transient_thing', retryable: true }
const TERMINAL = { id: 'a_terminal_thing', retryable: false }

function doc(...reasons) {
  return { reasons }
}

test('the real domain/reasons.json satisfies its own schema', () => {
  assert.deepEqual(validate(schema, source), [])
})

// ---- positive controls (a broken validator cannot pass these) ----

test('POSITIVE CONTROL: a minimal valid vocabulary validates clean', () => {
  assert.deepEqual(validate(schema, doc(RETRYABLE)), [])
})

test('POSITIVE CONTROL: a mixed retryable/terminal vocabulary validates clean', () => {
  assert.deepEqual(validate(schema, doc(RETRYABLE, TERMINAL)), [])
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

expectInvalid('a reason with no id (required)', doc({ retryable: true }), 'id')
expectInvalid('a reason with no retryable flag (required)', doc({ id: 'a_thing' }), 'retryable')
expectInvalid('a non-boolean retryable (type)', doc({ ...RETRYABLE, retryable: 'true' }), 'retryable')
expectInvalid('a non-string id (type)', doc({ ...RETRYABLE, id: 7 }), 'id')
expectInvalid('an empty id (minLength)', doc({ ...RETRYABLE, id: '' }), 'id')
expectInvalid('an unknown extra property (additionalProperties)', doc({ ...RETRYABLE, label: 'Timed out' }), 'label')
expectInvalid('an empty reasons array (minItems)', doc())
expectInvalid('a byte-identical duplicate entry (uniqueItems)', doc(RETRYABLE, RETRYABLE), 'unique')
expectInvalid('a missing reasons array (required)', {}, 'reasons')
expectInvalid('a top-level extra key (additionalProperties)', { ...doc(RETRYABLE), version: 2 }, 'version')

// ---- load-time rules, enforced by the binding itself ----

test('SANITY: assertReasonsShape accepts the real domain/reasons.json unchanged', () => {
  assert.equal(assertReasonsShape(source), source)
})

test('assertReasonsShape rejects duplicate ids, naming them', () => {
  const dupId = source.reasons[0].id
  const broken = doc(source.reasons[0], { ...source.reasons[1], id: dupId })
  assert.throws(() => assertReasonsShape(broken), (err) => {
    assert.match(err.message, /duplicate reason id/)
    assert.ok(err.message.includes(dupId), `error does not name the duplicated id: ${err.message}`)
    return true
  })
})

test('assertReasonsShape rejects a hyphenated id — REASON keys are derived by toUpperCase()', () => {
  assert.throws(() => assertReasonsShape(doc({ id: 'a-transient-thing', retryable: true })), /expected lower_snake_case/)
})

test('assertReasonsShape rejects a mixed-case id — it would collide with its own lower-case form', () => {
  assert.throws(() => assertReasonsShape(doc({ id: 'A_Transient_Thing', retryable: true })), /expected lower_snake_case/)
})

test('assertReasonsShape rejects an id starting with a digit or an underscore', () => {
  for (const id of ['1_thing', '_thing']) {
    assert.throws(() => assertReasonsShape(doc({ id, retryable: true })), /expected lower_snake_case/)
  }
})

test('assertReasonsShape rejects a truthy STRING retryable — a flag, not a truthy value', () => {
  assert.throws(() => assertReasonsShape(doc({ ...RETRYABLE, retryable: 'true' })), /non-boolean retryable/)
  assert.throws(() => assertReasonsShape(doc({ ...RETRYABLE, retryable: 1 })), /non-boolean retryable/)
})

test('assertReasonsShape rejects a vocabulary with nothing retryable', () => {
  assert.throws(() => assertReasonsShape(doc(TERMINAL)), /no reason is retryable/)
})

test('assertReasonsShape rejects an empty or non-array reasons key, and a non-object document', () => {
  assert.throws(() => assertReasonsShape(doc()), /non-empty JSON array/)
  assert.throws(() => assertReasonsShape({ reasons: 'a_transient_thing' }), /non-empty JSON array/)
  assert.throws(() => assertReasonsShape([RETRYABLE]), /must be a JSON object/)
  assert.throws(() => assertReasonsShape(null), /must be a JSON object/)
})

// ---- the IMPORT itself rejects a broken vocabulary ----
// Calling assertReasonsShape directly only proves the validator works. This
// proves the BINDING calls it: a future edit that drops the call site leaves
// every test above green and this one red. Same temp-dir harness
// domain-schema.test.mjs uses for the step table.

function tamperedDomain(newSource) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-reasons-')), 'domain')
  cpSync(path.join(REPO_ROOT, 'domain'), dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'reasons.json'),
    typeof newSource === 'string' ? newSource : `${JSON.stringify(newSource, null, 2)}\n`,
  )
  return dir
}

function importBinding(domainDir) {
  return spawnSync(process.execPath, ['-e', `import(${JSON.stringify(path.join(domainDir, 'js/reasons.js'))})`], {
    encoding: 'utf8',
  })
}

test('SANITY: importing an UNtampered copy of domain/ succeeds — the temp-dir harness itself works', () => {
  const result = importBinding(tamperedDomain(source))
  assert.equal(result.status, 0, `importing an untouched copy failed: ${result.stderr}`)
})

test('importing the JS binding over a reasons.json with duplicate ids fails, naming them', () => {
  const dupId = source.reasons[0].id
  const result = importBinding(tamperedDomain(doc(source.reasons[0], { ...source.reasons[1], id: dupId })))
  assert.notEqual(result.status, 0, 'the JS binding imported a vocabulary with duplicate ids')
  assert.match(result.stderr, /duplicate reason id/)
  assert.ok(result.stderr.includes(dupId), `the import error does not name the duplicated id: ${result.stderr}`)
})

test('importing the JS binding over a reasons.json with a hyphenated id fails', () => {
  const result = importBinding(tamperedDomain(doc({ id: 'a-transient-thing', retryable: true })))
  assert.notEqual(result.status, 0, 'the JS binding imported an id that cannot become a REASON key')
  assert.match(result.stderr, /expected lower_snake_case/)
})

test('importing the JS binding over a reasons.json with nothing retryable fails', () => {
  const result = importBinding(tamperedDomain(doc(TERMINAL)))
  assert.notEqual(result.status, 0, 'the JS binding imported a vocabulary that retries nothing')
  assert.match(result.stderr, /no reason is retryable/)
})

test('importing the JS binding over malformed JSON fails — the one case a .json fixture cannot express', () => {
  const result = importBinding(tamperedDomain('{ "reasons": [], }'))
  assert.notEqual(result.status, 0, 'the JS binding imported malformed JSON')
})
