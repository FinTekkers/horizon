// HZ-228: elapsedText's { seconds: false } form, the Board card's label.
// The default form is pinned by GateActionStatus.parity.test.jsx.

import { expect, test } from 'vitest'
import { elapsedText, gateActionBusy, gateActionView, isRetryable, RETRY_STATES } from './gateAction'

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

// HZ-822: a pre-merge check stopped because its PR merged on GitHub.
test('a superseded pre-merge row reads as merged on GitHub, is not busy and offers no Retry', () => {
  const action = { kind: 'premerge', state: 'superseded', reason: 'PR merged on GitHub' }
  expect(gateActionView(action, 158)).toEqual({ tone: 'ok', text: 'Merged on GitHub — pre-merge check stopped' })
  expect(gateActionBusy({ gateAction: action })).toBe(false)
  expect(isRetryable(action)).toBe(false)
  expect(RETRY_STATES).not.toContain('superseded')
})
