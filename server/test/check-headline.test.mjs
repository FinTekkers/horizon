// HZ-373: what failFarmRun writes for a failure. A check failure's event
// shows its headline line only, cut at a word boundary within 200 chars, and
// keeps the whole message as its detail. Any other error is as before.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CHECK_HEADLINE_PREFIX, capWords, splitCheckError } from '../src/checkHeadline.js'

test('a check failure keeps its headline line as the cause, cut at a word boundary, and the whole error as detail', () => {
  const words = Array.from({ length: 30 }, (_, i) => `token${String(i).padStart(3, '0')}`)
  const first = `${CHECK_HEADLINE_PREFIX}e2e failed (exit 1): Error: ${words.join(' ')}`
  const error = `${first}\n(sh -c s="$(git show origin/main:scripts/checks/e2e.sh)" && bash -c "$s")\ndigest line`
  assert.ok(first.length >= 260, String(first.length))

  const { cause, detail } = splitCheckError(error)

  assert.ok(cause.length <= 200, cause)
  assert.ok(cause.endsWith('…'), cause)
  assert.ok(words.includes(cause.slice(0, -1).split(' ').at(-1)), cause)
  assert.ok(!cause.includes('sh -c') && !cause.includes('git show'), cause)
  assert.equal(detail, error)
})

test('an error that is not a check failure keeps today\'s 200-char cut and has no detail', () => {
  const error = `could not hand the step to the farm: ${'x'.repeat(300)}\nsecond line`

  assert.deepEqual(splitCheckError(error), { cause: error.slice(0, 200), detail: null })
  assert.deepEqual(splitCheckError(new Error('boom')), { cause: 'Error: boom', detail: null })
})

test('capWords leaves a short line alone and hard-cuts only a line with no space', () => {
  assert.equal(capWords('lint failed (exit 3)', 200), 'lint failed (exit 3)')
  const solid = 'x'.repeat(300)
  assert.equal(capWords(solid, 200), `${'x'.repeat(199)}…`)
})
