// The one JS view of "what can make a step fail, and which failures the server
// is willing to retry by itself" — imported by relative path from server/src
// and ui/src. Before HZ-132 this vocabulary existed three times, as bare string
// literals: the farm emitted them (farm/step_agent.py, farm/farmd.py), the
// server classified them (a hand-typed AUTO_RETRY_REASONS set in
// server/src/orchestrator.js) and the UI parsed them back out of a pause event
// (ui/src/domain/pauseReason.js). A typo on any side silently turned an
// auto-retry into a pause, or a pause into a blank banner. One declaration now.
//
// Same pattern as domain/js/lifecycle.js (HZ-139): this file is hand-written
// source that reads its DATA from domain/reasons.json with a STATIC import
// attribute — a build-time import, not a runtime fetch. Node 22 and Rollup both
// inline it, so the UI still works with no server and no network.
// `domain-binding-hygiene.test.mjs` asserts no reason id is inlined here and
// `ui/scripts/verify-base-build.mjs` asserts the built bundle does carry one.
//
// Nothing presentational lives here. The pause banner's labels and details stay
// hand-owned in ui/src/domain/pauseReason.js — domain/ declares the vocabulary,
// not how a human is told about it.

import data from '../reasons.json' with { type: 'json' }

// Load-time validation, mirroring assertLifecycleShape's role: the rules a
// Draft-07 subset cannot express live here, so a broken domain/reasons.json
// fails at import rather than rendering a broken binding. Full schema
// validation stays in domain/validate.mjs, driven by
// server/test/domain-reasons-schema.test.mjs — shipping the validator plus the
// schema into the browser bundle would cost every UI user for a check CI
// already runs.
//
// The id-shape rule is LOAD-BEARING, not cosmetic: REASON's keys are derived by
// id.toUpperCase(), so a hyphenated id would produce a key no caller can name,
// and a mixed-case one would collide with its own lower-case form.
//
// Throws on the first violation, naming the source and the offending
// index/id. Returns `data` so it can wrap the import expression, and is
// exported so a test can feed it a tampered table without a temp-dir harness.
const ID_SHAPE = /^[a-z][a-z0-9_]*$/

export function assertReasonsShape(data, source = 'domain/reasons.json') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${source} must be a JSON object with a reasons array`)
  }
  const { reasons } = data
  if (!Array.isArray(reasons) || reasons.length === 0) {
    throw new Error(`${source}: reasons must be a non-empty JSON array of reason objects`)
  }
  for (const [i, reason] of reasons.entries()) {
    if (!reason || typeof reason !== 'object' || Array.isArray(reason)) {
      throw new Error(`${source}: reasons[${i}] must be a reason object`)
    }
    if (typeof reason.id !== 'string' || !ID_SHAPE.test(reason.id)) {
      throw new Error(
        `${source}: reasons[${i}] declares id ${JSON.stringify(reason.id)} — expected lower_snake_case matching ${ID_SHAPE}`,
      )
    }
    if (typeof reason.retryable !== 'boolean') {
      throw new Error(
        `${source}: reasons[${i}] ("${reason.id}") declares a non-boolean retryable — a truthy value is not a flag`,
      )
    }
  }

  // Cross-field rules. A duplicate id makes isRetryable resolve to whichever
  // entry came first, and a vocabulary with nothing retryable would silently
  // turn every transient failure into a pause — the exact regression this
  // item exists to make impossible.
  const ids = reasons.map((r) => r.id)
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort()
  if (dupes.length > 0) {
    throw new Error(`${source} has duplicate reason id(s): ${JSON.stringify(dupes)}`)
  }
  if (!reasons.some((r) => r.retryable)) {
    throw new Error(`${source}: no reason is retryable — every transient failure would pause for a human`)
  }

  return data
}

const source = assertReasonsShape(data)

// The authored vocabulary, verbatim: every failure reason the farm may emit and
// the server may classify, each with the one flag that decides whether the
// server retries it by itself (HZ-76's cap still applies on top).
export const REASONS = source.reasons

export const REASON_IDS = REASONS.map((r) => r.id)

// The constants every consumer emits and compares against, keyed by the id's
// upper-case form. Frozen so a consumer cannot mutate the vocabulary at
// runtime. Note the asymmetry with the Python binding's dict: a typo here
// (REASON.TURN_CPA) reads as `undefined` rather than throwing, which is why
// server/test/domain-reason-member-access.test.mjs scans every access.
export const REASON = Object.freeze(Object.fromEntries(REASONS.map((r) => [r.id.toUpperCase(), r.id])))

// DERIVED, never hand-typed — this is success criterion 2. A Set, because
// server/src/orchestrator.js's failFarmRun calls .has() on it; an Array would
// return undefined there and pause every transient failure silently.
export const AUTO_RETRY_REASONS = new Set(REASONS.filter((r) => r.retryable).map((r) => r.id))

export function isRetryable(id) {
  return AUTO_RETRY_REASONS.has(id)
}
