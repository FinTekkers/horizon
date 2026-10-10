// HZ-398: the one JS view of "which agent providers exist, what they are
// called, and which models an owner may pick for a step". Imported by
// relative path from server/src (the two "Runs on" route enums, the stored
// choice filter, the event text) and, from HZ-398b, ui/src (the picker).
//
// Same pattern as domain/js/priorities.js: hand-written source reading its
// DATA from domain/providers.json with a STATIC import attribute — a
// build-time import, not a runtime fetch — so the UI still works with no
// server. domain/py/providers.py is the farm's twin, and
// domain/fixtures/providers-cases.json drives both validators and both
// parsers so the two cannot drift.
//
// A stored step choice (work_item.provider_choices_json and
// project.provider_defaults_json, HZ-357/HZ-370) is one of:
//   "<provider>"            — the pre-HZ-398 bare form. The provider's own
//                             default model: domain/personas.json's `models`
//                             block for the default provider, defaultModel
//                             for any other. Never rewritten.
//   "<provider>:<model id>" — a model the owner picked; the id must be one of
//                             that provider's SELECTABLE models.
// Model ids carry no colon (asserted below), so the split is unambiguous.
//
// ORDER IS PART OF THE DECLARATION: provider order, then model order within
// a provider, is the order choiceValues() lists them in.

import data from '../providers.json' with { type: 'json' }

// Kept in step with domain/py/providers.py's _NAME_SHAPE / _MODEL_SHAPE.
const NAME_SHAPE = /^[a-z]+$/
const MODEL_SHAPE = /^[a-z0-9][a-z0-9.-]*$/

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = (value) => typeof value === 'string' && value.length > 0

// Load-time validation: the rules a Draft-07 subset cannot express. Throws on
// the first violation; message fragments are kept word-for-word in step with
// domain/py/providers.py's _validate_source. Exported so a test can feed it a
// tampered catalogue.
export function assertProvidersShape(data, source = 'domain/providers.json') {
  if (!isObject(data)) throw new Error(`${source} must be a JSON object with a non-empty providers array`)
  const { providers } = data
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error(`${source} must be a JSON object with a non-empty providers array`)
  }
  const names = []
  const seenIds = new Map()
  for (const [i, entry] of providers.entries()) {
    if (!isObject(entry)) throw new Error(`${source}: providers[${i}] is not an object`)
    const { name } = entry
    if (typeof name !== 'string' || !NAME_SHAPE.test(name)) {
      throw new Error(`${source}: providers[${i}] name ${JSON.stringify(name ?? null)} — expected a lower-case name matching ${NAME_SHAPE}`)
    }
    if (names.includes(name)) throw new Error(`${source}: provider ${JSON.stringify(name)} is declared twice`)
    names.push(name)
    if (!isText(entry.label)) throw new Error(`${source}: provider ${JSON.stringify(name)} has no label`)
    if (!Array.isArray(entry.models) || entry.models.length === 0) {
      throw new Error(`${source}: provider ${JSON.stringify(name)} must declare a non-empty models array`)
    }
    const ids = []
    for (const [j, model] of entry.models.entries()) {
      if (!isObject(model) || typeof model.id !== 'string' || !MODEL_SHAPE.test(model.id)) {
        throw new Error(
          `${source}: provider ${JSON.stringify(name)} models[${j}] id ${JSON.stringify(model?.id ?? null)} — expected a model id matching ${MODEL_SHAPE}`,
        )
      }
      if (seenIds.has(model.id)) {
        throw new Error(`${source}: model ${JSON.stringify(model.id)} is declared by both ${JSON.stringify(seenIds.get(model.id))} and ${JSON.stringify(name)}`)
      }
      seenIds.set(model.id, name)
      if (!isText(model.label)) throw new Error(`${source}: model ${JSON.stringify(model.id)} has no label`)
      if (typeof model.selectable !== 'boolean') throw new Error(`${source}: model ${JSON.stringify(model.id)} selectable must be true or false`)
      ids.push(model.id)
    }
    if (entry.defaultModel !== null && !ids.includes(entry.defaultModel)) {
      throw new Error(
        `${source}: provider ${JSON.stringify(name)} defaultModel ${JSON.stringify(entry.defaultModel ?? null)} is not null or one of its own models`,
      )
    }
  }
  if (typeof data.default !== 'string' || !names.includes(data.default)) {
    throw new Error(`${source}: default ${JSON.stringify(data.default ?? null)} is not a declared provider ${JSON.stringify(names)}`)
  }
  return data
}

const source = assertProvidersShape(data)

// Every provider, verbatim and in order, frozen all the way down.
export const PROVIDERS = Object.freeze(
  source.providers.map((p) =>
    Object.freeze({ ...p, models: Object.freeze(p.models.map((m) => Object.freeze({ ...m }))) }),
  ),
)

// The provider a step runs on when nobody chose one.
export const DEFAULT_PROVIDER = source.default

// Every helper below takes `providers` as a parameter with a default, the
// convention isPriority uses, so a fixture can drive it with a fabricated
// catalogue (HZ-398's "a new provider needs no code change" test).
function find(providers, name) {
  return typeof name === 'string' ? (providers.find((p) => p.name === name) ?? null) : null
}

export function providerNames(providers = PROVIDERS) {
  return providers.map((p) => p.name)
}

// Whether `modelId` is one of `provider`'s declared models, selectable or not.
export function declares(provider, modelId, providers = PROVIDERS) {
  const entry = find(providers, provider)
  return !!entry && typeof modelId === 'string' && entry.models.some((m) => m.id === modelId)
}

// `provider`'s pinned default model, or null (the default provider's comes from
// domain/personas.json's `models` block; an unknown provider has none).
export function defaultModel(provider, providers = PROVIDERS) {
  return find(providers, provider)?.defaultModel ?? null
}

// A stored step choice as { provider, model } (model null for the bare form),
// or null for anything a reader must not act on: not a string, an unknown
// provider, or a model that is not one of that provider's selectable models.
export function parseChoice(value, providers = PROVIDERS) {
  if (typeof value !== 'string') return null
  const at = value.indexOf(':')
  const name = at === -1 ? value : value.slice(0, at)
  const entry = find(providers, name)
  if (!entry) return null
  if (at === -1) return { provider: name, model: null }
  const id = value.slice(at + 1)
  return entry.models.some((m) => m.id === id && m.selectable) ? { provider: name, model: id } : null
}

// Every value an owner may store for a step besides "default": each bare
// provider name (the pre-HZ-398 form), then each selectable "<provider>:<id>".
export function choiceValues(providers = PROVIDERS) {
  return [
    ...providerNames(providers),
    ...providers.flatMap((p) => p.models.filter((m) => m.selectable).map((m) => `${p.name}:${m.id}`)),
  ]
}

// A declared model's label ("Sonnet 5.5"), or null.
export function modelLabel(provider, modelId, providers = PROVIDERS) {
  const entry = find(providers, provider)
  return entry?.models.find((m) => m.id === modelId)?.label ?? null
}

// "Claude · Sonnet 5.5" for a composite choice, "Claude" for a bare one, null
// for a value parseChoice refuses.
export function choiceLabel(value, providers = PROVIDERS) {
  const choice = parseChoice(value, providers)
  if (!choice) return null
  const { label } = find(providers, choice.provider)
  return choice.model ? `${label} · ${modelLabel(choice.provider, choice.model, providers)}` : label
}
