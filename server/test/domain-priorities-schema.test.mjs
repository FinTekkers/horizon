// HZ-135: domain/priorities.schema.json validates domain/priorities.json, and
// the rules a Draft-07 subset cannot express are enforced at LOAD time by the
// binding itself.
//
// Same two-layer shape as domain-reasons-schema.test.mjs and
// domain-fields-schema.test.mjs, for the same reasons: domain/validate.mjs is
// hand-rolled (no ajv — a new dependency is forbidden), so a validator that
// returned "invalid" unconditionally would pass every negative case below. The
// POSITIVE controls are what rule that out.
//
// The load-time rules are the value shape (^[A-Z][A-Za-z]*$), case-INSENSITIVE
// uniqueness, and `default` being a member of `priorities`. All three are
// load-bearing — see the comment block in domain/js/priorities.js. The value
// shape especially: server/src/db.js interpolates these values into a SQL CHECK
// constraint, so it is what makes the generated clause provably safe.
//
// Every priority value this file fabricates is deliberately NOT a real one, so
// it is not a second declaration of the vocabulary and needs no allowlist entry
// in domain-priority-literals.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { validate } from '../../domain/validate.mjs'
import { assertPrioritiesShape } from '../../domain/js/priorities.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/priorities.schema.json'), 'utf8'))
const source = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/priorities.json'), 'utf8'))

function doc(priorities, dflt = priorities[0]) {
  return { priorities, default: dflt }
}

test('the real domain/priorities.json satisfies its own schema', () => {
  assert.deepEqual(validate(schema, source), [])
})

// ---- positive controls (a broken validator cannot pass these) ----

test('POSITIVE CONTROL: a minimal valid vocabulary validates clean', () => {
  assert.deepEqual(validate(schema, doc(['Alpha'])), [])
})

test('POSITIVE CONTROL: a multi-value vocabulary with a non-first default validates clean', () => {
  assert.deepEqual(validate(schema, doc(['Alpha', 'Beta', 'Gamma'], 'Beta')), [])
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

expectInvalid('a missing priorities array (required)', { default: 'Alpha' }, 'priorities')
expectInvalid('a missing default (required)', { priorities: ['Alpha'] }, 'default')
expectInvalid('a non-array priorities key (type)', doc('Alpha'), 'priorities')
expectInvalid('an empty priorities array (minItems)', doc([]), 'priorities')
expectInvalid('a non-string value (type)', { priorities: ['Alpha', 7], default: 'Alpha' }, 'priorities')
expectInvalid('an empty-string value (minLength)', { priorities: ['Alpha', ''], default: 'Alpha' }, 'priorities')
expectInvalid('a byte-identical duplicate (uniqueItems)', doc(['Alpha', 'Alpha']), 'unique')
expectInvalid('a non-string default (type)', { priorities: ['Alpha'], default: 3 }, 'default')
expectInvalid('an empty-string default (minLength)', { priorities: ['Alpha'], default: '' }, 'default')
expectInvalid('a top-level extra key (additionalProperties)', { ...doc(['Alpha']), version: 2 }, 'version')

// The schema deliberately CANNOT express these three; they are the load-time
// rules' whole reason to exist. Asserting the schema passes them is what proves
// the split is real rather than assumed — if a future schema keyword closed one
// of these, this test would fail and point at the duplication.
test('the schema alone accepts what only the LOAD-TIME rules reject — which is why they exist', () => {
  assert.deepEqual(validate(schema, doc(['Alpha', 'alpha'])), [], 'a case-only duplicate')
  assert.deepEqual(validate(schema, doc(['Alpha Beta'])), [], 'a value with a space')
  assert.deepEqual(validate(schema, doc(['Alpha'], 'Gamma')), [], 'a default outside the vocabulary')
  for (const bad of [doc(['Alpha', 'alpha']), doc(['Alpha Beta']), doc(['Alpha'], 'Gamma')]) {
    assert.throws(() => assertPrioritiesShape(bad), Error)
  }
})

// ---- load-time rules, enforced by the binding itself ----

test('SANITY: assertPrioritiesShape accepts the real domain/priorities.json unchanged', () => {
  assert.equal(assertPrioritiesShape(source), source)
})

test('assertPrioritiesShape rejects a value that is not a capitalised letters-only word', () => {
  // The SQL-safety rule. Each of these would be interpolated into the work_item
  // CHECK constraint by server/src/db.js.
  for (const bad of ['alpha', 'Alpha Beta', 'Alpha-Beta', 'Alpha2', 'ALPHA!', "Alpha'", '']) {
    assert.throws(
      () => assertPrioritiesShape(doc(['Zeta', bad], 'Zeta')),
      /expected a capitalised letters-only word/,
      `"${bad}" was accepted`,
    )
  }
  // A quote is the one that would actually break the generated clause, so it
  // gets named rather than left inside the loop above.
  assert.throws(() => assertPrioritiesShape(doc(["Alpha') OR 1=1 --"])), /expected a capitalised letters-only word/)
})

test('assertPrioritiesShape rejects a non-string value, naming the index', () => {
  assert.throws(() => assertPrioritiesShape(doc(['Alpha', 7], 'Alpha')), (err) => {
    assert.match(err.message, /priorities\[1\]/)
    assert.match(err.message, /expected a capitalised letters-only word/)
    return true
  })
})

test('assertPrioritiesShape rejects duplicates IGNORING CASE — label matching is case-insensitive', () => {
  assert.throws(() => assertPrioritiesShape(doc(['Alpha', 'ALPHA'])), (err) => {
    assert.match(err.message, /duplicate priority value\(s\), ignoring case/)
    assert.ok(err.message.includes('alpha'), `error does not name the duplicate: ${err.message}`)
    return true
  })
  // And the byte-identical case, which the schema also catches — both layers.
  assert.throws(() => assertPrioritiesShape(doc(['Alpha', 'Alpha'])), /duplicate priority value/)
})

test('assertPrioritiesShape rejects a default outside the vocabulary', () => {
  assert.throws(() => assertPrioritiesShape(doc(['Alpha', 'Beta'], 'Gamma')), (err) => {
    assert.match(err.message, /is not one of the declared priorities/)
    assert.ok(err.message.includes('Gamma'))
    return true
  })
})

test('assertPrioritiesShape rejects a missing or non-string default, reporting it as null not undefined', () => {
  // `null` rather than the bare word `undefined`, so the message is
  // byte-comparable with the Python binding's json.dumps(None).
  assert.throws(() => assertPrioritiesShape({ priorities: ['Alpha'] }), /default null is not one of/)
  assert.throws(() => assertPrioritiesShape({ priorities: ['Alpha'], default: 1 }), /default 1 is not one of/)
})

test('assertPrioritiesShape rejects an empty or non-array priorities key, and a non-object document', () => {
  assert.throws(() => assertPrioritiesShape(doc([])), /non-empty JSON array/)
  assert.throws(() => assertPrioritiesShape({ priorities: 'Alpha', default: 'Alpha' }), /non-empty JSON array/)
  assert.throws(() => assertPrioritiesShape(['Alpha']), /must be a JSON object/)
  assert.throws(() => assertPrioritiesShape(null), /must be a JSON object/)
})

// ---- the IMPORT itself rejects a broken vocabulary ----
// Calling assertPrioritiesShape directly only proves the validator works. This
// proves the BINDING calls it: a future edit that drops the call site leaves
// every test above green and this one red. Same temp-dir harness
// domain-reasons-schema.test.mjs uses.

function tamperedDomain(newSource) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-priorities-')), 'domain')
  cpSync(path.join(REPO_ROOT, 'domain'), dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'priorities.json'),
    typeof newSource === 'string' ? newSource : `${JSON.stringify(newSource, null, 2)}\n`,
  )
  return dir
}

