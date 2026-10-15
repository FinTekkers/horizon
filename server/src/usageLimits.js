// HZ-422: falling back to the next model when one hits a usage limit, and
// waiting for the reset when every model a step may run on is limited. Pure
// functions only: the ledger lives in store.js (model_limit), and
// orchestrator.js's kick() and failFarmRun() are the callers. Every time is
// compared as epoch ms from the caller's clock, so a test's fake clock drives it.
//
// "At most once per dispatch" is held by the ledger alone: a limit is always
// written with a reset after now (resetMs below), so the model that was just
// limited is never picked again inside its window.

import { DEFAULT_PROVIDER, FALLBACK_CHAIN, PROVIDERS, defaultModel, modelLabel, parseChoice } from '../../domain/js/providers.js'
import { modelAgentForStep, resolveModel } from '../../domain/js/personas.js'

// A limit whose reset time is missing, unparseable or already past waits this
// long — never 0, so no limit can turn into an immediate retry loop.
export const USAGE_LIMIT_DEFAULT_WAIT_MS = 15 * 60_000

// When a limit reported at `nowMs` lifts, in epoch ms. Always after nowMs.
export function resetMs(resetAtIso, nowMs) {
  const at = typeof resetAtIso === 'string' ? Date.parse(resetAtIso) : NaN
  return Number.isFinite(at) && at > nowMs ? at : nowMs + USAGE_LIMIT_DEFAULT_WAIT_MS
}

// "<provider>:<model>", the form a stored choice and a chain entry share.
export function entryKey(entry) {
  return `${entry.provider}:${entry.model}`
}

// The model a step runs on when nothing else picks one: the default
// provider's comes from domain/personas.json, any other's is pinned in
// domain/providers.json (the farm's agent_runner._model_for, same order).
function stepModel(provider, step) {
  return provider === DEFAULT_PROVIDER ? resolveModel(modelAgentForStep(step.agent), step.label) : defaultModel(provider)
}

// The model a dispatch tries first: the step's "Runs on" choice (the item's,
// else the project's default, already merged), else the default provider.
export function chainHead(choiceValue, step) {
  const choice = parseChoice(choiceValue)
  if (choice) return { provider: choice.provider, model: choice.model ?? stepModel(choice.provider, step) }
  return { provider: DEFAULT_PROVIDER, model: stepModel(DEFAULT_PROVIDER, step) }
}

// The models one dispatch may try, in order: the head, then the chain without
// it. A step that may not change provider (deploy, every providerLocked or
// override-ineligible step) gets its head alone — it waits, never switches.
export function effectiveChain(head, step, chain = FALLBACK_CHAIN) {
  if (step.providerLocked || !step.providerOverrideEligible) return [head]
  return [head, ...chain.filter((entry) => entryKey(entry) !== entryKey(head))]
}

// The first chain entry with no limit active at nowMs, as { entry } — plus
// { fallbackFrom, fallbackResetMs } when it is not the head — or, when every
// entry is limited, { waitUntilMs } for the earliest reset. `limits` maps a
// model id to its reset in epoch ms.
export function pickModel(chain, limits, nowMs) {
  const limitedUntil = (entry) => limits.get(entry.model) ?? 0
  const entry = chain.find((e) => limitedUntil(e) <= nowMs)
  if (!entry) return { waitUntilMs: Math.min(...chain.map(limitedUntil)) }
  if (entry === chain[0]) return { entry }
  return { entry, fallbackFrom: chain[0], fallbackResetMs: limitedUntil(chain[0]) }
}

// "2026-10-12 14:00 UTC" — built here, so every client shows the same text.
export function formatResetTime(iso) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 'an unknown time'
  const text = new Date(ms).toISOString()
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`
}

// "Muse · Spark 1.3" for "muse:muse-spark-1.3"; the raw key for anything undeclared.
export function entryLabel(key) {
  const at = typeof key === 'string' ? key.indexOf(':') : -1
  if (at === -1) return String(key)
  const provider = key.slice(0, at)
  const model = key.slice(at + 1)
  const providerLabel = PROVIDERS.find((p) => p.name === provider)?.label
  const label = modelLabel(provider, model)
  return providerLabel && label ? `${providerLabel} · ${label}` : key
}

export function usageWaitText(untilIso) {
  return `Waiting for usage limits to reset, earliest ${formatResetTime(untilIso)}`
}

export function fallbackNoteText(fromKey, resetIso) {
  return `fell back from ${entryLabel(fromKey)}: usage limit until ${formatResetTime(resetIso)}`
}
