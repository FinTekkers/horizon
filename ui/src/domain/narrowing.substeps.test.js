// HZ-540: the board's "At a sub-step" filter. Off by default, so an item at
// no sub-step — and every board before sub-steps — is narrowed exactly as
// before; on, it keeps only items at a sub-step. Its chip in the filter bar
// shows only while it is on.

import { expect, test } from 'vitest'
import { DEFAULT_VIEW, isAtSubstep, isNarrowing, narrowItems, validView } from './narrowing'
import { activeChips, chipPatch } from './filterChips'

const AUDIT = { id: 'impl-audit', label: 'Audit the change', anchor: 11 }
const AT = { id: 'AC-1', cursor: 11, priority: 'Medium', substeps: [AUDIT], substep_cursor: 'impl-audit' }
const PLAIN = { id: 'AC-2', cursor: 11, priority: 'Medium' }
const SNAPSHOT_ONLY = { id: 'AC-3', cursor: 11, priority: 'Medium', substeps: [AUDIT], substep_cursor: null }

test('off by default: nothing is narrowed and no chip shows', () => {
  expect(DEFAULT_VIEW.substep).toBe(false)
  expect(isNarrowing(DEFAULT_VIEW)).toBe(false)
  expect(narrowItems([AT, PLAIN, SNAPSHOT_ONLY], DEFAULT_VIEW)).toEqual([AT, PLAIN, SNAPSHOT_ONLY])
  expect(activeChips(DEFAULT_VIEW, []).some((c) => c.key === 'substep')).toBe(false)
})

test('only an item whose cursor is on its sub-step’s anchor is at it', () => {
  expect([AT, PLAIN, SNAPSHOT_ONLY, { ...AT, cursor: 12 }].map(isAtSubstep)).toEqual([true, false, false, false])
})

test('on, it keeps the items at a sub-step, with a removable chip', () => {
  const view = validView({ substep: true })
  expect(isNarrowing(view)).toBe(true)
  expect(narrowItems([AT, PLAIN, SNAPSHOT_ONLY], view)).toEqual([AT])
  expect(activeChips(view, [])).toContainEqual({ key: 'substep', label: 'At a sub-step' })
  expect(chipPatch('substep')).toEqual({ view: { substep: false } })
})

test('a stored view with a bad value reads as off', () => {
  expect(validView({ substep: 'yes' }).substep).toBe(false)
})