function importJsBinding(domainDir) {
  return spawnSync(process.execPath, ['-e', `import(${JSON.stringify(path.join(domainDir, 'js/priorities.js'))})`], {
    encoding: 'utf8',
  })
}

// The Python half gets the same treatment rather than being trusted: it is a
// separate hand-written validator, and a dropped call site there would be
// invisible to every JS test in this directory.
//
// Resolved off the temp copy's PARENT, as `domain.py`, exactly the way the farm
// resolves it off the repo root — not as a bare `py`, which would collide with
// the unrelated `py` distribution that happens to be installed on this host.
function importPyBinding(domainDir) {
  const root = path.dirname(domainDir)
  return spawnSync('python3', ['-c', 'from domain.py import priorities'], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: root },
    encoding: 'utf8',
  })
}

test('SANITY: importing an UNtampered copy of domain/ succeeds in both languages — the harness works', () => {
  const dir = tamperedDomain(source)
  assert.equal(importJsBinding(dir).status, 0, 'the JS import of an untouched copy failed')
  assert.equal(importPyBinding(dir).status, 0, 'the Python import of an untouched copy failed')
})

// `['Alpha', 'ALPHA']` rather than `['Alpha', 'alpha']`: both are duplicates
// ignoring case, but the lower-case form trips the VALUE SHAPE rule first, so it
// would exercise the wrong check. This pair is shape-valid and collides only on
// the fold — which is the rule under test.
for (const [name, tampered, pattern] of [
  ['a case-only duplicate', doc(['Alpha', 'ALPHA'], 'Alpha'), /duplicate priority value/],
  ['a value that could not be interpolated into SQL safely', doc(["Alpha') OR 1=1 --"]), /capitalised letters-only word/],
  ['a default outside the vocabulary', doc(['Alpha', 'Beta'], 'Gamma'), /is not one of the declared priorities/],
  ['an empty vocabulary', doc([], 'Alpha'), /non-empty JSON array/],
]) {
  test(`importing the JS binding over ${name} fails`, () => {
    const result = importJsBinding(tamperedDomain(tampered))
    assert.notEqual(result.status, 0, `the JS binding imported ${name}`)
    assert.match(result.stderr, pattern)
  })

  test(`importing the PYTHON binding over ${name} fails too`, () => {
    const result = importPyBinding(tamperedDomain(tampered))
    assert.notEqual(result.status, 0, `the Python binding imported ${name}`)
    assert.match(result.stderr, pattern)
  })
}

test('importing either binding over malformed JSON fails — the one case a .json fixture cannot express', () => {
  const dir = tamperedDomain('{ "priorities": [], }')
  assert.notEqual(importJsBinding(dir).status, 0, 'the JS binding imported malformed JSON')
  const py = importPyBinding(dir)
  assert.notEqual(py.status, 0, 'the Python binding imported malformed JSON')
  assert.match(py.stderr, /is not valid JSON/)
})
