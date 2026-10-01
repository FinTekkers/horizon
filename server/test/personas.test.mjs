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

const {
  PERSONAS,
  DEFAULT_PERSONAS,
  LEGACY_PERSONA_IDS,
  PRIMARY_PERSONA_AGENT,
  isPersona,
  isPersonaAgent,
  legacyPersona,
  personaLabel,
  personasFromRow,
  proposePersona,
} = await import('../src/personas.js')
const lifecycle = await import('../../domain/js/lifecycle.js')
const serverAgents = await import('../src/agentTokens.js')
const uiPersonas = await import('../../ui/src/domain/personas.js')
const uiAgents = await import('../../ui/src/domain/agentTokens.js')
const uiEventColors = await import('../../ui/src/domain/eventColors.js')
const { MOCK_STEP_BEHAVIOR } = await import('../src/orchestrator.js')

// ---- registry (agent-scoped since HZ-125) ----

const ALL_PERSONAS = Object.entries(PERSONAS).flatMap(([agent, bucket]) =>
  Object.keys(bucket).map((id) => [agent, id]),
)

test('isPersona accepts ids from the named agent and rejects everything else', () => {
  for (const [agent, id] of ALL_PERSONAS) assert.ok(isPersona(agent, id), `${agent}/${id}`)
  for (const [agent, def] of Object.entries(DEFAULT_PERSONAS)) assert.ok(isPersona(agent, def))
  assert.ok(!isPersona('eng', 'rustacean'))
  assert.ok(!isPersona('eng', ''))
  assert.ok(!isPersona('eng', null))
  // A real id from another agent's bucket is not a persona for this agent.
  assert.ok(!isPersona('eng', 'api_contract'))
  assert.ok(!isPersona('qa', 'python'))
  // DevOps has no personas, by design (HZ-125 guardrail 1).
  assert.ok(!isPersona('devops', 'python'))
  assert.ok(!isPersona(null, 'python'))
})

test('every persona id belongs to exactly one agent', () => {
  const seen = new Map()
  for (const [agent, id] of ALL_PERSONAS) {
    assert.ok(!seen.has(id), `persona ${id} is registered under both ${seen.get(id)} and ${agent}`)
    seen.set(id, agent)
  }
})

test('every agent has at least two personas and a default in its own bucket', () => {
  for (const agent of ['eng', 'qa', 'architect', 'pm']) {
    assert.ok(PERSONAS[agent], `no persona bucket for ${agent}`)
    assert.ok(Object.keys(PERSONAS[agent]).length >= 2, `${agent} has fewer than two personas`)
    assert.ok(PERSONAS[agent][DEFAULT_PERSONAS[agent]], `${agent}'s default is not one of its personas`)
  }
  assert.deepEqual(Object.keys(DEFAULT_PERSONAS).sort(), Object.keys(PERSONAS).sort())
})

test('personaLabel translates ids and falls back to the agent default label', () => {
  assert.equal(personaLabel('eng', 'python'), 'Python backend')
  assert.equal(personaLabel('qa', 'data_integrity'), 'Data integrity')
  assert.equal(personaLabel('eng', 'nope'), PERSONAS.eng[DEFAULT_PERSONAS.eng].label)
  assert.equal(personaLabel('qa', 'nope'), PERSONAS.qa[DEFAULT_PERSONAS.qa].label)
})

test('personaLabel on an agent that has no personas degrades to a string instead of throwing', () => {
  // DevOps composes no persona by design (HZ-22), so it has no bucket and no
  // default to fall back to. This is the one branch that can put a raw id in an
  // event or GitHub comment — it is deliberately a last resort, not a lookup
  // path any caller should reach, but it must never throw mid-comment or
  // render "undefined" into the activity trail.
  assert.equal(personaLabel('devops', 'python'), 'python')
  assert.equal(personaLabel(null, 'python'), 'python')
  assert.equal(personaLabel(undefined, 'python'), 'python')
  assert.equal(personaLabel('devops', null), '')
  assert.equal(personaLabel('devops', undefined), '')
  assert.equal(personaLabel(null, null), '')
  // Every real caller goes through isPersona first, so the branch above is
  // unreachable for a registered agent — pinned so a future refactor can't
  // quietly widen it into the normal path.
  for (const agent of Object.keys(PERSONAS)) {
    assert.notEqual(personaLabel(agent, 'not_a_persona_id'), 'not_a_persona_id')
  }
})

