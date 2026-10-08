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
    if (field.maxLines !== undefined && (!Number.isInteger(field.maxLines) || field.maxLines < 1)) {
      throw new Error(`${source}: fields[${i}] ("${field.name}") declares a non-integer or non-positive maxLines`)
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

// The one field entry with this name. Throws naming the field — rather than
// returning undefined, which a caller would read as "no cap" and then apply no
// limit at all — if it isn't in the table, e.g. it was renamed on one side of
// the JS/Python boundary but not the other. domain/py/fields.py's
// field_by_name() is the same lookup with the same message; the two are diffed
// in server/test/domain-fields-parity.test.mjs.
export function fieldByName(name, fields = FIELDS) {
  const field = fields.find((f) => f.name === name)
  if (field === undefined) {
    throw new Error(`no work-item field named '${name}' in the field table`)
  }
  return field
}

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

// HZ-345: the line budget for each field that declares `maxLines` — metric and
// guardrails. Keyed by column, like patchLimits(). farm/pm_agent.py's
// line_limits() is the same derivation; fields-cases.json drives both.
export function lineLimits(fields = FIELDS) {
  return Object.fromEntries(fields.filter((f) => f.maxLines !== undefined).map((f) => [f.column, f.maxLines]))
}

// ---- criteria lines (HZ-345) ----
// One rule for "what is a line" of a metric or guardrails, shared with
// domain/py/fields.py's criteria_lines(). A line is trimmed, loses its list
// marker (`-`, `*`, `+`, `1.`, `1)`) and has its whitespace collapsed. The
// split-scope "Deferred to a follow-up item" line never counts: it lists lines
// that are out of scope, not lines to build.
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/
const DEFERRED_PREFIX = 'deferred to a follow-up item'

function normaliseLine(line) {
  return line.trim().replace(LIST_MARKER, '').replace(/\s+/g, ' ').trim()
}

function isDeferredLine(normalised) {
  return normalised.replace(/^[*_]+/, '').toLowerCase().startsWith(DEFERRED_PREFIX)
}

function nonBlankLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

// The lines a budget counts. When any line is a list item, only list items
// count, so a preamble ("Each line is pass/fail…") or a wrapped continuation
// is not a line of its own. Otherwise every non-blank line counts.
export function criteriaLines(text) {
  const lines = nonBlankLines(text)
  const listed = lines.some((line) => LIST_MARKER.test(line))
  return lines
    .filter((line) => !listed || LIST_MARKER.test(line))
    .map(normaliseLine)
    .filter((line) => line && !isDeferredLine(line))
}

export function countCriteriaLines(text) {
  return criteriaLines(text).length
}

// The lines in `after` that `before` does not have, for the post-gate-3 lock
// in server/src/orchestrator.js. EVERY non-blank line is compared, list item or
// not, so a guardrail cannot be slipped in as an unmarked continuation line.
// The Deferred line is exempt: moving lines into it adds nothing to build.
export function addedCriteriaLines(before, after) {
  const known = new Set(nonBlankLines(before).map(normaliseLine))
  return nonBlankLines(after)
    .map(normaliseLine)
    .filter((line) => line && !isDeferredLine(line) && !known.has(line))
}
