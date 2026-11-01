// HZ-664: the pieces of isolation-non-member.test.mjs that are not the case
// table itself. A case is keyed '<METHOD> <url>', exactly as app.routeScopes()
// lists the route, so a route added later with no case fails the walk by name.

export const routeKey = (route) => `${route.method} ${route.url}`

// Throws naming every registry route with no case, and every case with no
// registry route (a stale row must not hide a renamed route). Own keys only:
// `cases` is a plain object, and an inherited key is never a case.
export function assertCasesCover(registry, cases) {
  const keys = new Set(registry.map(routeKey))
  const missing = [...keys].filter((key) => !Object.hasOwn(cases, key))
  const stale = Object.keys(cases).filter((key) => !keys.has(key))
  const problems = []
  if (missing.length) problems.push(`no non-member case for: ${missing.join(', ')}`)
  if (stale.length) problems.push(`case with no registry route: ${stale.join(', ')}`)
  if (problems.length) throw new Error(problems.join('; '))
}

// The value at a dotted path ('items', 'board.items') of a parsed body, or
// undefined. Own properties only.
export function valueAt(json, path) {
  let value = json
  for (const part of path.split('.')) {
    if (value == null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined
    value = value[part]
  }
  return value
}

// `[]`, `{}` or `0`. Anything else — undefined included — is not empty.
export function isEmptyValue(value) {
  if (Array.isArray(value)) return value.length === 0
  if (value != null && typeof value === 'object') return Object.keys(value).length === 0
  return value === 0
}

// The needles that appear anywhere in `text`.
export function leaksIn(text, needles) {
  return needles.filter((needle) => text.includes(needle))
}
