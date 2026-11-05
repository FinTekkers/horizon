// Tests for mockApi, covering independent concerns that landed together:
//
//   HZ-711 — parity between mockApi's moveItem and the server's one move: a
//   Return to or Retry goes only to a target the item's `moves` offer (as the
//   server sent them, written out in the mock's seed), anything else is the
//   server's 409 bad_target_key, and the answer's restart is numbered and
//   named by step key the way the server does — or mock mode stops being a
//   faithful stand-in for the real backend. The default target and the rework
//   rules are the server's alone, so nothing here tests them.
//
//   HZ-62 — mock mode's approveGate must report the same { ok, closed }
//   shape the server does, so App.jsx's post-approval navigation behaves
//   identically whether VITE_MOCK is on or off.
//
//   HZ-135 — createItem's priority default must be domain/priorities.json's,
//   the same one POST /api/items answers with. Same parity concern as
//   HZ-711's, on the one field this item moved.
//
// Each test claims one seeded fixture item and never revisits it, since
// `items` is module-level state shared across tests in this file.

import { expect, test, vi, afterEach } from 'vitest'
import * as mockApi from './mockApi'
import { moveItem, getRestartSent, getItems } from './mockApi'
import { STEPS, endIndex, stepIndexOf } from '../../../domain/js/lifecycle.js'
import { PRIORITIES, DEFAULT_PRIORITY } from '../../../domain/js/priorities.js'

const findItem = (id) => getItems().find((it) => it.id === id)

// The server's refusal of a target the item's moves do not offer.
async function expectRefused(call) {
  const err = await call.catch((e) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.message).toBe('bad_target_key')
  expect(err.status).toBe(409)
}

test('Return to: an offered earlier step moves the item there and answers its restart by key, attempt 2', async () => {
  vi.useFakeTimers()
  const before = findItem('BF-140')
  expect(STEPS[before.cursor].key).toBe('change.review-before-exec')
  expect(before.moves.targets.map((t) => t.key)).toContain('change.draft-plan')

  const result = await moveItem('BF-140', { action: 'return', to: 'change.draft-plan', note: 'the plan skips a step' })

  const after = findItem('BF-140')
  expect(after.cursor).toBe(stepIndexOf('change.draft-plan'))
  expect(result).toEqual({ ok: true, item: after, restart: { stepKey: 'change.draft-plan', attempt: 2 } })
  expect(getRestartSent('BF-140')).toEqual({ stepKey: 'change.draft-plan', attempt: 2 })
  // The item moved, so the seed's moves no longer hold: the mock offers none,
  // and a second move is the server's refusal.
  expect(after.moves).toBeNull()
  await expectRefused(moveItem('BF-140', { action: 'return', to: 'change.draft-plan' }))
  expect(findItem('BF-140').cursor).toBe(stepIndexOf('change.draft-plan'))
  vi.clearAllTimers()
})

test('Retry: the offered current agent step restarts in place with attempt 2, and a target not offered is refused first', async () => {
  vi.useFakeTimers()
  const before = findItem('BF-119')
  expect(STEPS[before.cursor].key).toBe('change.arch-review')
  expect(STEPS[before.cursor].kind).toBe('agent')

  // Not in BF-119's moves: refused, nothing changes.
  await expectRefused(moveItem('BF-119', { action: 'return', to: 'change.define-outcome' }))
  expect(findItem('BF-119').cursor).toBe(before.cursor)
  expect(getRestartSent('BF-119')).toBeNull()

  const result = await moveItem('BF-119', { action: 'retry', to: 'change.arch-review' })
  expect(findItem('BF-119').cursor).toBe(before.cursor)
  expect(result.restart).toEqual({ stepKey: 'change.arch-review', attempt: 2 })
  expect(getRestartSent('BF-119')).toEqual({ stepKey: 'change.arch-review', attempt: 2 })
  vi.clearAllTimers()
})

test('an earlier step the moves do not offer is refused with 409 bad_target_key and leaves the item where it was', async () => {
  const before = findItem('BF-097')
  expect(STEPS[before.cursor].key).toBe('change.accept-code')
  expect(before.moves.targets.map((t) => t.key)).not.toContain('change.draft-plan')

  await expectRefused(moveItem('BF-097', { action: 'return', to: 'change.draft-plan' }))
  // An offered key under the wrong action is not offered either.
  await expectRefused(moveItem('BF-097', { action: 'retry', to: 'change.implement' }))
  expect(findItem('BF-097').cursor).toBe(before.cursor)
  expect(findItem('BF-097').moves).toEqual(before.moves)
})

test('a step at or after the current gate is refused (no forward moves, no same-gate loops)', async () => {
  const before = findItem('BF-128')
  expect(STEPS[before.cursor].key).toBe('change.approve-prioritize')

  await expectRefused(moveItem('BF-128', { action: 'return', to: 'change.approve-prioritize' }))
  await expectRefused(moveItem('BF-128', { action: 'return', to: 'change.plan-options' }))
  expect(findItem('BF-128').cursor).toBe(before.cursor)
})

test('an item whose seed carries no moves offers none, so every move is refused', async () => {
  const before = findItem('BF-102')
  expect(before.moves).toBeNull()

  await expectRefused(moveItem('BF-102', { action: 'retry', to: STEPS[before.cursor].key }))
  await expectRefused(moveItem('BF-102', { action: 'return', to: 'change.implement' }))
  expect(findItem('BF-102').cursor).toBe(before.cursor)
})

afterEach(() => {
  vi.useRealTimers()
})

