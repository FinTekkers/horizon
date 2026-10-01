// HZ-133: domain/personas.schema.json validates domain/personas.json, and the
// rules a Draft-07 subset cannot express are enforced at LOAD time by the
// bindings themselves.
//
// Same two-layer shape as domain-priorities-schema.test.mjs: domain/validate.mjs
// is hand-rolled (no ajv — a new dependency is forbidden), so a validator that
// returned "invalid" unconditionally would pass every negative case below. The
// POSITIVE controls are what rule that out. The per-rule message fragments are
// covered by domain/fixtures/personas-cases.json in both languages; this file
// proves the split between schema and load-time rules is real, and that each
// binding actually CALLS its own validator on import.
//
// Every agent and persona id this file fabricates is deliberately not a real one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { validate } from '../../domain/validate.mjs'
import { assertPersonasShape } from '../../domain/js/personas.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/personas.schema.json'), 'utf8'))
const source = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/personas.json'), 'utf8'))

function doc({ agents = [{ agent: 'alpha', default: 'one', personas: ['one', 'two'] }], ...rest } = {}) {
  return { primaryAgent: 'alpha', agents, legacyIds: {}, personaProviders: {}, models: models(), ...rest }
}

function models(rest = {}) {
  return { agents: { alpha: 'claude-test-1' }, conflictAgent: 'alpha', steps: {}, personas: {}, ...rest }
}

test('the real domain/personas.json satisfies its own schema', () => {
  assert.deepEqual(validate(schema, source), [])
})

// ---- positive controls (a broken validator cannot pass these) ----

test('POSITIVE CONTROL: a minimal valid registry validates clean', () => {
  assert.deepEqual(validate(schema, doc()), [])
})

test('POSITIVE CONTROL: legacy aliases and a provider override validate clean', () => {
  assert.deepEqual(validate(schema, doc({ legacyIds: { old_one: 'alpha.one' }, personaProviders: { 'alpha.two': 'prov' } })), [])
})

// ---- negative cases, one per keyword the contract leans on ----

function expectInvalid(name, data, fragment) {
  test(`the schema rejects ${name}`, () => {
    const errors = validate(schema, data)
    assert.ok(errors.length > 0, `expected at least one error for ${name}`)
    assert.ok(
      errors.some((e) => e.includes(fragment)),
      `no error mentioned "${fragment}"; got:\n  ${errors.join('\n  ')}`,
    )
  })
}

const { primaryAgent, ...noPrimary } = doc()
expectInvalid('a missing primaryAgent (required)', noPrimary, 'primaryAgent')
expectInvalid('a missing legacyIds (required)', { primaryAgent, agents: doc().agents, personaProviders: {} }, 'legacyIds')
expectInvalid('a missing personaProviders (required)', { primaryAgent, agents: doc().agents, legacyIds: {} }, 'personaProviders')
expectInvalid('an empty agents array (minItems)', doc({ agents: [] }), 'agents')
expectInvalid('a non-object agents entry (type)', doc({ agents: ['alpha'] }), 'agents[0]')
expectInvalid('an agents entry with no personas (required)', doc({ agents: [{ agent: 'alpha', default: 'one' }] }), 'personas')
expectInvalid('an empty personas array (minItems)', doc({ agents: [{ agent: 'alpha', default: 'one', personas: [] }] }), 'personas')
expectInvalid(
  'a byte-identical duplicate persona (uniqueItems)',
  doc({ agents: [{ agent: 'alpha', default: 'one', personas: ['one', 'one'] }] }),
  'unique',
)
expectInvalid('a non-object legacyIds (type)', doc({ legacyIds: ['alpha.one'] }), 'legacyIds')
expectInvalid('a top-level extra key (additionalProperties)', { ...doc(), version: 2 }, 'version')

// HZ-192: the models block. The pre-HZ-192 document — today's file without it
// — must fail loudly, naming `models`.
const { models: _dropped, ...noModels } = doc()
expectInvalid('the pre-HZ-192 shape with no models block (required)', noModels, 'models')
expectInvalid('a non-object models block (type)', doc({ models: [] }), 'models')
expectInvalid('an unknown key under models (additionalProperties)', doc({ models: models({ default: 'claude-test-1' }) }), 'default')
expectInvalid('a models block with no agents (required)', doc({ models: { conflictAgent: 'alpha', steps: {}, personas: {} } }), 'agents')
expectInvalid('a models block with no conflictAgent (required)', doc({ models: { agents: { alpha: 'claude-test-1' }, steps: {}, personas: {} } }), 'conflictAgent')

