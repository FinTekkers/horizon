// The one JS view of "how long may a work-item field be" — imported by relative
// path from server/src. Before HZ-134 each field's limit existed twice, as bare
// integers with no relationship: the API accepted outcome 4000 / metric 2000 /
// guardrails 2000 (server/src/app.js's POST /api/items body schema) while the PM
// agent's own revision path capped the same three fields at 500 / 400 / 400
// (farm/pm_agent.py's PATCH_FIELDS). HZ-114 made those cuts marked rather than
// silent, but a PM revision still could not write what the API accepted. One
// declaration now, in domain/fields.json, and the PM caps are the API's.
//
// Same pattern as domain/js/lifecycle.js and domain/js/reasons.js (HZ-139): this
// file is hand-written source that reads its DATA from domain/fields.json with a
// STATIC import attribute — a build-time import, not a runtime fetch.
// `domain-binding-hygiene.test.mjs` asserts no limit is inlined here.
//
// Nothing presentational lives here. `PATCH_FIELD_LABELS` — the human-readable
// names the GitHub step comment renders ("Outcome", "Success metric") — stays
// hand-owned in server/src/orchestrator.js. domain/ declares the field and its
// limit, not what a human is shown.
//
// Two names per field, deliberately:
//   `name`   — the field's name on the API (the POST /api/items body key).
//   `column` — its work_item column, which is also the key a PM patch uses.
// They differ for exactly one field (outcome/desc). That mapping used to be
// implicit in two unrelated files; it lives here now and nowhere else.

import data from '../fields.json' with { type: 'json' }

// Load-time validation, mirroring assertLifecycleShape's and assertReasonsShape's
// role: the rules a Draft-07 subset cannot express live here, so a broken
// domain/fields.json fails at import rather than reaching a caller. Full schema
// validation stays in domain/validate.mjs, driven by
// server/test/domain-fields-schema.test.mjs.
//
// Every cross-field rule below is a real hazard, not a hypothetical. A duplicate
// `name` makes fieldByName resolve to whichever entry came first; a duplicate
// `column` makes patchLimits() silently drop one field's limit (an object key
// collision); a minLength at-or-above maxLength makes the API reject every
// possible value for that field; and a table with nothing agentRevisable would
// build an empty PATCH_FIELDS, silently discarding every PM revision.
//
// Throws on the first violation, naming the source and the offending
// index/name. Returns `data` so it can wrap the import expression, and is
// exported so a test can feed it a tampered table without a temp-dir harness.
export function assertFieldsShape(data, source = 'domain/fields.json') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${source} must be a JSON object with a fields array`)
  }
  const { fields } = data
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error(`${source}: fields must be a non-empty JSON array of field objects`)
  }
  for (const [i, field] of fields.entries()) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw new Error(`${source}: fields[${i}] must be a field object`)
    }
    if (typeof field.name !== 'string' || field.name.length === 0) {
      throw new Error(`${source}: fields[${i}] has no name`)
    }
    if (typeof field.column !== 'string' || field.column.length === 0) {
      throw new Error(`${source}: fields[${i}] ("${field.name}") has no column`)
    }
    if (!Number.isInteger(field.maxLength) || field.maxLength < 1) {
      throw new Error(`${source}: fields[${i}] ("${field.name}") declares a non-integer or non-positive maxLength`)
    }
    if (field.minLength !== undefined && (!Number.isInteger(field.minLength) || field.minLength < 1)) {
      throw new Error(`${source}: fields[${i}] ("${field.name}") declares a non-integer or non-positive minLength`)
    }
    for (const flag of ['settableAtIntake', 'agentRevisable']) {
      if (typeof field[flag] !== 'boolean') {
        throw new Error(
          `${source}: fields[${i}] ("${field.name}") declares a non-boolean ${flag} — a truthy value is not a flag`,
        )
      }
    }
    if (field.minLength !== undefined && field.minLength >= field.maxLength) {
      throw new Error(
        `${source}: fields[${i}] ("${field.name}") declares minLength ${field.minLength} at or above maxLength ${field.maxLength} — no value could satisfy it`,
      )
    }
  }

  const dupesOf = (values) => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))].sort()
  const dupeNames = dupesOf(fields.map((f) => f.name))
  if (dupeNames.length > 0) {
    throw new Error(`${source} has duplicate field name(s): ${JSON.stringify(dupeNames)}`)
  }
  const dupeColumns = dupesOf(fields.map((f) => f.column))
  if (dupeColumns.length > 0) {
    throw new Error(`${source} has duplicate column(s): ${JSON.stringify(dupeColumns)}`)
  }
  if (!fields.some((f) => f.settableAtIntake)) {
    throw new Error(`${source}: no field is settableAtIntake — POST /api/items would accept nothing`)
  }
  if (!fields.some((f) => f.agentRevisable)) {
    throw new Error(`${source}: no field is agentRevisable — every PM revision would be discarded`)
  }

  return data
}

const source = assertFieldsShape(data)

// The authored table, verbatim: every work-item field that carries a length
// limit, with the one number that limit is.
export const FIELDS = source.fields

// The fields a human may set when the item is created — what POST /api/items
// builds its body schema from. `persona` is deliberately absent: it is assigned
// by an agent or at a gate, never at intake.
export function intakeFields(fields = FIELDS) {
  return fields.filter((f) => f.settableAtIntake)
}

// DERIVED, never hand-typed — this is success criterion 3, from the JS side.
// Keyed by COLUMN, because that is the key a PM patch and the work_item UPDATE
// both use, and in authored order, because farm/pm_agent.py's validate()
// iterates it and server/src/orchestrator.js's FARM_PATCH_FIELDS is its key
// list. domain/py/fields.py's patch_limits() derives the identical mapping;
// server/test/domain-fields-parity.test.mjs diffs the two, order included.
export function patchLimits(fields = FIELDS) {
  return Object.fromEntries(fields.filter((f) => f.agentRevisable).map((f) => [f.column, f.maxLength]))
}
