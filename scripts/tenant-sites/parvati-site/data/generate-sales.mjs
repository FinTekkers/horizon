// Writes data/sales.csv: 300 fictional Manhattan sales, Nov 2024 to Oct 2026.
//
//   node data/generate-sales.mjs              rewrites data/sales.csv
//   node data/generate-sales.mjs --out <file> writes somewhere else
//
// The output is a pure function of SEED and the tables below: a seeded PRNG,
// no Math.random and no clock, so every run writes the same bytes. Addresses
// name real streets but carry no building number ("Riverside Drive at West
// 86th Street"), and the first line says the data is fictional.

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SEED = 20241101
export const COLUMNS = ['sale_id', 'address', 'unit', 'neighbourhood', 'type', 'building', 'sq_ft', 'bedrooms', 'bathrooms', 'monthly_charges_usd', 'sale_price_usd', 'sale_date']
export const FICTIONAL_NOTE = '# FICTIONAL DATA: invented sales for a fictional brokerage (Parvati Real Estate). Not real transactions, buildings or people. Skip this line when parsing.'
export const FIRST_DATE = '2024-11-01'
export const LAST_DATE = '2026-10-31'

// The neighbourhoods on the Neighbourhoods design (Neighbourhoods.dc.html):
// the four featured ones, then "Also across Manhattan".
// quota: [co-op, condo, townhouse]. ppsf: median sale price per square foot
// for a co-op; condos scale from it by 1.25, townhouses by `townhouse` (1.3
// where unset). prewar: share of apartment sales in prewar buildings.
export const NEIGHBOURHOODS = [
  { name: 'Upper West Side', quota: [44, 13, 3], ppsf: 1300, prewar: 0.7, townhouse: 1.2,
    avenues: ['Central Park West', 'Riverside Drive', 'West End Avenue', 'Broadway', 'Amsterdam Avenue', 'Columbus Avenue'],
    streets: ['West 72nd Street', 'West 76th Street', 'West 79th Street', 'West 81st Street', 'West 86th Street', 'West 89th Street', 'West 93rd Street', 'West 96th Street', 'West 102nd Street'] },
  { name: 'Upper East Side', quota: [25, 11, 4], ppsf: 1400, prewar: 0.6, townhouse: 1.7,
    avenues: ['Fifth Avenue', 'Park Avenue', 'Madison Avenue', 'Lexington Avenue', 'East End Avenue', 'York Avenue'],
    streets: ['East 66th Street', 'East 70th Street', 'East 74th Street', 'East 79th Street', 'East 83rd Street', 'East 86th Street', 'East 92nd Street'] },
  { name: 'West Village', quota: [12, 6, 3], ppsf: 1800, prewar: 0.75, townhouse: 1.4,
    avenues: ['Hudson Street', 'Greenwich Street', 'West Street', 'Seventh Avenue South'],
    streets: ['Bank Street', 'Perry Street', 'Charles Street', 'Jane Street', 'Christopher Street', 'Bethune Street'] },
  { name: 'Greenwich Village', quota: [12, 6, 3], ppsf: 1700, prewar: 0.65, townhouse: 1.4,
    avenues: ['Fifth Avenue', 'University Place', 'Sixth Avenue', 'Broadway'],
    streets: ['West 10th Street', 'West 11th Street', 'West 12th Street', 'East 9th Street', 'Washington Place', 'Waverly Place'] },
  { name: 'Tribeca', quota: [2, 19, 1], ppsf: 1850, prewar: 0.6,
    avenues: ['Hudson Street', 'Greenwich Street', 'West Broadway', 'Church Street'],
    streets: ['Franklin Street', 'Harrison Street', 'Leonard Street', 'Duane Street', 'North Moore Street', 'Laight Street'] },
  { name: 'Financial District', quota: [1, 17, 0], ppsf: 1050, prewar: 0.45,
    avenues: ['Broadway', 'Water Street', 'Pearl Street', 'William Street'],
    streets: ['Wall Street', 'John Street', 'Maiden Lane', 'Pine Street', 'Beaver Street', 'Exchange Place'] },
  { name: 'SoHo', quota: [4, 12, 0], ppsf: 1750, prewar: 0.7,
    avenues: ['West Broadway', 'Broadway', 'Mercer Street', 'Greene Street'],
    streets: ['Spring Street', 'Prince Street', 'Broome Street', 'Grand Street', 'Wooster Street'] },
  { name: 'Chelsea', quota: [6, 9, 1], ppsf: 1450, prewar: 0.4,
    avenues: ['Eighth Avenue', 'Ninth Avenue', 'Tenth Avenue', 'Seventh Avenue'],
    streets: ['West 16th Street', 'West 19th Street', 'West 21st Street', 'West 22nd Street', 'West 24th Street'] },
  { name: 'Gramercy Park', quota: [9, 5, 1], ppsf: 1350, prewar: 0.6,
    avenues: ['Irving Place', 'Lexington Avenue', 'Third Avenue', 'Park Avenue South'],
    streets: ['East 18th Street', 'East 19th Street', 'East 20th Street', 'East 21st Street', 'East 22nd Street'] },
  { name: 'Murray Hill', quota: [8, 6, 1], ppsf: 1050, prewar: 0.35,
    avenues: ['Park Avenue', 'Lexington Avenue', 'Third Avenue', 'Second Avenue'],
    streets: ['East 34th Street', 'East 35th Street', 'East 36th Street', 'East 37th Street', 'East 38th Street'] },
  { name: 'Battery Park City', quota: [0, 12, 0], ppsf: 1200, prewar: 0,
    avenues: ['River Terrace', 'South End Avenue', 'North End Avenue', 'Battery Place'],
    streets: ['Warren Street', 'Murray Street', 'Vesey Street', 'Albany Street', 'Rector Place'] },
  { name: 'Lower East Side', quota: [7, 8, 0], ppsf: 1150, prewar: 0.55,
    avenues: ['Essex Street', 'Ludlow Street', 'Orchard Street', 'Clinton Street'],
    streets: ['Rivington Street', 'Stanton Street', 'Delancey Street', 'Broome Street', 'Grand Street'] },
  { name: 'Harlem', quota: [4, 6, 6], ppsf: 800, prewar: 0.7, townhouse: 1,
    avenues: ['Malcolm X Boulevard', 'Adam Clayton Powell Jr. Boulevard', 'Frederick Douglass Boulevard', 'Convent Avenue', 'St. Nicholas Avenue'],
    streets: ['West 118th Street', 'West 122nd Street', 'West 126th Street', 'West 135th Street', 'West 139th Street', 'West 144th Street'] },
  { name: 'Morningside Heights', quota: [10, 3, 0], ppsf: 950, prewar: 0.8,
    avenues: ['Riverside Drive', 'Claremont Avenue', 'Broadway', 'Amsterdam Avenue'],
    streets: ['West 110th Street', 'West 113th Street', 'West 116th Street', 'West 119th Street', 'West 120th Street'] },
]

