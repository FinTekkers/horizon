// HZ-192: the JS half of farm/tests/test_models_domain.py. domain/personas.json's
// `models` block is read by the JS binding too (the agent definitions page shows
// each step's effective model from it), so its contract with domain/steps.json
// is asserted from this side as well: every lifecycle agent resolves, and every
// step override names a live step — a stale label would make its override
// silently not apply.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { STEPS } from '../../domain/js/lifecycle.js'
import {
  CONCIERGE_MODEL_AGENT,
  CONFLICT_MODEL_AGENT,
  CONFLICT_STEP_KEY,
  MODELS,
  modelAgentForStep,
  resolveModel,
} from '../../domain/js/personas.js'

const agentSteps = STEPS.filter((step) => step.kind === 'agent')

test('every lifecycle agent, the concierge and conflict resolution have a default model', () => {
  assert.ok(agentSteps.length > 0)
  const needed = new Set([...agentSteps.map((step) => modelAgentForStep(step.agent)), CONCIERGE_MODEL_AGENT, CONFLICT_MODEL_AGENT])
  for (const agent of needed) assert.ok(Object.hasOwn(MODELS.agents, agent), `no default model for ${agent}`)
})

test('every step override names a live agent step, or the reserved conflict key', () => {
  const live = new Set([...agentSteps.map((step) => step.label), CONFLICT_STEP_KEY])
  for (const label of Object.keys(MODELS.steps)) assert.ok(live.has(label), `models.steps names no step: ${label}`)
})

test('every agent step resolves to a Claude model id', () => {
  for (const step of agentSteps) {
    assert.match(resolveModel(modelAgentForStep(step.agent), step.label), /^claude-/, step.label)
  }
})
