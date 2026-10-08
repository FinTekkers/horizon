// itemStatus() is the single place the board card, tracker header and status
// pill all read from — HZ-59 needs Abandoned to render as its own terminal
// state, never collapsing into Closed or any of the other statuses.

import { expect, test } from 'vitest'
import { itemStatus, stateLabel, stepStateLabel } from './status'
import { STEPS, ACCEPT_GATE_INDEX } from '../../../domain/js/lifecycle.js'

const base = { cursor: 0, paused: false, rejected: false, abandoned_at: null }

test('an abandoned item reads Abandoned, not Closed, even once its old cursor reached the end', () => {
  const item = { ...base, cursor: STEPS.length, abandoned_at: '2026-01-01 00:00:00' }
  const status = itemStatus(item)
  expect(status.label).toBe('Abandoned')
  expect(status).not.toEqual(itemStatus({ ...base, cursor: STEPS.length }))
})

test('an abandoned item mid-pipeline reads Abandoned, not the current agent or gate label', () => {
  const onAgentStep = { ...base, cursor: 11, abandoned_at: '2026-01-01 00:00:00' }
  expect(itemStatus(onAgentStep).label).toBe('Abandoned')

  const onGateStep = { ...base, cursor: 3, abandoned_at: '2026-01-01 00:00:00' }
  expect(itemStatus(onGateStep).label).toBe('Abandoned')
})

test('abandoned takes priority over paused and rejected — it is the more final state', () => {
  const item = { ...base, cursor: 11, abandoned_at: '2026-01-01 00:00:00', paused: true, rejected: true }
  expect(itemStatus(item).label).toBe('Abandoned')
})

test('a non-abandoned item is unaffected — abandoned_at absent reads as before', () => {
  const closed = { ...base, cursor: STEPS.length }
  expect(itemStatus(closed).label).toBe('Closed')
  const onGate = { ...base, cursor: 3 }
  expect(itemStatus(onGate, true).label).toBe('Awaiting your approval')
})

// HZ-54: a dispatched step must read distinctly as queued vs running, driven
// only by item.activeRun.state (never tmux/session details) and defaulting
// to today's "working" presentation whenever that field is absent — a farm
// that's down, old, or hasn't polled yet must never make the board look
// wrong or stalled.

import { expect, test } from 'vitest'
import { itemStatus, isQueued } from './status'

const baseItem = {
  id: 'T-1',
  cursor: 11, // "Specialist agent implements" — an Eng agent step
  paused: false,
  rejected: false,
  activeRun: null,
}

test('isQueued is false with no activeRun at all', () => {
  expect(isQueued(baseItem)).toBe(false)
})

test('isQueued is false when the farm reports the run as running', () => {
  const item = { ...baseItem, activeRun: { step_index: 11, state: 'running' } }
  expect(isQueued(item)).toBe(false)
})

test('isQueued is true only when the farm explicitly reports queued for the current step', () => {
  const item = { ...baseItem, activeRun: { step_index: 11, state: 'queued', reason: 'waiting for a free agent slot' } }
  expect(isQueued(item)).toBe(true)
})

test('isQueued is false when activeRun belongs to a superseded step, not the current cursor', () => {
  const item = { ...baseItem, cursor: 12, activeRun: { step_index: 11, state: 'queued' } }
  expect(isQueued(item)).toBe(false)
})

test('itemStatus shows the agent working label when the farm reports running', () => {
  const item = { ...baseItem, activeRun: { step_index: 11, state: 'running' } }
  expect(itemStatus(item).label).toBe('Eng agent')
  expect(itemStatus(item, true).label).toBe('Eng agent working')
})

test('itemStatus shows Queued, with the reason, when the farm reports queued', () => {
  const item = { ...baseItem, activeRun: { step_index: 11, state: 'queued', reason: 'waiting for a free agent slot (4/4 in use)' } }
  const status = itemStatus(item)
  expect(status.label).toBe('Queued')
  expect(status.reason).toBe('waiting for a free agent slot (4/4 in use)')
  // Queued must be visually distinct from the normal "agent working" blue.
  expect(status.color).not.toBe(itemStatus({ ...baseItem, activeRun: { step_index: 11, state: 'running' } }).color)
})

test('itemStatus falls back to "working" (today\'s behavior) when the farm never reports a state — fail soft', () => {
  const item = { ...baseItem, activeRun: { step_index: 11 } } // no state field at all: old/unreachable/silent farm
  expect(itemStatus(item).label).toBe('Eng agent')
})

test('itemStatus falls back to "working" when there is no activeRun at all — mock mode', () => {
  expect(itemStatus(baseItem).label).toBe('Eng agent')
})

test('closed, rejected, paused and awaiting-gate all take priority over a queued run', () => {
  const queuedRun = { step_index: 11, state: 'queued', reason: 'waiting' }
  expect(itemStatus({ ...baseItem, cursor: 16, activeRun: queuedRun }).label).toBe('Closed')
  expect(itemStatus({ ...baseItem, rejected: true, activeRun: queuedRun }).label).toBe('Changes requested')
  expect(itemStatus({ ...baseItem, paused: true, activeRun: queuedRun }).label).toBe('Paused')
})

