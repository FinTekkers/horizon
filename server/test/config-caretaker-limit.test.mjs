// HZ-271 metric 3: the caretaker's hourly action limit is configurable.
// config.js reads process.env once, at import, so the override is set first.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CARETAKER_HOURLY_LIMIT = '25'
// The cap must not be raisable: an env value is ignored.
process.env.REVIEW_CYCLE_CAP = '99'

const { CARETAKER_HOURLY_LIMIT, parseCaretakerHourlyLimit, REVIEW_CYCLE_CAP } = await import('../src/config.js')

test('CARETAKER_HOURLY_LIMIT takes the environment override', () => {
  assert.equal(CARETAKER_HOURLY_LIMIT, 25)
})

test('unset means 10', () => {
  assert.equal(parseCaretakerHourlyLimit(undefined), 10)
  assert.equal(parseCaretakerHourlyLimit(''), 10)
})

for (const raw of ['0', '-3', '2.5', 'ten', 'Infinity']) {
  test(`an invalid value (${raw}) falls back to 10`, () => {
    assert.equal(parseCaretakerHourlyLimit(raw), 10)
  })
}

test('the review-cycle cap is not read from the environment', () => {
  assert.equal(REVIEW_CYCLE_CAP, 3)
})
