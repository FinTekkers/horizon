// HO-851 guardrail 1: the design verdict parser (domain/js/designVerdict.js).
// `yes` or `no` with a one-line reason reads; anything else is unreadable —
// no line, two lines, no reason, a reason over the cap — and the caller then
// runs the design, never skips. The what-changed line of a design round reads
// the same way.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parseDesignVerdict, parseWhatChanged, VERDICT_REASON_MAX_CHARS } = await import('../../domain/js/designVerdict.js')

test('a yes or no verdict with a one-line reason reads; anything else is unreadable', () => {
  const cases = [
    ['design_needed: no — backend only', { needed: false, reason: 'backend only' }],
    ['Intro.\n\ndesign_needed: yes — adds a gate panel\n\nMore.', { needed: true, reason: 'adds a gate panel' }],
    ['design_needed: NO - server work only', { needed: false, reason: 'server work only' }],
    ['design_needed: Yes: new dialog', { needed: true, reason: 'new dialog' }],
    ['**design_needed:** no — farm only', { needed: false, reason: 'farm only' }],
    ['- design_needed: no – data migration', { needed: false, reason: 'data migration' }],
    ['design_needed: no —', 'unreadable'],
    ['design_needed: no', 'unreadable'],
    ['design_needed: maybe — not sure', 'unreadable'],
    ['design_needed: nope — x', 'unreadable'],
    ['No verdict here at all.', 'unreadable'],
    ['design_needed: no — a\ndesign_needed: no — a', 'unreadable'],
    ['design_needed: yes — a\ndesign_needed: no — b', 'unreadable'],
    [`design_needed: no — ${'x'.repeat(VERDICT_REASON_MAX_CHARS + 1)}`, 'unreadable'],
    ['', 'unreadable'],
    [null, 'unreadable'],
  ]
  for (const [input, want] of cases) {
    const got = parseDesignVerdict(input)
    if (want === 'unreadable') {
      assert.equal(typeof got.unreadable, 'string', `${JSON.stringify(input)} is unreadable`)
      assert.equal(Object.hasOwn(got, 'needed'), false)
    } else {
      assert.deepEqual({ needed: got.needed, reason: got.reason }, want, JSON.stringify(input))
    }
  }
})

test('a reason at the cap still reads', () => {
  const reason = 'x'.repeat(VERDICT_REASON_MAX_CHARS)
  assert.equal(parseDesignVerdict(`design_needed: no — ${reason}`).reason, reason)
})

test('the what-changed line of a design round, or null', () => {
  assert.equal(parseWhatChanged('**Canvas:** …\n\nNew canvas.\n\nwhat_changed: moved the gate panel left'), 'moved the gate panel left')
  assert.equal(parseWhatChanged('- **what_changed:** tightened the board'), 'tightened the board')
  assert.equal(parseWhatChanged('what_changed:   '), null)
  assert.equal(parseWhatChanged('No note.'), null)
  assert.equal(parseWhatChanged(undefined), null)
})