// ---- row -> personas map, including pre-HZ-125 rows ----

test('personasFromRow reads personas_json and drops ids that are no longer registered', () => {
  assert.deepEqual(personasFromRow({ personas_json: JSON.stringify({ eng: 'ui', qa: 'e2e_journey' }) }), {
    eng: 'ui',
    qa: 'e2e_journey',
  })
  assert.deepEqual(personasFromRow({ personas_json: JSON.stringify({ eng: 'gone', qa: 'e2e_journey' }) }), {
    qa: 'e2e_journey',
  })
  assert.deepEqual(personasFromRow({ personas_json: JSON.stringify({ devops: 'python' }) }), {})
})

test('personasFromRow translates a legacy flat persona value and never throws on junk', () => {
  assert.deepEqual(personasFromRow({ persona: 'python_backend' }), { eng: 'python' })
  assert.deepEqual(personasFromRow({ persona: 'frontend_ui' }), { eng: 'ui' })
  assert.deepEqual(personasFromRow({ persona: 'fullstack' }), { eng: 'fullstack' })
  // An unreadable blob falls back to the legacy column rather than failing.
  assert.deepEqual(personasFromRow({ persona: 'python_backend', personas_json: '{oops' }), { eng: 'python' })
  assert.deepEqual(personasFromRow({ personas_json: '[]' }), {})
  assert.deepEqual(personasFromRow({}), {})
  assert.deepEqual(personasFromRow(null), {})
})

// The three registry tables are plain object literals, so a name that happens
// to be an Object.prototype member resolves truthy under a bare `TABLE[name]`
// lookup and reads as registered. The farm mirror (`candidate in bucket`,
// dict.get) has never had that hole; every JS lookup must match it, or the
// composed prompt diverges from what the agent actually receives — and
// composeRole, which reaches for `.file`, throws outright.
const PROTOTYPE_KEYS = ['constructor', '__proto__', 'hasOwnProperty', 'valueOf']

test('prototype-member names are not personas, agents or legacy aliases', () => {
  for (const key of PROTOTYPE_KEYS) {
    assert.ok(!isPersona('eng', key), `eng/${key} must not read as registered`)
    assert.ok(!isPersona(key, 'fullstack'), `${key} must not read as an agent`)
    assert.ok(!isPersonaAgent(key), `${key} must not read as an agent`)
    assert.equal(legacyPersona(key), null, `${key} must not read as a legacy alias`)
    // Falls back to the agent default rather than returning undefined.
    assert.equal(personaLabel('eng', key), PERSONAS.eng[DEFAULT_PERSONAS.eng].label)
    assert.deepEqual(personasFromRow({ personas_json: JSON.stringify({ eng: key }) }), {})
    assert.deepEqual(personasFromRow({ persona: key }), {})
    assert.equal(proposePersona({ title: 'x' }, key), null, `${key} must not propose a persona`)
  }
})

test('every legacy alias points at a live persona', () => {
  for (const [legacy, [agent, id]] of Object.entries(LEGACY_PERSONA_IDS)) {
    assert.ok(isPersona(agent, id), `legacy alias ${legacy} points at missing ${agent}/${id}`)
  }
})

// ---- demo-mode proposer (the ONLY keyword heuristic) ----

test('a Python-flavored item proposes the eng/python persona', () => {
  assert.equal(proposePersona({ title: 'Fix flaky pytest fixture in the payments API', desc: '' }), 'python')
  // Metric 8: asked about the Eng agent, it can only ever answer with an Eng
  // persona — never a PM (or any other agent's) one.
  const proposed = proposePersona({ title: 'Fix flaky pytest fixture in the payments API', desc: '' }, 'eng')
  assert.ok(isPersona('eng', proposed))
  assert.ok(!isPersona('pm', proposed))
})

