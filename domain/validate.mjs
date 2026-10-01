// HZ-128: a dependency-free JSON Schema (Draft-07 subset) validator.
//
// Why hand-rolled: `ajv` is in neither server/package.json nor
// ui/package.json, and this item's guardrails forbid adding a dependency. The
// subset is deliberately tiny and closed — exactly the keywords
// domain/steps.schema.json uses, listed in KEYWORDS below. Anything else in a
// schema is a hard error (see the unsupported-keyword throw), so the schema
// can never quietly grow a keyword this file silently ignores: a schema that
// looks stricter than the validator would be the one way this file could fail
// open.
//
// Cross-field rules a Draft-07 subset cannot express (a step's `phase` being
// in range of `phases`, unique step labels) live in the bindings' own
// load-time checks — assertLifecycleShape() in domain/js/lifecycle.js and
// _validate_source() in domain/py/steps.py — not here.
//
// This file is deliberately NOT imported by either binding: it would ship the
// whole Draft-07 engine plus steps.schema.json into the browser bundle for a
// check CI already runs on the same commit (server/test/domain-schema.test.mjs).

const KEYWORDS = new Set([
  // annotations — ignored, allowed anywhere
  '$schema', '$comment', 'title', 'description', 'definitions',
  // validation
  'type', 'enum', 'const',
  'minLength', 'minimum', 'maximum',
  'minItems', 'uniqueItems', 'items',
  'properties', 'required', 'additionalProperties',
  'allOf', 'anyOf', 'not', 'if', 'then', '$ref',
])

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  integer: Number.isInteger,
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

// Only local "#/a/b" pointers — this validator never fetches a remote schema.
function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`validate.mjs: unsupported $ref ${ref} — only local "#/..." pointers`)
  let node = root
  for (const rawPart of ref.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~')
    node = node?.[part]
    if (node === undefined) throw new Error(`validate.mjs: $ref ${ref} does not resolve`)
  }
  return node
}

function assertKeywordsSupported(schema, where) {
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) {
      throw new Error(`validate.mjs: unsupported schema keyword "${key}" at ${where || '(root)'}`)
    }
  }
}

// `true` iff `data` satisfies `schema` — used by if/anyOf/not, which need a
// boolean rather than a message.
function matches(root, schema, data) {
  return check(root, schema, data, '').length === 0
}

function check(root, schema, data, at) {
  if (schema === true) return []
  if (schema === false) return [`${at || '(root)'}: schema forbids any value here`]
  assertKeywordsSupported(schema, at)

  const errors = []
  const where = at || '(root)'

  if (schema.$ref !== undefined) {
    errors.push(...check(root, resolveRef(root, schema.$ref), data, at))
    return errors
  }

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type]
    for (const t of allowed) {
      if (!TYPE_CHECKS[t]) throw new Error(`validate.mjs: unsupported type "${t}" at ${where}`)
    }
    if (!allowed.some((t) => TYPE_CHECKS[t](data))) {
      // A type mismatch makes every other keyword meaningless — report it
      // alone rather than cascading "minLength of a number" noise.
      return [`${where}: expected ${allowed.join(' or ')}, got ${typeOf(data)}`]
    }
  }

  if (schema.const !== undefined && data !== schema.const) {
    errors.push(`${where}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`)
  }

  if (schema.enum !== undefined && !schema.enum.includes(data)) {
    errors.push(`${where}: ${JSON.stringify(data)} is not one of ${JSON.stringify(schema.enum)}`)
  }

  if (typeof data === 'string' && schema.minLength !== undefined && data.length < schema.minLength) {
    errors.push(`${where}: string shorter than minLength ${schema.minLength}`)
  }

  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push(`${where}: ${data} is below minimum ${schema.minimum}`)
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push(`${where}: ${data} is above maximum ${schema.maximum}`)
    }
  }

  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push(`${where}: expected at least ${schema.minItems} item(s), got ${data.length}`)
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(data.map((item) => JSON.stringify(item)))
      if (seen.size !== data.length) errors.push(`${where}: items must be unique`)
    }
    if (schema.items !== undefined) {
      data.forEach((item, i) => errors.push(...check(root, schema.items, item, `${at}[${i}]`)))
    }
  }

  if (TYPE_CHECKS.object(data)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        errors.push(`${where}: missing required property "${key}"`)
      }
    }
    const properties = schema.properties || {}
    for (const [key, value] of Object.entries(data)) {
      if (properties[key] !== undefined) {
        errors.push(...check(root, properties[key], value, at ? `${at}.${key}` : key))
      } else if (schema.additionalProperties === false) {
        errors.push(`${where}: unknown property "${key}"`)
      }
    }
  }

  for (const sub of schema.allOf || []) errors.push(...check(root, sub, data, at))

  if (schema.anyOf !== undefined && !schema.anyOf.some((sub) => matches(root, sub, data))) {
    errors.push(`${where}: matches none of the anyOf alternatives`)
  }

  if (schema.not !== undefined && matches(root, schema.not, data)) {
    errors.push(`${where}: must NOT match ${JSON.stringify(schema.not)}`)
  }

  if (schema.if !== undefined && schema.then !== undefined && matches(root, schema.if, data)) {
    errors.push(...check(root, schema.then, data, at))
  }

  return errors
}

// Returns a list of human-readable problems. Empty list === valid.
export function validate(schema, data) {
  return check(schema, schema, data, '')
}