// HZ-228: the card's elapsed line names each agent step by a short name, so
// it fits the card. An added or re-phased step must not silently fall back to
// a long label.
test('every agent step has a short elapsed-line name', () => {
  for (const step of STEPS.filter((s) => s.kind === 'agent')) {
    expect(stepStateLabel(step).length).toBeLessThanOrEqual(20)
  }
})

test('stateLabel names a running conflict resolution and has no timer without state_since', () => {
  const accept = { ...base, cursor: ACCEPT_GATE_INDEX, state_since: '2026-10-02T10:00:00Z' }
  expect(stateLabel({ ...accept, gateAction: { kind: 'resolve', state: 'running', since: accept.state_since } })).toBe(
    'Resolving conflicts',
  )
  expect(stateLabel({ ...accept, gateAction: null })).toBe('Waiting on you')
  expect(stateLabel({ ...accept, state_since: null })).toBeNull()
})

// ---- HZ-335: an item held up by an open dependency reads Blocked ----
// item.blocked is read as the API gives it (HZ-95); nothing runs for the item,
// so it must never read as an agent working.

import { isDependencyBlocked } from './status'
import { agentStepIndexes, gateStepIndexes } from '../../../domain/js/lifecycle.js'

const blockedItem = { ...base, blocked: true, blockedBy: [{ id: 'HZ-327', title: 'Blocker', abandoned: false }], activeRun: null }
const BLOCKED = { label: 'Blocked', color: 'var(--danger-ink)', bg: 'var(--danger-bg)' }

test('a blocked, open, not-paused item with no run reads Blocked at every agent step', () => {
  for (const cursor of agentStepIndexes()) {
    const item = { ...blockedItem, cursor }
    expect(itemStatus(item), `cursor ${cursor}`).toEqual(BLOCKED)
    expect(itemStatus(item, true), `cursor ${cursor}`).toEqual(BLOCKED)
    expect(isDependencyBlocked(item)).toBe(true)
  }
})

test('the Blocked colour differs from Paused, Queued and the working pill', () => {
  const cursor = agentStepIndexes()[0]
  const blocked = itemStatus({ ...blockedItem, cursor })
  const paused = itemStatus({ ...base, cursor, paused: true })
  const queued = itemStatus({ ...base, cursor, activeRun: { step_index: cursor, state: 'queued' } })
  const working = itemStatus({ ...base, cursor, activeRun: null })
  expect(working.label).toMatch(/agent/)
  for (const other of [paused, queued, working]) {
    expect([blocked.color, blocked.bg]).not.toEqual([other.color, other.bg])
    expect(blocked.bg).not.toBe(other.bg)
  }
})

test('status precedence: Abandoned, Closed, Changes requested and Paused beat Blocked; Blocked beats Awaiting, Queued and working', () => {
  const agentCursor = 11
  const gateCursor = gateStepIndexes()[0]
  const cases = [
    [{ ...blockedItem, cursor: agentCursor, abandoned_at: '2026-01-01 00:00:00' }, 'Abandoned'],
    [{ ...blockedItem, cursor: STEPS.length }, 'Closed'],
    [{ ...blockedItem, cursor: agentCursor, rejected: true }, 'Changes requested'],
    [{ ...blockedItem, cursor: agentCursor, paused: true }, 'Paused'],
    [{ ...blockedItem, cursor: gateCursor }, 'Blocked'],
    [{ ...blockedItem, cursor: ACCEPT_GATE_INDEX }, 'Blocked'],
    [{ ...blockedItem, cursor: agentCursor, activeRun: { step_index: agentCursor, state: 'queued', reason: 'slots' } }, 'Blocked'],
    [{ ...blockedItem, cursor: agentCursor }, 'Blocked'],
    // A dependency added mid-run: the run really is running, so it reads working.
    [{ ...blockedItem, cursor: agentCursor, activeRun: { step_index: agentCursor, state: 'running' } }, 'Eng agent'],
    // A running run left over from an earlier step does not unblock the item.
    [{ ...blockedItem, cursor: agentCursor, activeRun: { step_index: agentCursor - 1, state: 'running' } }, 'Blocked'],
    // Not blocked: unchanged.
    [{ ...base, cursor: agentCursor, blocked: false, activeRun: null }, 'Eng agent'],
    [{ ...base, cursor: gateCursor, blocked: false }, 'Awaiting you'],
  ]
  for (const [item, label] of cases) expect(itemStatus(item).label).toBe(label)
})

test('a blocked item shows no elapsed label; paused or unblocked rules are unchanged', () => {
  const item = { ...blockedItem, cursor: 11, state_since: '2026-10-02T11:00:00Z' }
  expect(stateLabel(item)).toBeNull()
  expect(stateLabel({ ...item, blocked: false })).toBe('Implementing')
  expect(stateLabel({ ...item, cursor: gateStepIndexes()[0] })).toBeNull()
})