test('a UI-flavored item proposes the eng/ui persona', () => {
  assert.equal(proposePersona({ title: 'Restyle the dashboard card component (React)', desc: '' }), 'ui')
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

test('proposePersona always answers with a persona belonging to the agent it was asked about', () => {
  for (const agent of Object.keys(PERSONAS)) {
    const proposed = proposePersona({ title: 'Fix flaky pytest fixture in the payments API', desc: 'React chart' }, agent)
    assert.ok(isPersona(agent, proposed), `${agent} got ${proposed}, which is not one of its personas`)
  }
  // An agent with no personas has nothing to propose, and must not guess.
  assert.equal(proposePersona({ title: 'anything' }, 'devops'), null)
})

test('the primary persona agent is a real bucket', () => {
  assert.ok(PERSONAS[PRIMARY_PERSONA_AGENT])
})

// ---- axis separation (architecture note 2) ----
// Personas are a sibling of AGENTS, never merged into it: lifecycle roles and
// stack personas are different axes.

const uiPersonaIds = () =>
  Object.values(uiPersonas.PERSONAS).flatMap((bucket) => Object.keys(bucket))

test('UI persona ids are disjoint from lifecycle AGENTS keys', () => {
  const agentKeys = new Set(Object.keys(uiAgents.AGENTS))
  for (const id of uiPersonaIds()) {
    assert.ok(!agentKeys.has(id), `persona id ${id} collides with an AGENTS key`)
  }
})

test('every lifecycle step agent resolves in AGENTS only', () => {
  const personaIds = new Set(uiPersonaIds())
  for (const step of lifecycle.STEPS) {
    if (step.kind !== 'agent') continue
    assert.ok(uiAgents.AGENTS[step.agent], `step "${step.label}" references unknown agent ${step.agent}`)
    assert.ok(!personaIds.has(step.agent), `step "${step.label}" references a persona, not a role`)
  }
})

test('server and UI persona registries carry the same agents and ids', () => {
  assert.deepEqual(Object.keys(PERSONAS).sort(), Object.keys(uiPersonas.PERSONAS).sort())
  for (const agent of Object.keys(PERSONAS)) {
    assert.deepEqual(
      Object.keys(PERSONAS[agent]).sort(),
      Object.keys(uiPersonas.PERSONAS[agent]).sort(),
      `persona ids drifted for ${agent}`,
    )
  }
  assert.deepEqual(uiPersonas.DEFAULT_PERSONAS, DEFAULT_PERSONAS)
  assert.equal(uiPersonas.PRIMARY_PERSONA_AGENT, PRIMARY_PERSONA_AGENT)
})

// HZ-125: the UI groups the picker by agent, so each bucket needs the lifecycle
// agent that composes it — and that bridge must land on a real AGENTS entry
// rather than a second hand-typed label.
test('every persona agent maps onto a real lifecycle AGENTS entry', () => {
  assert.deepEqual(Object.keys(uiPersonas.PERSONA_AGENT_ROLES).sort(), Object.keys(PERSONAS).sort())
  for (const [agent, role] of Object.entries(uiPersonas.PERSONA_AGENT_ROLES)) {
    assert.ok(uiAgents.AGENTS[role], `persona agent ${agent} maps to unknown lifecycle agent ${role}`)
  }
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

test('mock step 0 proposes an eng persona once and says so', () => {
  const result = MOCK_STEP_BEHAVIOR['Define the outcome']({ title: 'Fix flaky pytest fixture in the payments API', desc: 'x' })
  assert.deepEqual(result.patch?.personas, { eng: 'python' })
  assert.match(result.summary, /proposed/)
})

test('mock step 0 never re-proposes over a set eng persona, and does not claim it did', () => {
  const result = MOCK_STEP_BEHAVIOR['Define the outcome']({
    title: 'Fix flaky pytest fixture',
    desc: 'x',
    personas: { eng: 'ui' },
  })
  assert.equal(result.patch?.personas, undefined)
  assert.ok(!/proposed/i.test(result.summary), `skip summary still claims a proposal: "${result.summary}"`)
})

test('mock step 0 still proposes an eng persona for an item that only carries a qa one', () => {
  const result = MOCK_STEP_BEHAVIOR['Define the outcome']({
    title: 'Fix flaky pytest fixture',
    desc: 'x',
    personas: { qa: 'data_integrity' },
  })
  assert.deepEqual(result.patch?.personas, { eng: 'python' })
})
