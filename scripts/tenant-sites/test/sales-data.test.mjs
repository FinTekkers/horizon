// Metric 1: data/sales.csv. 300 rows, the 12 columns in order, every cell
// filled, at least 40 Upper West Side co-ops, and the same bytes every time
// the seeded generator runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { SITE } from './helpers.mjs'

const CSV = path.join(SITE, 'data', 'sales.csv')
const GENERATOR = path.join(SITE, 'data', 'generate-sales.mjs')
const HEADERS = ['sale_id', 'address', 'unit', 'neighbourhood', 'type', 'building', 'sq_ft', 'bedrooms', 'bathrooms', 'monthly_charges_usd', 'sale_price_usd', 'sale_date']

function readSales() {
  const [note, header, ...data] = readFileSync(CSV, 'utf8').trimEnd().split('\n')
  const rows = data.map((line) => Object.fromEntries(line.split(',').map((v, i) => [HEADERS[i] ?? `extra${i}`, v])))
  return { note, header: header.split(','), rows, data }
}

test('sales.csv has 300 rows, the 12 columns in order, every cell filled and 40+ UWS co-ops', () => {
  const { header, rows, data } = readSales()
  assert.deepEqual(header, HEADERS)
  assert.equal(rows.length, 300)
  data.forEach((line, i) => {
    const cells = line.split(',')
    assert.equal(cells.length, HEADERS.length, `row ${i + 1}: ${line}`)
    cells.forEach((cell, c) => assert.notEqual(cell.trim(), '', `row ${i + 1}, column ${HEADERS[c]} is empty`))
  })
  const uwsCoops = rows.filter((r) => r.neighbourhood === 'Upper West Side' && r.type === 'co-op')
  assert.ok(uwsCoops.length >= 40, `only ${uwsCoops.length} Upper West Side co-op rows`)
})

test('sales.csv values are in range: types, buildings, dates, ids, numbers, addresses', () => {
  const { rows } = readSales()
  assert.equal(new Set(rows.map((r) => r.sale_id)).size, rows.length, 'sale_id values are unique')
  for (const r of rows) {
    const at = `${r.sale_id}`
    assert.ok(['co-op', 'condo', 'townhouse'].includes(r.type), `${at} type ${r.type}`)
    assert.match(r.building, /^(prewar|postwar) (elevator|walk-up)$/, at)
    assert.match(r.sale_date, /^\d{4}-\d{2}-\d{2}$/, at)
    assert.ok(r.sale_date >= '2024-11-01' && r.sale_date <= '2026-10-31', `${at} sale_date ${r.sale_date}`)
    for (const col of ['sq_ft', 'bathrooms', 'monthly_charges_usd', 'sale_price_usd']) {
      assert.ok(Number(r[col]) > 0, `${at} ${col} ${r[col]}`)
    }
    assert.ok(Number.isInteger(Number(r.bedrooms)) && Number(r.bedrooms) >= 0, `${at} bedrooms ${r.bedrooms}`)
    assert.ok(Number(r.sale_price_usd) >= 300000 && Number(r.sale_price_usd) <= 30000000, `${at} price ${r.sale_price_usd}`)
    // Real street names, no building number.
    assert.doesNotMatch(r.address, /^\d/, `${at} address ${r.address}`)
  }
})

test('sales.csv says it is fictional, and no page or stylesheet links to it', () => {
  const { note } = readSales()
  assert.match(note, /^# FICTIONAL DATA/)
  const sources = readdirSync(SITE, { recursive: true }).filter((f) => /\.(html|css)$/.test(f))
  assert.ok(sources.length >= 6, sources.join(', '))
  for (const file of sources) {
    assert.doesNotMatch(readFileSync(path.join(SITE, file), 'utf8'), /sales\.csv|data\//, file)
  }
})

test('generate-sales.mjs writes byte-identical output on every run, matching the committed file', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'parvati-sales-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const outputs = ['a.csv', 'b.csv'].map((name) => {
    const out = path.join(dir, name)
    const r = spawnSync(process.execPath, [GENERATOR, '--out', out], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return readFileSync(out)
  })
  assert.ok(outputs[0].equals(outputs[1]), 'two runs differ')
  assert.ok(outputs[0].equals(readFileSync(CSV)), 'generator output differs from the committed data/sales.csv')
})
