// HZ-133's cross-language fixture, the JS half. farm/tests/test_personas_fixtures.py
// is the Python half, and the two run the SAME `shared` section off the SAME
// domain/fixtures/personas-cases.json.
//
// Why it exists: the two persona bindings are independent hand-written
// implementations, and domain-personas-parity.test.mjs only compares their DATA
// output. Without this file the Python validator's rejection rules would carry
// zero coverage, and the two validators' messages could drift apart silently.
//
// Same three vacuity guards as domain-priorities-cases.test.mjs: SET EQUALITY
// between fixture keys and exports, NON-EMPTY sections, and a PINNED MANIFEST
// of the shared ids this suite must have executed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import * as binding from '../../domain/js/personas.js'
import { REPO_ROOT } from './helpers/repoFiles.mjs'

const cases = JSON.parse(readFileSync(path.join(REPO_ROOT, 'domain/fixtures/personas-cases.json'), 'utf8'))
const { shared, js } = cases

// Ids this run actually executed, checked against shared.manifest at the end.
const executed = { validation: [], membership: [], roleFile: [], resolveModel: [] }

// ---- coverage guard ----

test('every JS export has at least one fixture case, and every fixture key is a real export', () => {
  const exported = Object.keys(binding).filter((k) => k !== 'default').sort()
  const covered = Object.keys(js)
    .filter((k) => !k.startsWith('$'))
    .sort()
  assert.ok(exported.length > 0, 'the binding exports nothing — this guard would pass vacuously')
  assert.deepEqual(covered, exported, 'domain/fixtures/personas-cases.json\'s "js" keys must equal domain/js/personas.js\'s exports exactly')
})

test('no fixture section is empty — an empty case list would satisfy the coverage guard vacuously', () => {
  for (const [name, list] of Object.entries(js)) {
    if (name.startsWith('$')) continue
    assert.ok(Array.isArray(list) && list.length > 0, `js.${name} has no cases`)
  }
  for (const section of Object.keys(executed)) {
    assert.ok(shared[section].length > 0, `shared.${section} has no cases`)
  }
})

// ---- shared: validation (assertPersonasShape vs Python's _validate_source) ----

for (const c of shared.validation) {
  test(`shared/validation: ${c.case}`, () => {
    executed.validation.push(c.case)
    if (c.expect.throws) {
      assert.throws(
        () => binding.assertPersonasShape(c.input, 'domain/personas.json', shared.declaredModels),
        (err) => {
          assert.ok(
            err.message.includes(c.expect.messageContains),
            `expected a message containing "${c.expect.messageContains}", got: ${err.message}`,
          )
          return true
        },
      )
    } else {
      assert.equal(binding.assertPersonasShape(c.input, 'domain/personas.json', shared.declaredModels), c.input)
    }
  })
}

// ---- shared: membership (isPersona vs Python's is_persona) ----

for (const c of shared.membership) {
  test(`shared/membership: ${c.case}`, () => {
    executed.membership.push(c.case)
    assert.equal(binding.isPersona(c.agent, c.id, c.personaIds), c.expect)
  })
}

// ---- shared: roleFile (personaRoleFile vs Python's persona_role_file) ----

for (const c of shared.roleFile) {
  test(`shared/roleFile: ${c.case}`, () => {
    executed.roleFile.push(c.case)
    if (c.expect.throws) {
      assert.throws(
        () => binding.personaRoleFile(c.agent, c.id, c.roleFiles),
        (err) => {
          assert.ok(err.message.includes(c.expect.throws), `expected "${c.expect.throws}", got: ${err.message}`)
          return true
        },
      )
    } else {
      assert.equal(binding.personaRoleFile(c.agent, c.id, c.roleFiles), c.expect.file)
    }
  })
}

// ---- shared: resolveModel (resolveModel vs Python's resolve_model) — HZ-192 ----

