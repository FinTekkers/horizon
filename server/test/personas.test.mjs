// Persona registry + demo-mode proposer tests, the role/persona axis
// separation checks (HZ-4 architecture notes 2–3), and the process-hardening
// pins: the pre-execution gate is required and the mock digest never implies
// a decision.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-personas-')), 'test.db')
delete process.env.FARM_URL

const { PERSONAS, DEFAULT_PERSONA, isPersona, personaLabel, proposePersona } = await import('../src/personas.js')
const serverLifecycle = await import('../src/lifecycle.js')
const uiPersonas = await import('../../ui/src/domain/personas.js')
const uiLifecycle = await import('../../ui/src/domain/lifecycle.js')
const { MOCK_STEP_BEHAVIOR } = await import('../src/orchestrator.js')

// ---- registry ----

test('isPersona accepts registry ids and rejects everything else', () => {
  for (const id of Object.keys(PERSONAS)) assert.ok(isPersona(id))
  assert.ok(!isPersona('rustacean'))
  assert.ok(!isPersona(''))
  assert.ok(!isPersona(null))
  assert.ok(isPersona(DEFAULT_PERSONA))
})

test('personaLabel translates ids and falls back to the default label', () => {
  assert.equal(personaLabel('python_backend'), 'Python backend')
  assert.equal(personaLabel('nope'), PERSONAS[DEFAULT_PERSONA].label)
})

// ---- demo-mode proposer (the ONLY keyword heuristic) ----

test('a Python-flavored item proposes python_backend', () => {
  assert.equal(proposePersona({ title: 'Fix flaky pytest fixture in the payments API', desc: '' }), 'python_backend')
})

test('a UI-flavored item proposes frontend_ui', () => {
  assert.equal(proposePersona({ title: 'Restyle the dashboard card component (React)', desc: '' }), 'frontend_ui')
})

test('cross-stack wording falls back to fullstack, deterministically', () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(proposePersona({ title: 'add a chart to the dashboard API', desc: '' }), 'fullstack')
  }
})

test('no signal falls back to fullstack and never throws', () => {
  assert.equal(proposePersona({ title: '', desc: '' }), 'fullstack')
  assert.equal(proposePersona({ title: 'Fix' }), 'fullstack')
  assert.equal(proposePersona({}), 'fullstack')
  assert.equal(proposePersona(null), 'fullstack')
  assert.equal(proposePersona(undefined), 'fullstack')
})

// ---- axis separation (architecture note 2) ----
// Personas are a sibling of AGENTS, never merged into it: lifecycle roles and
// stack personas are different axes.

test('UI persona ids are disjoint from lifecycle AGENTS keys', () => {
  const agentKeys = new Set(Object.keys(uiLifecycle.AGENTS))
  for (const id of Object.keys(uiPersonas.PERSONAS)) {
    assert.ok(!agentKeys.has(id), `persona id ${id} collides with an AGENTS key`)
  }
})

test('every lifecycle step agent resolves in AGENTS only', () => {
  for (const step of uiLifecycle.STEPS) {
    if (step.kind !== 'agent') continue
    assert.ok(uiLifecycle.AGENTS[step.agent], `step "${step.label}" references unknown agent ${step.agent}`)
    assert.ok(!uiPersonas.PERSONAS[step.agent], `step "${step.label}" references a persona, not a role`)
  }
})

test('server and UI persona registries carry the same ids', () => {
  assert.deepEqual(Object.keys(PERSONAS).sort(), Object.keys(uiPersonas.PERSONAS).sort())
})

// ---- process hardening pins ----

test('the "Review before execution" gate is required in both lifecycle copies', () => {
  for (const steps of [serverLifecycle.STEPS, uiLifecycle.STEPS]) {
    const gate = steps[10]
    assert.equal(gate.kind, 'gate')
    assert.equal(gate.label, 'Review before execution')
    assert.equal(gate.gate, 'required')
  }
})

test('the mock review digest contains no approval language (deny-list)', () => {
  const { summary } = MOCK_STEP_BEHAVIOR[9]()
  assert.ok(!/recommend|proceed|approve/i.test(summary), `digest implies a decision: "${summary}"`)
})

test('mock step 0 proposes a persona once and says so', () => {
  const result = MOCK_STEP_BEHAVIOR[0]({ title: 'Fix flaky pytest fixture in the payments API', desc: 'x' })
  assert.equal(result.patch?.persona, 'python_backend')
  assert.match(result.summary, /proposed/)
})

test('mock step 0 never re-proposes over a set persona, and does not claim it did', () => {
  const result = MOCK_STEP_BEHAVIOR[0]({ title: 'Fix flaky pytest fixture', desc: 'x', persona: 'frontend_ui' })
  assert.equal(result.patch?.persona, undefined)
  assert.ok(!/proposed/i.test(result.summary), `skip summary still claims a proposal: "${result.summary}"`)
})
