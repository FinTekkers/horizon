// HZ-398: domain/providers.json — the one declaration of every agent provider,
// its label and the models an owner may pick for a step. This is the JS half of
// the shared fixture (domain/fixtures/providers-cases.json);
// farm/tests/test_providers_domain.py runs the same cases against
// domain/py/providers.py.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { validate } from '../../domain/validate.mjs'
import * as binding from '../../domain/js/providers.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const read = (rel) => JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
const schema = read('domain/providers.schema.json')
const source = read('domain/providers.json')
const personas = read('domain/personas.json')
const cases = read('domain/fixtures/providers-cases.json')
const stub = cases.catalogue

test('the real domain/providers.json satisfies its schema and its load-time rules', () => {
  assert.deepEqual(validate(schema, source), [])
  assert.equal(binding.assertProvidersShape(source), source)
  assert.ok(binding.PROVIDERS.length > 0)
  assert.equal(binding.DEFAULT_PROVIDER, source.default)
})

test('the stub catalogue satisfies the schema too, so the cases below drive a well-formed document', () => {
  assert.deepEqual(validate(schema, stub), [])
})

for (const c of cases.validation) {
  test(`shared/validation: ${c.case}`, () => {
    const input = c.input === '$catalogue' ? stub : c.input
    if (c.expect.throws) {
      assert.throws(
        () => binding.assertProvidersShape(input),
        (err) => err.message.includes(c.expect.messageContains) || assert.fail(`got: ${err.message}`),
      )
    } else {
      assert.equal(binding.assertProvidersShape(input), input)
    }
  })
}

for (const c of cases.parseChoice) {
  test(`shared/parseChoice: ${c.case}`, () => {
    const got = binding.parseChoice(c.value, stub.providers)
    assert.deepEqual(got && [got.provider, got.model], c.expect)
  })
}

for (const c of cases.declares) {
  test(`shared/declares: ${c.case}`, () => {
    assert.equal(binding.declares(c.provider, c.model, stub.providers), c.expect)
  })
}

// Guardrail: "a later provider adds itself and its models in domain/ … with no
// picker, server or UI code change". zeta exists only in the fixture.
test('a provider declared only in a catalogue shows up in every derived list with no code change', () => {
  assert.deepEqual(binding.providerNames(stub.providers), ['alpha', 'zeta'])
  assert.deepEqual(binding.choiceValues(stub.providers), cases.choiceValues)
  assert.equal(binding.defaultModel('zeta', stub.providers), 'zeta-2')
  assert.equal(binding.choiceLabel('zeta:zeta-1', stub.providers), 'Zeta · One')
})

test('choiceLabel and modelLabel read their labels from the catalogue', () => {
  assert.equal(binding.choiceLabel('alpha', stub.providers), 'Alpha')
  assert.equal(binding.choiceLabel('alpha:alpha-small-1.5', stub.providers), 'Alpha · Small 1.5')
  assert.equal(binding.choiceLabel('alpha:alpha-hidden', stub.providers), null)
  assert.equal(binding.modelLabel('alpha', 'alpha-hidden', stub.providers), 'Hidden')
  assert.equal(binding.modelLabel('zeta', 'alpha-big-1', stub.providers), null)
  for (const p of source.providers) {
    for (const m of p.models.filter((x) => x.selectable)) {
      assert.equal(binding.choiceLabel(`${p.name}:${m.id}`), `${p.label} · ${m.label}`)
    }
  }
})

test('every model domain/personas.json names is declared under the default provider', () => {
  const ids = [
    ...Object.values(personas.models.agents),
    ...Object.values(personas.models.steps),
    ...Object.values(personas.models.personas),
  ]
  assert.ok(ids.length > 0)
  for (const id of ids) assert.ok(binding.declares(binding.DEFAULT_PROVIDER, id), id)
})

test('the live catalogue: choiceValues is every bare name plus every selectable provider:id, and nothing else', () => {
  const expected = [
    ...source.providers.map((p) => p.name),
    ...source.providers.flatMap((p) => p.models.filter((m) => m.selectable).map((m) => `${p.name}:${m.id}`)),
  ]
  assert.deepEqual(binding.choiceValues(), expected)
  for (const p of source.providers) {
    for (const m of p.models.filter((x) => !x.selectable)) assert.ok(!binding.choiceValues().includes(`${p.name}:${m.id}`))
  }
})

test('the exported catalogue is frozen', () => {
  assert.ok(Object.isFrozen(binding.PROVIDERS))
  assert.ok(Object.isFrozen(binding.PROVIDERS[0].models))
  assert.ok(Object.isFrozen(binding.PROVIDERS[0].models[0]))
})
