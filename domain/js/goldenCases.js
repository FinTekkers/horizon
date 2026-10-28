// HZ-541: the JS reader for a golden_cases sub-step's set. The sub-step's
// artifact carries it as a ```json golden-cases fenced block; the LAST block
// wins, the same rule as runPlan.js. The full contract is
// domain/goldenCases.schema.json, and every rule in it is checked here: an
// approver must never see a set the schema would refuse.
//
// Pure: no I/O. Whether a `source` is indexed is the server's question
// (server/src/goldenCases.js reads the HZ-537 knowledge index).

const FENCED = /```json golden-cases\n([\s\S]*?)\n```/g
const ID_RE = /^[a-z0-9-]{1,40}$/
const SOURCE_RE = /^([a-z0-9_-]+)#([a-z0-9-]+)$/
export const MAX_GOLDEN_CASES = 200
// The token a metric line names the set by.
export const GOLDEN_CASES_MARKER = 'golden_cases'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0

// '<doc>#<section>' -> { doc, section }, or null.
export function parseSource(source) {
  const match = typeof source === 'string' ? SOURCE_RE.exec(source) : null
  return match ? { doc: match[1], section: match[2] } : null
}

function caseProblems(entry) {
  if (!isObject(entry)) return ['must be an object']
  const problems = []
  for (const key of Object.keys(entry)) {
    if (!['id', 'inputs', 'measure', 'expected', 'tolerance', 'source'].includes(key)) problems.push(`unknown key "${key}"`)
  }
  if (!isObject(entry.inputs)) problems.push('inputs must be an object')
  if (typeof entry.measure !== 'string' || !entry.measure.trim() || entry.measure.length > 200) {
    problems.push('measure must be a non-empty string of at most 200 characters')
  }
  const expected = entry.expected
  if (!(typeof expected === 'string' || (typeof expected === 'number' && Number.isFinite(expected)))) {
    problems.push('expected must be a number or a string')
  }
  const tolerance = entry.tolerance
  if (!isObject(tolerance) || Object.keys(tolerance).length === 0) {
    problems.push('tolerance needs abs or rel')
  } else {
    for (const key of Object.keys(tolerance)) {
      if (key !== 'abs' && key !== 'rel') problems.push(`unknown tolerance key "${key}"`)
      else if (!isNonNegative(tolerance[key])) problems.push(`tolerance.${key} must be a number of at least 0`)
    }
  }
  if (!parseSource(entry.source)) problems.push('source must be <doc>#<section>')
  return problems
}

// Pure. { cases, errors }: cases is [] whenever errors is not. Each error
// names its case by id, else by position.
export function validateGoldenCases(block) {
  if (!isObject(block) || !Array.isArray(block.cases)) return { cases: [], errors: ['expected {"cases": [...]}'] }
  const errors = []
  for (const key of Object.keys(block)) if (key !== 'cases') errors.push(`unknown key "${key}"`)
  if (block.cases.length === 0) errors.push('cases is empty')
  if (block.cases.length > MAX_GOLDEN_CASES) errors.push(`more than ${MAX_GOLDEN_CASES} cases`)
  const seen = new Set()
  block.cases.forEach((entry, i) => {
    const id = isObject(entry) ? entry.id : undefined
    const name = typeof id === 'string' && id ? `case ${JSON.stringify(id)}` : `case #${i + 1}`
    const problems = caseProblems(entry)
    if (typeof id !== 'string' || !ID_RE.test(id)) problems.unshift('id must match ^[a-z0-9-]{1,40}$')
    else if (seen.has(id)) problems.unshift('duplicate id')
    else seen.add(id)
    for (const problem of problems) errors.push(`${name}: ${problem}`)
  })
  if (errors.length) return { cases: [], errors }
  // One key order, so the same set always hashes the same.
  const cases = block.cases.map(({ id, inputs, measure, expected, tolerance, source }) => ({
    id,
    inputs,
    measure,
    expected,
    tolerance: { ...(tolerance.abs !== undefined ? { abs: tolerance.abs } : {}), ...(tolerance.rel !== undefined ? { rel: tolerance.rel } : {}) },
    source,
  }))
  return { cases, errors: [] }
}

// The set in a sub-step's artifact: { cases, errors }. No block is an error.
export function extractGoldenCases(artifact) {
  if (typeof artifact !== 'string') return { cases: [], errors: ['no golden-cases block'] }
  const found = [...artifact.matchAll(FENCED)]
  if (found.length === 0) return { cases: [], errors: ['no golden-cases block'] }
  let block
  try {
    block = JSON.parse(found[found.length - 1][1])
  } catch (err) {
    return { cases: [], errors: [`the golden-cases block is not valid JSON (${err.message})`] }
  }
  return validateGoldenCases(block)
}

// The metric as numbered lines: line N is the Nth line of the text.
export function metricLines(metric) {
  return typeof metric === 'string' ? metric.split('\n') : []
}

// The 1-based number of the first metric line that names the set by its
// marker, or null when none does.
export function metricLineFor(metric) {
  const index = metricLines(metric).findIndex((line) => line.includes(GOLDEN_CASES_MARKER))
  return index === -1 ? null : index + 1
}