test('approving an intermediate gate reports closed: false', async () => {
  vi.useFakeTimers()
  // BF-131 seeds at cursor 5 — "Approve the high-level design", not the last gate.
  const before = mockApi.getItems().find((it) => it.id === 'BF-131')
  expect(STEPS[before.cursor].label).toBe('Approve the high-level design')

  const result = await mockApi.approveGate('BF-131', '')

  expect(result).toEqual({ ok: true, closed: false })
  expect(mockApi.getItems().find((it) => it.id === 'BF-131').cursor).toBe(before.cursor + 1)
  vi.clearAllTimers()
})

test('approving the closing gate reports closed: true', async () => {
  vi.useFakeTimers()
  // BF-090 seeds at cursor 15 — "Review the work & close", the last gate.
  const before = mockApi.getItems().find((it) => it.id === 'BF-090')
  expect(before.cursor).toBe(endIndex('change') - 1)
  expect(STEPS[before.cursor].label).toBe('Review the work & close')

  const result = await mockApi.approveGate('BF-090', '')

  expect(result).toEqual({ ok: true, closed: true })
  expect(mockApi.getItems().find((it) => it.id === 'BF-090').cursor).toBe(endIndex('change'))
  vi.clearAllTimers()
})

// ---- HZ-95: dependents/blockedBy shape parity with the server payload ----
// (server/src/store.js's dependencyFields: { id, title, abandoned } entries)

test('every item exposes blockedBy and dependents arrays, even when empty, matching the server shape', () => {
  for (const it of mockApi.getItems()) {
    expect(Array.isArray(it.blockedBy)).toBe(true)
    expect(Array.isArray(it.dependents)).toBe(true)
    for (const entry of [...it.blockedBy, ...it.dependents]) {
      expect(entry).toEqual(expect.objectContaining({ id: expect.any(String), title: expect.any(String), abandoned: expect.any(Boolean) }))
    }
  }
})

test('the mock seeds one item with a blocker, one with dependents, and one with both, so the UI has real fixtures to render', () => {
  const withBlocker = findItem('BF-131')
  expect(withBlocker.blockedBy.length).toBeGreaterThan(0)
  expect(withBlocker.dependents.length).toBeGreaterThan(0)

  const withDependentsOnly = findItem('BF-128')
  expect(withDependentsOnly.blockedBy.length).toBe(0)
  expect(withDependentsOnly.dependents.length).toBeGreaterThan(0)

  const withNeither = findItem('BF-145')
  expect(withNeither.blockedBy.length).toBe(0)
  expect(withNeither.dependents.length).toBe(0)
})

// ---- HZ-135: createItem's priority, the offline half of the API seam ----
//
// server/test/api-priority-enum-derived.test.mjs pins POST /api/items' enum AND
// its default to domain/priorities.json. mockApi is that route's stand-in when
// VITE_MOCK is on, and its `priority = DEFAULT_PRIORITY` default had no test at
// all — so it could quietly drift back to a hand-typed value and only offline
// users would ever see the difference.
//
// Fake timers because createItem kicks off the mock agent simulation
// (runAgents → setTimeout), exactly as the approveGate cases above do. Both
// expectations read the value off the binding rather than naming it, which is
// what makes this a derivation check and not a second declaration.

test('createItem with no priority stores the declared default, the same one POST /api/items uses', async () => {
  vi.useFakeTimers()
  const { id } = await mockApi.createItem({
    title: 'Offline item, no priority chosen',
    outcome: 'The mock has to answer like the real route.',
    metric: 'The stored priority is the declared default.',
  })
  expect(findItem(id).priority).toBe(DEFAULT_PRIORITY)
  vi.clearAllTimers()
})

test('createItem honours an explicitly chosen priority — the default must not overwrite the picker', async () => {
  vi.useFakeTimers()
  // Deliberately not the default: an item reading back as the default proves
  // nothing, since that is what it would carry if the argument were dropped.
  const chosen = PRIORITIES.find((value) => value !== DEFAULT_PRIORITY)
  expect(chosen, 'the vocabulary offers no priority other than the default').toBeTruthy()

  const { id } = await mockApi.createItem({
    title: 'Offline item, priority chosen in the picker',
    outcome: 'The chosen value must survive the mock write.',
    metric: 'The stored priority is the chosen one.',
    priority: chosen,
  })
  expect(findItem(id).priority).toBe(chosen)
  vi.clearAllTimers()
})

// ---- HZ-310: removeDependency, the offline mirror of store.removeDependency ----
// Fresh module so the removed edge can't leak into the fixture checks above.

test('removeDependency drops the edge on both items, logs it, and clears the blocked flags', async () => {
  vi.useFakeTimers()
  vi.resetModules()
  const fresh = await import('./mockApi')
  const get = (id) => fresh.getItems().find((it) => it.id === id)
  expect(get('BF-131').blocked).toBe(true)

  await expect(fresh.removeDependency('BF-131', 'BF-128')).resolves.toEqual({ ok: true })
  const item = get('BF-131')
  expect(item.blockedBy.map((b) => b.id)).not.toContain('BF-128')
  expect(item.blocked).toBe(false)
  expect(item.blockedByAbandoned).toBeFalsy()
  expect(get('BF-128').dependents.map((d) => d.id)).not.toContain('BF-131')
  expect(item.events[0].text).toBe('removed the dependency on BF-128')

  await expect(fresh.removeDependency('BF-131', 'BF-128')).rejects.toThrow('not_found')
  vi.useRealTimers()
})

// HZ-549: the mock serves the same checked-in fixture as the server, with
// range and project echoed and costs left null (not captured).
test('getProductivity returns the productivity fixture with range and project echoed', async () => {
  const report = await mockApi.getProductivity({ range: '7d', project: 'horizon' })
  expect(report.range).toBe('7d')
  expect(report.project).toBe('horizon')
  expect(report.summary.closed).toBe(319)
  expect(report.summary.cost).toBeNull()
  expect(report.models.rows).toHaveLength(13)
})
