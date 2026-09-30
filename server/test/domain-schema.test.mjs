// HZ-128 success criterion 3: "domain/steps.schema.json validates steps.json.
// A test feeds an invalid table and asserts it fails."
//
// The negative cases are one per schema keyword the contract relies on. The
// POSITIVE controls are not decoration: domain/validate.mjs is hand-rolled (no
// ajv — guardrail 3 forbids a new dependency), and a validator that returned
// "invalid" unconditionally would pass every negative case on its own. The two
// positive controls are what rule that out.
//
// Cross-field rules the Draft-07 subset cannot express — a step's `phase` being
// in range of `phases`, unique labels — are enforced by domain/generate.mjs's
// loadSource() and covered at the bottom of this file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { validate } from '../../domain/validate.mjs'
import { loadSource, REPO_ROOT } from '../../domain/generate.mjs'

const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/steps.schema.json'), 'utf8'))
const source = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/steps.json'), 'utf8'))

const AGENT_STEP = { phase: 0, kind: 'agent', agent: 'PM', label: 'A PM Step', runsIn: 'pm' }
const GATE_STEP = { phase: 0, kind: 'gate', gate: 'required', label: 'A Gate' }
const FARM_STEP = {
  phase: 1,
  kind: 'agent',
  agent: 'Eng',
  label: 'A Farm Step',
  runsIn: 'farm',
  workspaceMutating: false,
  providerOverrideEligible: true,
  providerLocked: false,
  maxTurns: 40,
  timeoutS: 1140,
}

function table(...steps) {
  return { phases: ['Plan', 'Technical Plan'], steps }
}

test('the real domain/steps.json satisfies its own schema', () => {
  assert.deepEqual(validate(schema, source), [])
})

// ---- positive controls (a broken validator cannot pass these) ----

test('POSITIVE CONTROL: a minimal valid table with requires validates clean', () => {
  const valid = table(FARM_STEP, { ...FARM_STEP, label: 'A Reviewer', requires: ['A Farm Step'] })
  assert.deepEqual(validate(schema, valid), [])
})

test('POSITIVE CONTROL: a gate declaring none of the farm fields validates clean', () => {
  assert.deepEqual(validate(schema, table(AGENT_STEP, GATE_STEP)), [])
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

expectInvalid('a step with no label (required)', table({ phase: 0, kind: 'gate', gate: 'required' }), 'label')
expectInvalid('an unknown kind (enum)', table({ ...GATE_STEP, kind: 'banana' }), 'banana')
expectInvalid('a non-integer maxTurns (type)', table({ ...FARM_STEP, maxTurns: 'forty' }), 'maxTurns')
expectInvalid('a maxTurns of zero (minimum)', table({ ...FARM_STEP, maxTurns: 0 }), 'maxTurns')
expectInvalid('an empty label (minLength)', table({ ...GATE_STEP, label: '' }), 'label')
expectInvalid('an unknown extra property (additionalProperties)', table({ ...GATE_STEP, colour: 'red' }), 'colour')
expectInvalid('a farm step missing providerLocked (if/then)', table(omit(FARM_STEP, 'providerLocked')), 'providerLocked')
expectInvalid('an agent step with no runsIn (if/then)', table(omit(AGENT_STEP, 'runsIn')), 'runsIn')
expectInvalid('a gate that also names an agent (not)', table({ ...GATE_STEP, agent: 'PM' }))
expectInvalid('an agent step that also declares a gate (not)', table({ ...AGENT_STEP, gate: 'required' }))
expectInvalid('an unknown agent (enum)', table({ ...AGENT_STEP, agent: 'Wizard' }), 'Wizard')
expectInvalid('an unknown lane (enum)', table({ ...AGENT_STEP, runsIn: 'moon' }), 'moon')
expectInvalid('an empty steps array (minItems)', table())
expectInvalid('a missing phases array (required)', { steps: [GATE_STEP] }, 'phases')
expectInvalid('a top-level extra key (additionalProperties)', { ...table(GATE_STEP), version: 2 }, 'version')
expectInvalid('duplicate phase names (uniqueItems)', { phases: ['Plan', 'Plan'], steps: [GATE_STEP] }, 'unique')
expectInvalid('a negative phase (minimum)', table({ ...GATE_STEP, phase: -1 }), 'phase')

// ---- the validator refuses to fail open ----

test('a schema using a keyword the validator does not implement throws rather than passing silently', () => {
  assert.throws(
    () => validate({ type: 'object', patternProperties: { '^x': { type: 'string' } } }, {}),
    /unsupported schema keyword "patternProperties"/,
  )
})

// ---- cross-field rules, enforced by the generator ----
// These call the REAL loadSource(), pointed at a tampered copy of domain/ in a
// temp dir. Re-implementing the checks in the test would only prove the copy
// works.

function tamperedDomain(newSource) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'horizon-domain-')), 'domain')
  cpSync(path.join(REPO_ROOT, 'domain'), dir, { recursive: true })
  writeFileSync(path.join(dir, 'steps.json'), `${JSON.stringify(newSource, null, 2)}\n`)
  return dir
}

test('SANITY: loadSource accepts an untampered copy of domain/, so the temp-dir harness itself works', () => {
  assert.deepEqual(loadSource(tamperedDomain(source)), source)
})

test('loadSource rejects duplicate step labels, naming them', () => {
  const dupLabel = source.steps[0].label
  const broken = { ...source, steps: [source.steps[0], { ...source.steps[3], label: dupLabel }] }
  assert.throws(() => loadSource(tamperedDomain(broken)), (err) => {
    assert.match(err.message, /duplicate step label/)
    assert.ok(err.message.includes(dupLabel), `error does not name the duplicated label: ${err.message}`)
    return true
  })
})

test('loadSource rejects a phase past the end of the phases array', () => {
  const broken = { phases: ['Plan'], steps: [{ ...GATE_STEP, phase: 3 }] }
  assert.throws(() => loadSource(tamperedDomain(broken)), /declares phase 3, but only 1 phase\(s\) exist/)
})

test('loadSource rejects a table that fails the schema, quoting the offending path', () => {
  assert.throws(() => loadSource(tamperedDomain(table({ ...FARM_STEP, timeoutS: 'soon' }))), /steps\[0\]\.timeoutS/)
})

test('the generator CLI refuses to render an invalid table — it exits non-zero instead of writing one', () => {
  const dir = tamperedDomain({ ...source, steps: [{ ...GATE_STEP, kind: 'banana' }] })
  const result = spawnSync(process.execPath, [path.join(dir, 'generate.mjs'), '--write'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0, 'the generator wrote bindings from an invalid table')
  assert.match(result.stderr, /banana/)
})

function omit(obj, key) {
  const { [key]: _dropped, ...rest } = obj
  return rest
}