test('POSITIVE CONTROL: step and persona model overrides validate clean', () => {
  assert.deepEqual(validate(schema, doc({ models: models({ steps: { 'Some step': 'claude-test-2' }, personas: { 'alpha.one': 'claude-test-3' } }) })), [])
})

// additionalProperties:false on each entry is what keeps presentation out of
// this document structurally (guardrail 5): a label, initials, colour or file
// beside a persona has nowhere to go.
for (const key of ['label', 'initials', 'color', 'file']) {
  expectInvalid(
    `a presentation key "${key}" on an agent entry (additionalProperties)`,
    doc({ agents: [{ agent: 'alpha', default: 'one', personas: ['one'], [key]: 'x' }] }),
    key,
  )
}

// The schema deliberately CANNOT express these; they are the load-time rules'
// whole reason to exist. Asserting the schema passes them is what proves the
// split is real rather than assumed.
const ONLY_LOAD_TIME = [
  ['a path-traversing persona id', doc({ agents: [{ agent: 'alpha', default: 'one', personas: ['one', '../x'] }] }), /expected a lower-case id/],
  ['a default from outside its agent', doc({ agents: [{ agent: 'alpha', default: 'nope', personas: ['one'] }] }), /is not one of agent/],
  ['an undeclared primaryAgent', doc({ primaryAgent: 'gamma' }), /is not a declared agent/],
  ['a legacy alias naming a dead pair', doc({ legacyIds: { old_one: 'alpha.nope' } }), /does not name a declared <agent>\.<persona> pair/],
  ['a bare personaProviders key', doc({ personaProviders: { one: 'prov' } }), /does not name a declared <agent>\.<persona> pair/],
  ['a non-Claude model id', doc({ models: models({ agents: { alpha: 'gpt-4o' } }) }), /is not a Claude model id/],
  [
    'a model on a persona routed to another provider',
    doc({ personaProviders: { 'alpha.two': 'muse' }, models: models({ personas: { 'alpha.two': 'claude-test-1' } }) }),
    /only a Claude-run persona can carry a model/,
  ],
  [
    'a duplicate agent',
    doc({ agents: [{ agent: 'alpha', default: 'one', personas: ['one'] }, { agent: 'alpha', default: 'two', personas: ['two'] }] }),
    /is declared more than once/,
  ],
]

test('the schema alone accepts what only the LOAD-TIME rules reject — which is why they exist', () => {
  for (const [name, bad, pattern] of ONLY_LOAD_TIME) {
    assert.deepEqual(validate(schema, bad), [], name)
    assert.throws(() => assertPersonasShape(bad), pattern, name)
  }
})

test('SANITY: assertPersonasShape accepts the real domain/personas.json unchanged', () => {
  assert.equal(assertPersonasShape(source), source)
})

// ---- the IMPORT itself rejects a broken registry ----
// Calling assertPersonasShape directly only proves the validator works. This
// proves each BINDING calls its own: a future edit that drops a call site leaves
// every test above green and this one red.

function tamperedDomain(newSource) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-personas-')), 'domain')
  cpSync(path.join(REPO_ROOT, 'domain'), dir, { recursive: true })
  writeFileSync(path.join(dir, 'personas.json'), typeof newSource === 'string' ? newSource : `${JSON.stringify(newSource, null, 2)}\n`)
  return dir
}

function importJsBinding(domainDir) {
  return spawnSync(process.execPath, ['-e', `import(${JSON.stringify(path.join(domainDir, 'js/personas.js'))})`], {
    encoding: 'utf8',
  })
}

// Resolved off the temp copy's PARENT, as `domain.py`, exactly the way the farm
// resolves it off the repo root.
function importPyBinding(domainDir) {
  const root = path.dirname(domainDir)
  return spawnSync('python3', ['-c', 'from domain.py import personas'], {
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

for (const [name, tampered, pattern] of [
  ...ONLY_LOAD_TIME,
  ['an empty agents array', doc({ agents: [] }), /agents must be a non-empty JSON array/],
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
  const dir = tamperedDomain('{ "agents": [], }')
  assert.notEqual(importJsBinding(dir).status, 0, 'the JS binding imported malformed JSON')
  const py = importPyBinding(dir)
  assert.notEqual(py.status, 0, 'the Python binding imported malformed JSON')
  assert.match(py.stderr, /is not valid JSON/)
})
