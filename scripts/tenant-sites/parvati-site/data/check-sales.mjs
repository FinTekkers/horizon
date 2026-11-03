// Checks data/sales.csv for the site's npm test (run from check-links.mjs):
// the fictional-data note, the 12 columns in order, about 300 rows with every
// cell filled, at least 40 Upper West Side co-op sales, and a byte-for-byte
// match with what generate-sales.mjs writes.

import { readFileSync } from 'node:fs'
import { COLUMNS, salesCsv } from './generate-sales.mjs'

export const MIN_ROWS = 280
export const MAX_ROWS = 320
export const MIN_UWS_COOPS = 40

// Returns { rows, problems }: rows is the number of data rows, and each problem
// is { row, column, message } (row and column are null for whole-file problems;
// row counts data rows from 1, after the note and the header).
export function checkSales(file) {
  const problems = []
  const fileProblem = (message) => problems.push({ row: null, column: null, message })
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    fileProblem(`cannot read ${file}: ${err.code ?? err.message}`)
    return { rows: 0, problems }
  }
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const [note, header, ...data] = lines

  if (!note?.startsWith('# FICTIONAL DATA')) fileProblem('first line must be the "# FICTIONAL DATA" note')
  if (header !== COLUMNS.join(',')) fileProblem(`header must be ${COLUMNS.join(',')}`)

  let uwsCoops = 0
  data.forEach((line, i) => {
    const row = i + 1
    const cells = line.split(',')
    if (cells.length !== COLUMNS.length) {
      problems.push({ row, column: null, message: `has ${cells.length} cells, expected ${COLUMNS.length}` })
      return
    }
    cells.forEach((cell, c) => {
      if (cell.trim() === '') problems.push({ row, column: COLUMNS[c], message: 'empty' })
    })
    const sale = Object.fromEntries(COLUMNS.map((c, j) => [c, cells[j]]))
    if (sale.neighbourhood === 'Upper West Side' && sale.type === 'co-op') uwsCoops++
  })

  if (data.length < MIN_ROWS || data.length > MAX_ROWS) fileProblem(`has ${data.length} rows, expected ${MIN_ROWS} to ${MAX_ROWS}`)
  if (uwsCoops < MIN_UWS_COOPS) fileProblem(`has ${uwsCoops} Upper West Side co-op rows, expected at least ${MIN_UWS_COOPS}`)
  if (text !== salesCsv()) fileProblem('differs from what data/generate-sales.mjs writes (rerun it, do not hand-edit)')

  return { rows: data.length, problems }
}

export function formatSales(result) {
  const lines = [`sales rows: ${result.rows}`, `sales problems: ${result.problems.length}`]
  for (const p of result.problems) {
    const where = p.row === null ? 'data/sales.csv' : `data/sales.csv row ${p.row}${p.column ? `, column ${p.column}` : ''}`
    lines.push(`sales problem: ${where}: ${p.message}`)
  }
  return lines.join('\n')
}
