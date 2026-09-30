// Persona registry + demo-mode proposer tests, the role/persona axis
// separation checks (HZ-4 architecture notes 2–3), and the process-hardening
// pins: the pre-execution gate is required and the mock digest never implies
// a decision.
//
// HZ-128: the step model comes from domain/js/lifecycle.js (one copy, both
// consumers); the two agentTokens.js maps are the presentation halves the
// server and UI each still own.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-personas-')), 'test.db')
delete process.env.FARM_URL

const { PERSONAS, DEFAULT_PERSONA, isPersona, personaLabel, proposePersona } = await import('../src/personas.js')
const lifecycle = await import('../../domain/js/lifecycle.js')
const serverAgents = await import('../src/agentTokens.js')
const uiPersonas = await import('../../ui/src/domain/personas.js')
const uiAgents = await import('../../ui/src/domain/agentTokens.js')
const uiEventColors = await import('../../ui/src/domain/eventColors.js')
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
  const agentKeys = new Set(Object.keys(uiAgents.AGENTS))
  for (const id of Object.keys(uiPersonas.PERSONAS)) {
    assert.ok(!agentKeys.has(id), `persona id ${id} collides with an AGENTS key`)
  }
})

test('every lifecycle step agent resolves in AGENTS only', () => {
  for (const step of lifecycle.STEPS) {
    if (step.kind !== 'agent') continue
    assert.ok(uiAgents.AGENTS[step.agent], `step "${step.label}" references unknown agent ${step.agent}`)
    assert.ok(!uiPersonas.PERSONAS[step.agent], `step "${step.label}" references a persona, not a role`)
  }
})

test('server and UI persona registries carry the same ids', () => {
  assert.deepEqual(Object.keys(PERSONAS).sort(), Object.keys(uiPersonas.PERSONAS).sort())
})

// ---- process hardening pins ----

// HZ-128 retired the "in both copies" loop this test used to run: there IS
// only one copy now (domain/js/lifecycle.js), so server-vs-UI disagreement is
// no longer a reachable state. The FACT it guarded — that gate is required, at
// that position — is still pinned here, and permanently in
// domain-step-pins.test.mjs.
test('the "Review before execution" gate is required', () => {
  const gate = lifecycle.STEPS[10]
  assert.equal(gate.kind, 'gate')
  assert.equal(gate.label, 'Review before execution')
  assert.equal(gate.gate, 'required')
})

// ---- agent-token parity (HZ-30) ----
// HZ-128 deleted server/src/lifecycle.js and moved the step model to domain/,
// so "the two lifecycle copies agree" is no longer a thing that can fail.
// What survives is narrower and real: server/src/agentTokens.js and
// ui/src/domain/agentTokens.js are still two hand-owned maps of the same
// roles — the ONE documented duplicate left (see domain/README.md), because
// the server persists a literal hex and the UI renders a theme token. The two
// retired checks ("the UI STEPS copy matches a fresh toUiSteps() derivation"
// and the "in both copies" Review-step loop below) guarded copy agreement
// that no longer exists; their facts are pinned in
// domain-step-pins.test.mjs and domain-parity.test.mjs instead.

test('every server AGENTS entry matches its UI counterpart on label and initials (the UI copy only adds Human on top)', () => {
  for (const [key, value] of Object.entries(serverAgents.AGENTS)) {
    const uiEntry = uiAgents.AGENTS[key]
    assert.ok(uiEntry, `AGENTS.${key} missing from the UI copy`)
    assert.equal(uiEntry.label, value.label, `AGENTS.${key}.label drifted between the server and UI copies`)
    assert.equal(uiEntry.initials, value.initials, `AGENTS.${key}.initials drifted between the server and UI copies`)
  }
})

// HZ-25: since dark mode, the UI's AGENTS.color is a theme-aware CSS token
// (e.g. 'var(--primary-ink)'), not the literal hex server events carry — so
// it can no longer be deep-equal'd against the server's AGENTS.color. What
// must still hold: every literal hex color/status.js/orchestrator.js/store.js
// ever persists to a real event's `color` column resolves to a themed token,
// via ui/src/domain/eventColors.js — see Tracker.jsx's buildActivity, which
// is exactly what regressed if this fails (agent color chips rendering the
// stored light-mode hex directly under a dark background).
test('every server AGENTS color has a themed resolution in ui/src/domain/eventColors.js', () => {
  for (const [key, value] of Object.entries(serverAgents.AGENTS)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(uiEventColors.SERVER_EVENT_COLOR_TOKENS, value.color),
      `AGENTS.${key}'s color ${value.color} has no entry in eventColors.js — real activity-feed events for this agent will render unthemed`,
    )
  }
})

test('the automated Review step sits between implement and the accept gate', () => {
  assert.equal(lifecycle.STEPS[lifecycle.IMPLEMENT_STEP_INDEX].label, 'Specialist agent implements')
  assert.equal(lifecycle.STEPS[lifecycle.REVIEW_STEP_INDEX].label, 'Automated review (code + QA)')
  assert.equal(lifecycle.STEPS[lifecycle.ACCEPT_GATE_INDEX].label, 'Accept the code')
  assert.equal(lifecycle.REVIEW_STEP_INDEX, lifecycle.IMPLEMENT_STEP_INDEX + 1)
  assert.equal(lifecycle.ACCEPT_GATE_INDEX, lifecycle.REVIEW_STEP_INDEX + 1)
})

test('the mock review digest contains no approval language (deny-list)', () => {
  const { summary } = MOCK_STEP_BEHAVIOR['Summarize reviews & recommend']()
  assert.ok(!/recommend|proceed|approve/i.test(summary), `digest implies a decision: "${summary}"`)
})

test('mock step 0 proposes a persona once and says so', () => {
  const result = MOCK_STEP_BEHAVIOR['Define the outcome']({ title: 'Fix flaky pytest fixture in the payments API', desc: 'x' })
  assert.equal(result.patch?.persona, 'python_backend')
  assert.match(result.summary, /proposed/)
})

test('mock step 0 never re-proposes over a set persona, and does not claim it did', () => {
  const result = MOCK_STEP_BEHAVIOR['Define the outcome']({ title: 'Fix flaky pytest fixture', desc: 'x', persona: 'frontend_ui' })
  assert.equal(result.patch?.persona, undefined)
  assert.ok(!/proposed/i.test(result.summary), `skip summary still claims a proposal: "${result.summary}"`)
})
