// HZ-328: the file formats of tests/inventory.csv, tests/coverage-map.json and
// tests/blocking.json. Shared by inventory.mjs (writes the first two) and
// select-blocking.mjs (reads them, writes the third), so neither depends on
// the other. Every writer here gives the same bytes for the same data: LF line
// ends, a trailing newline, object keys sorted.

// One row per test (inventory.mjs). Rows are sorted by (suite, file, test).
export const INVENTORY_COLUMNS = [
  'repo',
  'suite',
  'file',
  'test',
  'runs',
  'passes',
  'failures',
  'main_failures',
  'flakes',
  'median_ms',
  'p95_ms',
  'last_seen',
  'fails_alone',
  'covered_files',
]

// ---- CSV: RFC 4180 quoting ----

function field(value) {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(columns, rows) {
  const lines = [columns.join(',')]
  for (const row of rows) lines.push(columns.map((c) => field(row[c])).join(','))
  return `${lines.join('\n')}\n`
}

// Rows as objects keyed by the header; every value a string. CRLF is read as LF.
export function parseCsv(text) {
  const records = []
  let record = []
  let value = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        value += '"'
        i++
      } else if (c === '"') quoted = false
      else value += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      record.push(value)
      value = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      record.push(value)
      records.push(record)
      record = []
      value = ''
    } else value += c
  }
  if (value !== '' || record.length > 0) {
    record.push(value)
    records.push(record)
  }
  const [header = [], ...body] = records
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])))
}

// ---- line ranges: [1,2,3,7] <-> '1-3,7' ----

export function encodeRanges(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b)
  const parts = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`)
    i = j
  }
  return parts.join(',')
}

export function decodeRanges(text) {
  const lines = []
  for (const part of String(text).split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
    if (!m) continue
    const from = Number(m[1])
    const to = m[2] === undefined ? from : Number(m[2])
    for (let n = from; n <= to; n++) lines.push(n)
  }
  return lines
}

// ---- JSON with sorted keys, 2-space indent ----

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  )
}

export function stableJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}
