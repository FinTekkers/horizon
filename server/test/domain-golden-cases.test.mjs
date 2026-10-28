// HZ-541: domain/js/goldenCases.js reads a golden_cases sub-step's set the
// way domain/goldenCases.schema.json defines it — the last fenced block wins,
// and a set with any bad case is refused whole, each error naming its case.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractGoldenCases, metricLineFor, parseSource, validateGoldenCases } from '../../domain/js/goldenCases.js'

const CASE = { id: 'c1', inputs: { x: 1 }, measure: 'y', expected: 2, tolerance: { abs: 0.5 }, source: 'fintekkers-docs__spec-0a1b2c3d4e#2-1-scope' }
const fence = (block) => '```json golden-cases\n' + JSON.stringify(block) + '\n```'

test('the last golden-cases block wins, and a valid set reads back in one key order', () => {
  const artifact = `${fence({ cases: [{ ...CASE, id: 'old' }] })}\n\nrevised:\n${fence({ cases: [{ source: CASE.source, tolerance: { rel: 0.1, abs: 1 }, expected: 'AAA', measure: 'rating', inputs: {}, id: 'c2' }] })}`
  const { cases, errors } = extractGoldenCases(artifact)
  assert.deepEqual(errors, [])
  assert.deepEqual(JSON.stringify(cases), JSON.stringify([{ id: 'c2', inputs: {}, measure: 'rating', expected: 'AAA', tolerance: { abs: 1, rel: 0.1 }, source: CASE.source }]))
})

test('no block, bad JSON and an empty set are errors', () => {
  assert.deepEqual(extractGoldenCases('no block here').errors, ['no golden-cases block'])
  assert.match(extractGoldenCases('```json golden-cases\n{oops\n```').errors[0], /not valid JSON/)
  assert.deepEqual(validateGoldenCases({ cases: [] }).errors, ['cases is empty'])
  assert.match(validateGoldenCases({ cases: Array.from({ length: 201 }, (_, i) => ({ ...CASE, id: `c${i}` })) }).errors[0], /more than 200/)
})

test('one bad case refuses the whole set, naming the case', () => {
  const { cases, errors } = validateGoldenCases({
    cases: [CASE, { ...CASE }, { ...CASE, id: 'c3', tolerance: {} }, { ...CASE, id: 'c4', source: 'no-section' }, { ...CASE, id: 'c5', expected: null, extra: 1 }],
  })
  assert.deepEqual(cases, [])
  assert.deepEqual(errors, [
    'case "c1": duplicate id',
    'case "c3": tolerance needs abs or rel',
    'case "c4": source must be <doc>#<section>',
    'case "c5": unknown key "extra"',
    'case "c5": expected must be a number or a string',
  ])
})

test('parseSource and metricLineFor', () => {
  assert.deepEqual(parseSource('bond-math#accrual'), { doc: 'bond-math', section: 'accrual' })
  assert.equal(parseSource('Bond#x'), null)
  assert.equal(metricLineFor('1. Fast.\n2. Every `golden_cases` case passes.\n3. golden_cases again.'), 2)
  assert.equal(metricLineFor('1. Fast.'), null)
  assert.equal(metricLineFor(null), null)
})
