// The one JS view of "what priority may a work item carry, and in what order"
// — imported by relative path from server/src and ui/src. Before HZ-135 the
// vocabulary existed TEN times, as hand-typed lists: the API's POST /api/items
// enum and the POST /api/items/:id/priority enum, store.js's PRIORITIES, the
// SQL CHECK constraint in db.js, a label-matching regex written twice
// byte-for-byte (store.js and github.js), the keys of two colour maps
// (github.js's hex and ui/src/domain/lifecycle.js's theme tokens), the UI's
// intake picker, and the farm's wizard tuple plus its numbered prompt. A value
// added on one side would have been rejected by the other three layers.
//
// Same pattern as domain/js/lifecycle.js, reasons.js and fields.js (HZ-139):
// this file is hand-written source that reads its DATA from
// domain/priorities.json with a STATIC import attribute — a build-time import,
// not a runtime fetch. Node 22 and Rollup both inline it, so the UI still works
// with no server and no network. `domain-binding-hygiene.test.mjs` asserts no
// priority value is inlined here and `ui/scripts/verify-base-build.mjs` asserts
// the built bundle does carry the whole ordered sequence.
//
// ORDER IS PART OF THE DECLARATION, and it is DISPLAY order — severity, highest
// first. Nothing in this repo sorts work items by priority, so there are no rank
// integers: array position is the whole of it. The intake picker renders the
// array top-to-bottom and the WhatsApp wizard numbers it 1..n, both derived.
//
// Nothing presentational lives here. The two colour maps stay hand-owned where
// they are — hex in server/src/github.js (persisted to GitHub), theme tokens in
// ui/src/domain/lifecycle.js — and both KEY off PRIORITY below rather than
// re-typing the vocabulary. The GitHub label FORMAT (`priority: critical`) stays
// in server/src/priorityLabels.js: that is GitHub's spelling of the value, not
// the value.

import data from '../priorities.json' with { type: 'json' }

// Load-time validation, mirroring assertLifecycleShape's, assertReasonsShape's
// and assertFieldsShape's role: the rules a Draft-07 subset cannot express live
// here, so a broken domain/priorities.json fails at import rather than reaching
// a caller. Full schema validation stays in domain/validate.mjs, driven by
// server/test/domain-priorities-schema.test.mjs.
//
// Each rule below is LOAD-BEARING, not cosmetic:
//
//   VALUE_SHAPE — server/src/db.js builds the work_item CHECK constraint by
//     interpolating these values into SQL. Repo-controlled data today, but
//     pinning the shape is what makes the generated clause provably safe rather
//     than safe-by-convention. It is also what makes PRIORITY's keys reachable:
//     they are derived by toUpperCase(), so a value with a space or a hyphen
//     would produce a key no caller can name.
//   Case-insensitive uniqueness — the GitHub label match in
//     server/src/priorityLabels.js is case-insensitive (a human types
//     `priority: High` or `priority: high`), so two values differing only in
//     case would make priorityFromLabels() resolve to whichever came first.
//   `default` in `priorities` — a default outside the vocabulary would be
//     written straight into work_item and then rejected by the CHECK constraint
//     that the same list built.
//
// Throws on the first violation, naming the source and the offending
// index/value. Returns `data` so it can wrap the import expression, and is
// exported so a test can feed it a tampered vocabulary without a temp-dir
// harness.
const VALUE_SHAPE = /^[A-Z][A-Za-z]*$/

export function assertPrioritiesShape(data, source = 'domain/priorities.json') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${source} must be a JSON object with a priorities array`)
  }
  const { priorities } = data
  if (!Array.isArray(priorities) || priorities.length === 0) {
    throw new Error(`${source}: priorities must be a non-empty JSON array of strings`)
  }
  for (const [i, value] of priorities.entries()) {
    if (typeof value !== 'string' || !VALUE_SHAPE.test(value)) {
      throw new Error(
        `${source}: priorities[${i}] declares ${JSON.stringify(value)} — expected a capitalised letters-only word matching ${VALUE_SHAPE}`,
      )
    }
  }

  // Case-INSENSITIVE, which is stricter than the schema's uniqueItems.
  const folded = priorities.map((value) => value.toLowerCase())
  const dupes = [...new Set(folded.filter((value, i) => folded.indexOf(value) !== i))].sort()
  if (dupes.length > 0) {
    throw new Error(
      `${source} has duplicate priority value(s), ignoring case: ${JSON.stringify(dupes)} — label matching is case-insensitive`,
    )
  }

  // `?? null` so an ABSENT default reports as `null` rather than as the bare
  // word `undefined`: JSON.stringify(undefined) returns undefined, which the
  // template literal would then stringify, and Python's json.dumps(None) says
  // `null`. The two messages are compared fragment-for-fragment by
  // farm/tests/test_priorities.py, so this is not cosmetic.
  if (typeof data.default !== 'string' || !priorities.includes(data.default)) {
    throw new Error(
      `${source}: default ${JSON.stringify(data.default ?? null)} is not one of the declared priorities ${JSON.stringify(priorities)}`,
    )
  }

  return data
}

const source = assertPrioritiesShape(data)

// The authored vocabulary, verbatim and IN ORDER: every priority a work item may
// carry, highest severity first. The API enums, the SQL CHECK constraint, the
// intake picker and the farm's wizard are all this array.
export const PRIORITIES = source.priorities

// What an item gets when nobody says so — POST /api/items with no priority, an
// issue synced from GitHub with no priority label, the wizard's opening session.
export const DEFAULT_PRIORITY = source.default

// The constants a presentation map should KEY off, keyed by the value's
// upper-case form — the same shape domain/js/reasons.js's REASON ships, for the
// same reason. server/src/github.js's hex map and ui/src/domain/lifecycle.js's
// theme map both use this instead of re-typing the vocabulary or, worse, keying
// colour by array index: a reordered priorities.json must not silently recolour
// the UI. Frozen so a consumer cannot rewrite the vocabulary at runtime.
//
// Note the asymmetry with the Python binding's dict, which is the same one
// REASON has: a typo here (PRIORITY.CRITCAL) reads as `undefined` rather than
// raising, so server/test/domain-priority-pins.test.mjs pins the key set.
export const PRIORITY = Object.freeze(Object.fromEntries(PRIORITIES.map((value) => [value.toUpperCase(), value])))

// Exact match, deliberately: the API's two enums are exact, so a value that
// only differs in case must fail here rather than reaching a CHECK constraint
// that would reject it anyway. `priorities` is a parameter with a default — the
// convention fieldByName and budget_for_label already use — so a fixture can
// drive it with a fabricated vocabulary and assert the answer follows the
// argument rather than the live document.
export function isPriority(value, priorities = PRIORITIES) {
  return priorities.includes(value)
}
