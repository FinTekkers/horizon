// HZ-951: stream-reporter.test.mjs runs this file under `node --test`. One
// top-level pass and one failure inside nested describes. Not a *.test.mjs
// file, so `npm test` never runs it itself.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

test('passes', () => {})

describe('outer', () => {
  describe('inner', () => {
    test('fails', () => {
      assert.strictEqual(1, 2)
    })
  })
})