for (const c of shared.resolveModel) {
  test(`shared/resolveModel: ${c.case}`, () => {
    executed.resolveModel.push(c.case)
    if (c.expect.throws) {
      assert.throws(
        () => binding.resolveModel(c.agent, c.step, c.persona, c.models),
        (err) => {
          assert.ok(err.message.includes(c.expect.throws), `expected "${c.expect.throws}", got: ${err.message}`)
          return true
        },
      )
    } else {
      assert.equal(binding.resolveModel(c.agent, c.step, c.persona, c.models), c.expect.model)
    }
  })
}

// ---- js-only exports ----

test('js/isPersonaAgent: registry membership, never a prototype key', () => {
  for (const c of js.isPersonaAgent) assert.equal(binding.isPersonaAgent(c.agent, c.personaIds), c.expect, c.case)
})

test('js/legacyPersona: a declared alias resolves, anything else is null', () => {
  for (const c of js.legacyPersona) assert.deepEqual(binding.legacyPersona(c.id, c.legacyIds), c.expect, c.case)
})

test('js/PERSONA_AGENTS: the live agent list is a non-empty frozen array', () => {
  assert.equal(js.PERSONA_AGENTS.length, 1)
  assert.ok(binding.PERSONA_AGENTS.length > 0)
  assert.ok(Object.isFrozen(binding.PERSONA_AGENTS))
})

test('js/PERSONA_IDS: every live agent has a non-empty frozen id list', () => {
  assert.equal(js.PERSONA_IDS.length, 1)
  assert.deepEqual(Object.keys(binding.PERSONA_IDS), [...binding.PERSONA_AGENTS])
  assert.ok(Object.isFrozen(binding.PERSONA_IDS))
  for (const agent of binding.PERSONA_AGENTS) {
    assert.ok(binding.PERSONA_IDS[agent].length > 0, agent)
    assert.ok(Object.isFrozen(binding.PERSONA_IDS[agent]), agent)
  }
})

test('js/PERSONA_ROLE_FILES: every live persona has a declared role file, frozen', () => {
  assert.equal(js.PERSONA_ROLE_FILES.length, 1)
  assert.deepEqual(Object.keys(binding.PERSONA_ROLE_FILES), [...binding.PERSONA_AGENTS])
  assert.ok(Object.isFrozen(binding.PERSONA_ROLE_FILES))
  for (const agent of binding.PERSONA_AGENTS) {
    assert.deepEqual(Object.keys(binding.PERSONA_ROLE_FILES[agent]).sort(), [...binding.PERSONA_IDS[agent]].sort(), agent)
    assert.ok(Object.isFrozen(binding.PERSONA_ROLE_FILES[agent]), agent)
    for (const file of Object.values(binding.PERSONA_ROLE_FILES[agent])) {
      assert.equal(typeof file, 'string')
      assert.ok(file.endsWith('.md'), file)
    }
  }
})

test('js/NAMESPACED_PERSONA_IDS: every <agent>.<persona>, agents in order, personas in order', () => {
  assert.equal(js.NAMESPACED_PERSONA_IDS.length, 1)
  assert.deepEqual(
    [...binding.NAMESPACED_PERSONA_IDS],
    binding.PERSONA_AGENTS.flatMap((agent) => binding.PERSONA_IDS[agent].map((id) => `${agent}.${id}`)),
  )
  assert.ok(Object.isFrozen(binding.NAMESPACED_PERSONA_IDS))
})

test("js/DEFAULT_PERSONAS: every live agent's default is one of its own personas", () => {
  assert.equal(js.DEFAULT_PERSONAS.length, 1)
  assert.deepEqual(Object.keys(binding.DEFAULT_PERSONAS), [...binding.PERSONA_AGENTS])
  for (const agent of binding.PERSONA_AGENTS) assert.ok(binding.isPersona(agent, binding.DEFAULT_PERSONAS[agent]), agent)
  assert.ok(Object.isFrozen(binding.DEFAULT_PERSONAS))
})

