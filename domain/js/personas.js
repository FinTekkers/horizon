// The one JS view of "which specialist personas exist, which agent each belongs
// to, and what an agent's default is" (HZ-133). Before HZ-133 the id set was
// hand-typed three times — farm/personas.py, server/src/personas.js and
// ui/src/domain/personas.js — held together only by a farm-side test that
// parsed the two JS copies with a regex.
//
// HZ-133 lands in parts. This binding arrives first and additively: the layer
// registries still hold their copies until they are repointed here, and
// server/test/domain-personas-parity.test.mjs asserts this document equals both
// JS registries value-for-value in the meantime, so the repoint cannot change
// behaviour.
//
// Same pattern as domain/js/priorities.js (HZ-139): hand-written source that
// reads its DATA from domain/personas.json with a STATIC import attribute — a
// build-time import, not a runtime fetch — so the UI keeps working with no
// server and no network.
//
// ORDER IS PART OF THE DECLARATION. Agent order is the picker's group order;
// persona order within an agent is its option order. Persona ids are unique
// WITHIN their agent, not globally (HZ-125).
//
// There is no `file` field: the role markdown's filename is DERIVED as
// `<agent>_<persona>.md` by personaRoleFile(). There is no PERSONA_PROVIDERS
// export either: persona-to-provider is a farm routing concern with no JS
// consumer, so only domain/py/personas.py exposes it. assertPersonasShape still
// validates the map, so the document cannot carry a broken entry either way.
//
// HZ-192: the same document declares which Claude model each agent call uses
// (the `models` block). resolveModel() mirrors domain/py/personas.py's
// resolve_model — persona override, then step override, then agent default —
// and its JS consumer is the agent definitions page, which shows each step's
// effective model. Every declared model id must look like a Claude id.
//
// Nothing presentational lives here. Labels, initials, colours and
// PERSONA_AGENT_ROLES stay in server/src/personas.js and ui/src/domain/personas.js;
// domain-binding-hygiene.test.mjs asserts no such name is exported.
//
// Every export is frozen. A layer module that needs a mutable registry —
// ui/src/components/Tracker.test.jsx adds a fixture persona to the UI's — builds
// its own from these, never aliases them.

import data from '../personas.json' with { type: 'json' }

// Load-time validation: the rules a Draft-07 subset cannot express live here,
// so a broken domain/personas.json fails at import rather than reaching a
// caller. Full schema validation stays in domain/validate.mjs, driven by
// server/test/domain-personas-schema.test.mjs.
//
// ID_SHAPE is LOAD-BEARING, not cosmetic: personaRoleFile() interpolates both
// halves of a pair into a path under farm/roles/personas/, and an id carrying a
// slash or `..` would escape that directory. It also keeps every id clear of
// Object.prototype names like `__proto__`.
//
// The rules and message fragments are kept word-for-word in step with
// domain/py/personas.py's _validate_source — domain/fixtures/personas-cases.json
// drives both. `?? null` wherever an absent value is printed, so it reads `null`
// like Python's json.dumps(None) rather than the bare word `undefined`.
const ID_SHAPE = /^[a-z][a-z0-9_]*$/
// HZ-192, kept in step with domain/py/personas.py's _MODEL_SHAPE.
const MODEL_SHAPE = /^claude-[a-z0-9][a-z0-9.-]*$/
const MODELS_KEYS = ['agents', 'conflictAgent', 'steps', 'personas']

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isId = (value) => typeof value === 'string' && ID_SHAPE.test(value)
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const isModel = (value) => typeof value === 'string' && MODEL_SHAPE.test(value)

// [agent, persona] when `value` is `<agent>.<persona>` naming a live pair in
// `ids` (a Map, so no prototype key can resolve), else null.
function splitPair(value, ids) {
  if (typeof value !== 'string') return null
  const parts = value.split('.')
  if (parts.length !== 2) return null
  const [agent, persona] = parts
  if (!ids.has(agent) || !ids.get(agent).includes(persona)) return null
  return [agent, persona]
}

