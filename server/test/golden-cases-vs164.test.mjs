// HZ-972 metric 5 and guardrail 2: the dry run of FinTekkers' quant
// golden-cases sub-step on VS-164's three reference cases, committed verbatim
// as fixtures/hz-972-vs164-dry-run.md (how it was produced: fixtures/README.md).
// Its golden-cases block passes the domain/goldenCases.schema.json checks;
// every citation resolves to a section the extract job indexes from one of the
// four FinTekkers library PDFs; and each expected value is within its stated
// tolerance of the hand-computed reference value copied below.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extractGoldenCases, parseSource, validateGoldenCases } from '../../domain/js/goldenCases.js'
import { knowledgeSlug } from '../src/knowledgeDocs.js'
import { DOC_NAMES, LIBRARY_REPO, extractedSectionIds, pdfPath } from './helpers/fintekkersKnowledge.mjs'

const ARTIFACT = readFileSync(new URL('./fixtures/hz-972-vs164-dry-run.md', import.meta.url), 'utf8')
const SCHEMA = JSON.parse(readFileSync(new URL('../../domain/goldenCases.schema.json', import.meta.url), 'utf8'))
// Draft-07 ajv, borrowed from fastify's install as openapi-spec-valid.test.mjs does.
const { default: Ajv } = await import('ajv')
const validateSchema = new Ajv({ allErrors: true }).compile(SCHEMA)

// VS-164's three reference cases: the CoreWeave 9.25% 1 Jun 2030 note
// (USU2069EAA83, semiannual, ACT/ACT ICMA). The values were hand-computed by
// the owner on 25 Nov 2026 and recorded in FinTekkers item LS-237 ("golden
// values computed independently: ... modified duration 2.637 ... at settlement
// 2026-11-30"; "price 85.00, settlement 2027-03-01: yield 15.2529% ACT/ACT,
// modified duration 2.5790"), the item whose wrong modified duration VS-164
// fixes. They are never taken from valuation-service code.
const REFERENCES = {
  'cw-near-coupon-mod-duration': { measure: /modified_duration/, value: 2.637, settlement: '2026-11-30', price: 81.375 },
  'cw-mid-period-ytm': { measure: /yield_to_maturity/, value: 15.2529, settlement: '2027-03-01', price: 85 },
  'cw-mid-period-mod-duration': { measure: /modified_duration/, value: 2.579, settlement: '2027-03-01', price: 85 },
}
// The loosest tolerance a case may state: VS-164 metric 1 asks for YTM within
// 0.0005 percentage points and modified duration within 0.0005 years.
const MAX_ABS = 0.0005

const allowance = (tolerance, reference) => Math.max(tolerance.abs ?? 0, (tolerance.rel ?? 0) * Math.abs(reference))
const withinTolerance = (entry, reference) => Math.abs(entry.expected - reference) <= allowance(entry.tolerance, reference) + 1e-12

const block = () => JSON.parse([...ARTIFACT.matchAll(/```json golden-cases\n([\s\S]*?)\n```/g)].at(-1)[1])
const { cases, errors } = extractGoldenCases(ARTIFACT)

test('the dry run block passes the golden-cases schema', () => {
  assert.deepEqual(errors, [])
  assert.deepEqual(validateGoldenCases(block()).errors, [])
  assert.ok(validateSchema(block()), JSON.stringify(validateSchema.errors))
})

test('it holds exactly VS-164’s three reference cases, each with a numeric expected value and its inputs', () => {
  assert.deepEqual(
    cases.map((c) => c.id),
    Object.keys(REFERENCES),
  )
  for (const entry of cases) {
    const reference = REFERENCES[entry.id]
    assert.equal(typeof entry.expected, 'number', entry.id)
    assert.match(entry.measure, reference.measure, entry.id)
    assert.equal(entry.inputs.settlement, reference.settlement, entry.id)
    assert.equal(entry.inputs.clean_price, reference.price, entry.id)
    assert.equal(entry.inputs.maturity, '2030-06-01', entry.id)
    assert.equal(entry.inputs.coupon_rate_pct, 9.25, entry.id)
  }
})

test('every citation resolves to an indexed section of one of the four library documents, never to code', () => {
  const slugs = Object.fromEntries(DOC_NAMES.map((name) => [knowledgeSlug(LIBRARY_REPO, pdfPath(name)), name]))
  const indexed = extractedSectionIds()
  for (const entry of cases) {
    const source = parseSource(entry.source)
    assert.ok(source, entry.id)
    assert.ok(Object.hasOwn(slugs, source.doc), `${entry.id}: ${source.doc} is not a FinTekkers library document`)
    assert.ok(indexed[slugs[source.doc]].includes(source.section), `${entry.id}: ${source.section} is not indexed in ${slugs[source.doc]}`)
    assert.doesNotMatch(entry.source, /valuation-service|src-/, entry.id)
  }
})

test('each tolerance is no looser than VS-164 allows, and each expected value is within it of the reference', () => {
  for (const entry of cases) {
    const reference = REFERENCES[entry.id].value
    assert.ok(allowance(entry.tolerance, reference) <= MAX_ABS, `${entry.id}: tolerance ${JSON.stringify(entry.tolerance)} is looser than ${MAX_ABS}`)
    assert.ok(withinTolerance(entry, reference), `${entry.id}: ${entry.expected} vs reference ${reference}`)
  }
})

test('the check fails on a case nudged past its tolerance', () => {
  for (const entry of cases) {
    const reference = REFERENCES[entry.id].value
    const nudged = { ...entry, expected: reference + 2 * allowance(entry.tolerance, reference) }
    assert.equal(withinTolerance(nudged, reference), false, entry.id)
  }
})
