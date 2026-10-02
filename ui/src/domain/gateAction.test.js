// HZ-228: elapsedText's { seconds: false } form, the Board card's label.
// The default form is pinned by GateActionStatus.parity.test.jsx.

import { expect, test } from 'vitest'
import { elapsedText } from './gateAction'

const SINCE = '2026-10-02T10:00:00Z'
const at = (secs) => Date.parse(SINCE) + secs * 1000
const short = (secs) => elapsedText(SINCE, at(secs), { seconds: false })

test('minutes only, with an hours rollup from 60m', () => {
  expect(short(59)).toBe('<1m')
  expect(short(60)).toBe('1m')
  expect(short(59 * 60 + 59)).toBe('59m')
  expect(short(60 * 60)).toBe('1h 00m')
  expect(short(65 * 60)).toBe('1h 05m')
})

test('a since in the future (clock skew) never goes negative', () => {
  expect(short(-90)).toBe('<1m')
})

test('the default form is unchanged', () => {
  expect(elapsedText(SINCE, at(192))).toBe('3m 12s')
  expect(elapsedText(SINCE, at(45))).toBe('45s')
})