export function assertPersonasShape(data, source = 'domain/personas.json') {
  if (!isObject(data)) {
    throw new Error(`${source} must be a JSON object with a non-empty agents array`)
  }
  const { agents } = data
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error(`${source}: agents must be a non-empty JSON array`)
  }

  const ids = new Map()
  for (const [i, entry] of agents.entries()) {
    if (!isObject(entry)) throw new Error(`${source}: agents[${i}] must be a JSON object`)
    const { agent, personas } = entry
    if (!isId(agent)) {
      throw new Error(
        `${source}: agents[${i}].agent declares ${JSON.stringify(agent ?? null)} — expected a lower-case id matching ${ID_SHAPE}`,
      )
    }
    if (ids.has(agent)) throw new Error(`${source}: agent ${JSON.stringify(agent)} is declared more than once`)
    if (!Array.isArray(personas) || personas.length === 0) {
      throw new Error(`${source}: agents[${i}].personas must be a non-empty JSON array of persona ids`)
    }
    for (const [j, persona] of personas.entries()) {
      if (!isId(persona)) {
        throw new Error(
          `${source}: agents[${i}].personas[${j}] declares ${JSON.stringify(persona ?? null)} — expected a lower-case id matching ${ID_SHAPE}`,
        )
      }
      if (personas.indexOf(persona) !== j) {
        throw new Error(
          `${source}: agent ${JSON.stringify(agent)} declares persona ${JSON.stringify(persona)} more than once`,
        )
      }
    }
    if (typeof entry.default !== 'string' || !personas.includes(entry.default)) {
      throw new Error(
        `${source}: agents[${i}].default ${JSON.stringify(entry.default ?? null)} is not one of agent ${JSON.stringify(agent)}'s personas ${JSON.stringify(personas)}`,
      )
    }
    ids.set(agent, personas)
  }

  if (typeof data.primaryAgent !== 'string' || !ids.has(data.primaryAgent)) {
    throw new Error(
      `${source}: primaryAgent ${JSON.stringify(data.primaryAgent ?? null)} is not a declared agent ${JSON.stringify([...ids.keys()])}`,
    )
  }

  if (!isObject(data.legacyIds)) throw new Error(`${source}: legacyIds must be a JSON object`)
  for (const [key, value] of Object.entries(data.legacyIds)) {
    if (!isId(key)) {
      throw new Error(`${source}: legacyIds key ${JSON.stringify(key)} — expected a lower-case id matching ${ID_SHAPE}`)
    }
    if (!splitPair(value, ids)) {
      throw new Error(
        `${source}: legacyIds[${JSON.stringify(key)}] ${JSON.stringify(value ?? null)} does not name a declared <agent>.<persona> pair`,
      )
    }
  }

  if (!isObject(data.personaProviders)) throw new Error(`${source}: personaProviders must be a JSON object`)
  for (const [key, value] of Object.entries(data.personaProviders)) {
    if (!splitPair(key, ids)) {
      throw new Error(`${source}: personaProviders key ${JSON.stringify(key)} does not name a declared <agent>.<persona> pair`)
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `${source}: personaProviders[${JSON.stringify(key)}] ${JSON.stringify(value ?? null)} must be a non-empty provider id string`,
      )
    }
  }

  assertModelsShape(data.models, ids, data.personaProviders, source)
  return data
}

// HZ-192's load-time rules for the `models` block. Same message fragments as
// domain/py/personas.py's _validate_models.
function assertModelsShape(models, ids, providers, source) {
  const modelError = (key, value) =>
    new Error(`${source}: ${key} ${JSON.stringify(value ?? null)} is not a Claude model id matching ${MODEL_SHAPE}`)

  if (!isObject(models)) {
    throw new Error(`${source}: models must be a JSON object with agents, conflictAgent, steps and personas`)
  }
  for (const key of Object.keys(models)) {
    if (!MODELS_KEYS.includes(key)) {
      throw new Error(`${source}: models has unknown key ${JSON.stringify(key)} — expected only ${JSON.stringify(MODELS_KEYS)}`)
    }
  }

  const { agents } = models
  if (!isObject(agents) || Object.keys(agents).length === 0) {
    throw new Error(`${source}: models.agents must be a non-empty JSON object`)
  }
  for (const [key, value] of Object.entries(agents)) {
    if (!isId(key)) {
      throw new Error(`${source}: models.agents key ${JSON.stringify(key)} — expected a lower-case id matching ${ID_SHAPE}`)
    }
    if (!isModel(value)) throw modelError(`models.agents[${JSON.stringify(key)}]`, value)
  }

  if (typeof models.conflictAgent !== 'string' || !own(agents, models.conflictAgent)) {
    throw new Error(
      `${source}: models.conflictAgent ${JSON.stringify(models.conflictAgent ?? null)} is not a models.agents key ${JSON.stringify(Object.keys(agents))}`,
    )
  }

  if (!isObject(models.steps)) throw new Error(`${source}: models.steps must be a JSON object`)
  for (const [key, value] of Object.entries(models.steps)) {
    if (key.length === 0) throw new Error(`${source}: models.steps has an empty step key`)
    if (!isModel(value)) throw modelError(`models.steps[${JSON.stringify(key)}]`, value)
  }

  if (!isObject(models.personas)) throw new Error(`${source}: models.personas must be a JSON object`)
  for (const [key, value] of Object.entries(models.personas)) {
    if (!splitPair(key, ids)) {
      throw new Error(`${source}: models.personas key ${JSON.stringify(key)} does not name a declared <agent>.<persona> pair`)
    }
    if (own(providers, key)) {
      throw new Error(
        `${source}: models.personas key ${JSON.stringify(key)} is routed to ${JSON.stringify(providers[key])} by personaProviders — only a Claude-run persona can carry a model`,
      )
    }
    if (!isModel(value)) throw modelError(`models.personas[${JSON.stringify(key)}]`, value)
  }
}

