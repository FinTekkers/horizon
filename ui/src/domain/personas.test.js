// The UI's persona registry became agent-scoped in HZ-125, and every read of it
// now needs the agent alongside the id. These cover the resolution/fallback
// rules the picker and the board card depend on; the rendered control itself
// (one select per agent, testOnly never offered) is covered in
// components/Tracker.test.jsx.

import { expect, test } from 'vitest'
import {
  DEFAULT_PERSONAS,
  PERSONAS,
  PERSONA_AGENT_ROLES,
  PRIMARY_PERSONA_AGENT,
  personaFor,
  personaId,
  personaSlotForFile,
} from './personas'
import { AGENTS } from './agentTokens'

test('every agent has at least two personas and a default inside its own bucket', () => {
  for (const agent of ['eng', 'qa', 'architect', 'pm']) {
    expect(Object.keys(PERSONAS[agent]).length).toBeGreaterThanOrEqual(2)
    expect(PERSONAS[agent][DEFAULT_PERSONAS[agent]]).toBeTruthy()
  }
  expect(Object.keys(DEFAULT_PERSONAS).sort()).toEqual(Object.keys(PERSONAS).sort())
})

test('no persona id appears under two agents', () => {
  const seen = new Map()
  for (const [agent, bucket] of Object.entries(PERSONAS)) {
    for (const id of Object.keys(bucket)) {
      expect(seen.has(id), `${id} is under both ${seen.get(id)} and ${agent}`).toBe(false)
      seen.set(id, agent)
    }
  }
})

test('there are no devops personas', () => {
  expect(PERSONAS.devops).toBeUndefined()
})

test('personaId reads the slot for the agent asked about', () => {
  const item = { personas: { eng: 'python', qa: 'data_integrity' } }
  expect(personaId(item, 'eng')).toBe('python')
  expect(personaId(item, 'qa')).toBe('data_integrity')
})

test('personaId falls back to the agent default for a missing, unknown or wrong-bucket value', () => {
  expect(personaId({ personas: {} }, 'eng')).toBe(DEFAULT_PERSONAS.eng)
  expect(personaId({}, 'qa')).toBe(DEFAULT_PERSONAS.qa)
  expect(personaId(null, 'architect')).toBe(DEFAULT_PERSONAS.architect)
  expect(personaId({ personas: { pm: 'retired_id' } }, 'pm')).toBe(DEFAULT_PERSONAS.pm)
  // A real id, but from another agent's bucket — never shown as this agent's.
  expect(personaId({ personas: { qa: 'python' } }, 'qa')).toBe(DEFAULT_PERSONAS.qa)
})

test('personaFor always returns a renderable entry for a known agent', () => {
  for (const agent of Object.keys(PERSONAS)) {
    const entry = personaFor({ personas: {} }, agent)
    expect(entry.label).toBeTruthy()
    expect(entry.color).toBeTruthy()
  }
})

test('the primary persona agent is a real bucket', () => {
  expect(PERSONAS[PRIMARY_PERSONA_AGENT]).toBeTruthy()
})

test('every persona agent maps onto a real lifecycle agent', () => {
  expect(Object.keys(PERSONA_AGENT_ROLES).sort()).toEqual(Object.keys(PERSONAS).sort())
  for (const role of Object.values(PERSONA_AGENT_ROLES)) {
    expect(AGENTS[role]).toBeTruthy()
  }
})

test('personaSlotForFile maps an agent-prefixed file name back to its slot', () => {
  expect(personaSlotForFile('eng_python')).toEqual({ agent: 'eng', persona: 'python' })
  // A multi-word id is why this is registry-driven rather than a split on '_'.
  expect(personaSlotForFile('qa_api_contract')).toEqual({ agent: 'qa', persona: 'api_contract' })
  expect(personaSlotForFile('architect_distributed_systems')).toEqual({
    agent: 'architect',
    persona: 'distributed_systems',
  })
  expect(personaSlotForFile('pm_feature_development')).toEqual({ agent: 'pm', persona: 'feature_development' })
})

test('personaSlotForFile returns null for a file with no registry entry', () => {
  expect(personaSlotForFile('eng_not_a_persona')).toBeNull()
  expect(personaSlotForFile('python')).toBeNull()
  expect(personaSlotForFile('')).toBeNull()
})

test('every registered persona has a file name that round-trips through personaSlotForFile', () => {
  for (const [agent, bucket] of Object.entries(PERSONAS)) {
    for (const persona of Object.keys(bucket)) {
      expect(personaSlotForFile(`${agent}_${persona}`)).toEqual({ agent, persona })
    }
  }
})