const TYPES = ['co-op', 'condo', 'townhouse']

// mulberry32: a small, well-known 32-bit PRNG. Same seed, same sequence.
function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DAY_MS = 86400000

export function generateSales(seed = SEED) {
  const rand = prng(seed)
  const between = (lo, hi) => lo + rand() * (hi - lo)
  const int = (lo, hi) => Math.floor(between(lo, hi + 1))
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const roundTo = (n, step) => Math.round(n / step) * step

  const first = Date.parse(`${FIRST_DATE}T00:00:00Z`)
  const days = (Date.parse(`${LAST_DATE}T00:00:00Z`) - first) / DAY_MS

  const sales = []
  for (const hood of NEIGHBOURHOODS) {
    hood.quota.forEach((count, i) => {
      for (let n = 0; n < count; n++) sales.push(makeSale(hood, TYPES[i]))
    })
  }

  function makeSale(hood, type) {
    const address = `${pick(hood.avenues)} at ${pick(hood.streets)}`
    let bedrooms, sqFt, bathrooms, building, unit
    if (type === 'townhouse') {
      bedrooms = int(3, 6)
      sqFt = roundTo(between(2600, 5600), 10)
      bathrooms = bedrooms - 1 + 0.5 * int(0, 2)
      building = 'prewar walk-up'
      unit = 'Whole house'
    } else {
      bedrooms = pick([0, 1, 1, 1, 2, 2, 2, 3, 3, 4])
      const [lo, hi] = [[420, 620], [620, 900], [950, 1450], [1450, 2200], [2200, 3200]][bedrooms]
      sqFt = roundTo(between(lo, hi), 5)
      bathrooms = Math.max(1, bedrooms) + (bedrooms >= 2 ? 0.5 * int(0, 1) : 0)
      const prewar = rand() < hood.prewar
      const floors = prewar ? int(4, 16) : int(6, 40)
      const walkUp = prewar && floors <= 6 && rand() < 0.35
      building = `${prewar ? 'prewar' : 'postwar'} ${walkUp ? 'walk-up' : 'elevator'}`
      const floor = walkUp ? int(1, 5) : int(2, floors)
      unit = `${floor}${'ABCDEFGH'[int(0, 7)]}`
    }
    const typeFactor = { 'co-op': 1, condo: 1.25, townhouse: hood.townhouse ?? 1.3 }[type]
    const ppsf = hood.ppsf * typeFactor * between(0.82, 1.2)
    const price = roundTo(sqFt * ppsf, 5000)
    // Co-op maintenance carries the building's mortgage and taxes; condo
    // common charges plus taxes run by the foot; a townhouse is taxes only.
    const monthly = type === 'co-op' ? price * between(0.0011, 0.0017)
      : type === 'condo' ? sqFt * between(1.6, 2.6)
        : price * between(0.0003, 0.0005)
    const saleDate = new Date(first + int(0, days) * DAY_MS).toISOString().slice(0, 10)
    return {
      address, unit, neighbourhood: hood.name, type, building,
      sq_ft: sqFt, bedrooms, bathrooms,
      monthly_charges_usd: roundTo(monthly, 10), sale_price_usd: price, sale_date: saleDate,
    }
  }

  // Oldest first; ties keep generation order, so the sort is stable across runs.
  sales.sort((a, b) => a.sale_date.localeCompare(b.sale_date))
  return sales.map((s, i) => ({ sale_id: `PV-${String(i + 1).padStart(4, '0')}`, ...s }))
}

export function salesCsv(sales = generateSales()) {
  const lines = [FICTIONAL_NOTE, COLUMNS.join(',')]
  for (const sale of sales) {
    const cells = COLUMNS.map((c) => String(sale[c]))
    // Plain comma-split CSV: no quoting, so no value may hold a comma or quote.
    for (const cell of cells) if (/[",\n]/.test(cell)) throw new Error(`generate-sales: value needs quoting: ${cell}`)
    lines.push(cells.join(','))
  }
  return lines.join('\n') + '\n'
}

export const DEFAULT_OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sales.csv')

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--out')
  const out = i === -1 ? DEFAULT_OUT : process.argv[i + 1]
  if (!out) {
    console.error('generate-sales: --out needs a file path')
    process.exit(2)
  }
  writeFileSync(out, salesCsv())
  console.log(`wrote ${out}`)
}