test('js/PRIMARY_PERSONA_AGENT: the live primary agent is a declared agent', () => {
  assert.equal(js.PRIMARY_PERSONA_AGENT.length, 1)
  assert.ok(binding.isPersonaAgent(binding.PRIMARY_PERSONA_AGENT))
})

test('js/LEGACY_PERSONA_IDS: every live legacy alias names a declared pair', () => {
  assert.equal(js.LEGACY_PERSONA_IDS.length, 1)
  assert.ok(Object.keys(binding.LEGACY_PERSONA_IDS).length > 0)
  for (const [alias, pair] of Object.entries(binding.LEGACY_PERSONA_IDS)) {
    assert.equal(pair.length, 2, alias)
    assert.ok(binding.isPersona(pair[0], pair[1]), alias)
    assert.ok(Object.isFrozen(pair), alias)
  }
  assert.ok(Object.isFrozen(binding.LEGACY_PERSONA_IDS))
})

test('js/MODELS: the live block carries agents, steps and personas, frozen', () => {
  assert.equal(js.MODELS.length, 1)
  assert.deepEqual(Object.keys(binding.MODELS), ['agents', 'steps', 'personas'])
  assert.ok(Object.keys(binding.MODELS.agents).length > 0)
  assert.ok(Object.isFrozen(binding.MODELS))
  for (const map of Object.values(binding.MODELS)) assert.ok(Object.isFrozen(map))
})

test("js/CONCIERGE_MODEL_AGENT and CONFLICT_MODEL_AGENT: each has a default model", () => {
  assert.equal(js.CONCIERGE_MODEL_AGENT.length, 1)
  assert.equal(js.CONFLICT_MODEL_AGENT.length, 1)
  assert.ok(Object.hasOwn(binding.MODELS.agents, binding.CONCIERGE_MODEL_AGENT))
  assert.ok(Object.hasOwn(binding.MODELS.agents, binding.CONFLICT_MODEL_AGENT))
})

test('js/CONFLICT_STEP_KEY: the reserved conflict step key is not a steps.json label', async () => {
  assert.equal(js.CONFLICT_STEP_KEY.length, 1)
  const { STEPS } = await import('../../domain/js/lifecycle.js')
  assert.ok(!STEPS.some((step) => step.label === binding.CONFLICT_STEP_KEY))
})

test('js/modelAgentForStep: a steps.json agent display name lower-cases', () => {
  for (const c of js.modelAgentForStep) assert.equal(binding.modelAgentForStep(c.stepAgent), c.expect, c.case)
})

test('the frozen exports reject a runtime write in strict mode', () => {
  assert.throws(() => {
    binding.PERSONA_IDS.eng = []
  }, TypeError)
  assert.throws(() => {
    binding.DEFAULT_PERSONAS.eng = 'nope'
  }, TypeError)
  assert.throws(() => {
    binding.MODELS.agents.eng = 'claude-other'
  }, TypeError)
})

test('js/assertPersonasShape, isPersona, personaRoleFile and resolveModel: covered by the shared sections above', () => {
  assert.equal(js.assertPersonasShape[0].drivenBy, 'shared.validation')
  assert.equal(js.isPersona[0].drivenBy, 'shared.membership')
  assert.equal(js.personaRoleFile[0].drivenBy, 'shared.roleFile')
  assert.equal(js.resolveModel[0].drivenBy, 'shared.resolveModel')
})

// ---- the manifest: this suite really ran every shared case ----

test('MANIFEST: the JS suite executed exactly the shared cases the fixture pins', () => {
  assert.deepEqual(Object.keys(shared.manifest).sort(), Object.keys(executed).sort())
  for (const [section, ids] of Object.entries(shared.manifest)) {
    assert.deepEqual(
      [...executed[section]].sort(),
      [...ids].sort(),
      `the JS suite did not run shared.${section} as pinned — the cross-language guarantee is only as good as this list`,
    )
  }
})