const source = assertPersonasShape(data)

// Every persona agent, in authored order.
export const PERSONA_AGENTS = Object.freeze(source.agents.map((entry) => entry.agent))

// agent -> its persona ids, in authored order.
export const PERSONA_IDS = Object.freeze(
  Object.fromEntries(source.agents.map((entry) => [entry.agent, Object.freeze([...entry.personas])])),
)

// Every `<agent>.<persona>`, agents in order, personas in order within each.
export const NAMESPACED_PERSONA_IDS = Object.freeze(
  PERSONA_AGENTS.flatMap((agent) => PERSONA_IDS[agent].map((persona) => `${agent}.${persona}`)),
)

// agent -> the persona an item gets when it carries none for that agent.
export const DEFAULT_PERSONAS = Object.freeze(Object.fromEntries(source.agents.map((entry) => [entry.agent, entry.default])))

// The agent whose persona is an item's primary specialization.
export const PRIMARY_PERSONA_AGENT = source.primaryAgent

// Flat pre-HZ-125 persona value -> [agent, persona id]. Read-only compatibility
// for rows written before personas were agent-scoped; never written.
export const LEGACY_PERSONA_IDS = Object.freeze(
  Object.fromEntries(Object.entries(source.legacyIds).map(([key, value]) => [key, Object.freeze(value.split('.'))])),
)

// Every lookup below guards with hasOwnProperty rather than testing the value
// for truthiness: these are plain objects, so 'constructor' or '__proto__'
// would otherwise resolve off Object.prototype and read as a registered
// persona. The farm's `in` on a dict has no such hole; these must match it.
// Each table is a defaulted parameter so a fixture can drive the helper with a
// fabricated registry — the convention isPriority uses.
export function isPersonaAgent(agent, personaIds = PERSONA_IDS) {
  return typeof agent === 'string' && own(personaIds, agent)
}

// An id is only a persona *within an agent*, so both halves are always passed.
export function isPersona(agent, id, personaIds = PERSONA_IDS) {
  return isPersonaAgent(agent, personaIds) && typeof id === 'string' && personaIds[agent].includes(id)
}

// [agent, persona id] for a pre-HZ-125 flat value, or null.
export function legacyPersona(id, legacyIds = LEGACY_PERSONA_IDS) {
  if (typeof id !== 'string') return null
  return own(legacyIds, id) ? legacyIds[id] : null
}

// The role markdown's filename in farm/roles/personas/, derived as
// `<agent>_<persona>.md`. Throws for an undeclared pair rather than deriving a
// path from data nobody validated.
export function personaRoleFile(agent, id, personaIds = PERSONA_IDS) {
  if (!isPersona(agent, id, personaIds)) throw new Error(`unknown persona ${JSON.stringify([agent ?? null, id ?? null])}`)
  return `${agent}_${id}.md`
}

// HZ-192: {agents, steps, personas} -> frozen {key -> Claude model id}. See
// resolveModel() for the order they apply in.
export const MODELS = Object.freeze({
  agents: Object.freeze({ ...source.models.agents }),
  steps: Object.freeze({ ...source.models.steps }),
  personas: Object.freeze({ ...source.models.personas }),
})

// The model agent the WhatsApp concierge runs as.
export const CONCIERGE_MODEL_AGENT = 'concierge'

// Merge-conflict resolution runs as this model agent, under the reserved step
// key CONFLICT_STEP_KEY — it is not a domain/steps.json step, so it has no
// label of its own.
export const CONFLICT_MODEL_AGENT = source.models.conflictAgent
export const CONFLICT_STEP_KEY = 'conflict'

// The model agent a domain/steps.json step runs as: its `agent` display name
// lower-cased ('DevOps' -> 'devops'). Those names are therefore a contract.
export function modelAgentForStep(stepAgent) {
  return stepAgent.toLowerCase()
}

// The Claude model a call runs on: models.personas[persona] (a namespaced
// `<agent>.<persona>`), else models.steps[step], else models.agents[agent].
// Throws for an agent with no default, even when an override would apply.
// own() on every lookup, so '__proto__' or 'constructor' never resolves.
export function resolveModel(agent, step = null, persona = null, models = MODELS) {
  if (typeof agent !== 'string' || !own(models.agents, agent)) {
    throw new Error(`unknown model agent ${JSON.stringify(agent ?? null)}`)
  }
  if (typeof persona === 'string' && own(models.personas, persona)) return models.personas[persona]
  if (typeof step === 'string' && own(models.steps, step)) return models.steps[step]
  return models.agents[agent]
}