// HZ-346: an implement run stopped on a rule reads Blocked by a rule, above a
// dependency's Blocked, with no elapsed line. Paused and the terminal states win.

import { isRuleBlocked } from './status'

const RULE_BLOCK = { rule: 'guardrail 6', needs: 'a ledger-models release', runId: 1, blockedAt: '2026-10-08 14:02:11' }

test('a rule-blocked item reads Blocked by a rule, above dependency Blocked, below Paused and the terminal states', () => {
  const ruleBlocked = { ...base, cursor: 11, ruleBlock: RULE_BLOCK, activeRun: null, state_since: null }
  expect(isRuleBlocked(ruleBlocked)).toBe(true)
  expect(itemStatus(ruleBlocked).label).toBe('Blocked by a rule')
  expect(itemStatus(ruleBlocked, true).label).toBe('Blocked by a rule')
  expect(itemStatus({ ...ruleBlocked, ...blockedItem, ruleBlock: RULE_BLOCK, cursor: 11 }).label).toBe('Blocked by a rule')
  expect(itemStatus({ ...ruleBlocked, paused: true }).label).toBe('Paused')
  expect(itemStatus({ ...ruleBlocked, rejected: true }).label).toBe('Changes requested')
  expect(itemStatus({ ...ruleBlocked, abandoned_at: '2026-01-01 00:00:00' }).label).toBe('Abandoned')
  expect(itemStatus({ ...ruleBlocked, ruleBlock: null }).label).toBe('Eng agent')
  expect(stateLabel({ ...ruleBlocked, state_since: '2026-10-08T14:02:11Z' })).toBeNull()
})

// HZ-360: Accept the code while a Horizon self-deploy drains reads Queued to
// merge, with the drain's latest end as HH:MM in the viewer's time zone and
// whose Accept is waiting.

import { queuedToMerge, clockTime } from './status'

const LATEST_END = '2026-10-08T19:37:52.000Z'
const BLOCK = { blocked: true, startedAt: '2026-10-08T19:12:52.000Z', latestEnd: LATEST_END }
const atAccept = (extra = {}) => ({ ...base, cursor: ACCEPT_GATE_INDEX, pr: 354, acceptWaiting: null, ...extra })

function inTimeZone(tz, fn) {
  const saved = process.env.TZ
  process.env.TZ = tz
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
}

test('queuedToMerge names the drain and its latest end as HH:MM in the viewer time zone', () => {
  inTimeZone('UTC', () => {
    expect(clockTime(LATEST_END)).toBe('19:37')
    expect(queuedToMerge(atAccept(), BLOCK).text).toBe('Horizon is deploying, merges resume after it (by about 19:37)')
  })
  inTimeZone('Asia/Kolkata', () => {
    expect(queuedToMerge(atAccept(), BLOCK).text).toBe('Horizon is deploying, merges resume after it (by about 01:07)')
  })
})

test('queuedToMerge says who approved: Autopilot, you, someone else, or nobody yet', () => {
  expect(queuedToMerge(atAccept({ acceptWaiting: { source: 'autopilot' } }), BLOCK, 'Dana').approvedBy).toBe('Approved by Autopilot')
  expect(queuedToMerge(atAccept({ acceptWaiting: { source: 'human', actor: 'Dana' } }), BLOCK, 'Dana').approvedBy).toBe('Approved by you')
  expect(queuedToMerge(atAccept({ acceptWaiting: { source: 'human', actor: 'Sam' } }), BLOCK, 'Dana').approvedBy).toBe('Approved by Sam')
  expect(queuedToMerge(atAccept(), BLOCK, 'Dana').approvedBy).toBeNull()
})

test('queuedToMerge is null with no block, at another gate, or with no PR', () => {
  expect(queuedToMerge(atAccept(), null)).toBeNull()
  expect(queuedToMerge(atAccept(), { ...BLOCK, blocked: false })).toBeNull()
  expect(queuedToMerge({ ...base, cursor: 3 }, BLOCK)).toBeNull()
  expect(queuedToMerge(atAccept({ pr: null }), BLOCK)).toBeNull()
  expect(queuedToMerge(atAccept({ rejected: true }), BLOCK)).toBeNull()
})

test('itemStatus and stateLabel read Queued to merge at a blocked Accept the code, Awaiting otherwise', () => {
  const item = atAccept({ state_since: '2026-10-08 19:00:00' })
  const status = itemStatus(item, true, { deployBlock: BLOCK })
  expect(status.label).toBe('Queued to merge')
  expect(status.reason).toBe(queuedToMerge(item, BLOCK).text)
  expect(stateLabel(item, { deployBlock: BLOCK })).toBe('Queued to merge')
  expect(itemStatus(item, true).label).toBe('Awaiting your approval')
  expect(stateLabel(item)).toBe('Waiting on you')
})
