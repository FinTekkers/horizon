// HZ-33: the word "Paused" must never be the sole explanation anywhere in
// the UI — every paused chip names why, and a paused item classified by a
// real failure gets a full banner (category, cause, attempts used,
// checkpoint, next action) via failureBanner(). retryPendingInfo() covers
// the "avoid" half: a step auto-retrying in the background (not yet paused)
// is visible, not silently working-or-not.

import { expect, test } from 'vitest'
import { itemStatus, failureBanner, retryPendingInfo } from './status'
import { IMPLEMENT_STEP_INDEX } from './lifecycle'

const baseItem = {
  cursor: 3,
  paused: false,
  rejected: false,
  failureCategory: null,
  failureCause: null,
  retryCount: 0,
  retryBudget: null,
  nextRetryAt: null,
}

test('a plain human pause never renders the bare word "Paused" alone', () => {
  const status = itemStatus({ ...baseItem, paused: true })
  expect(status.label).not.toBe('Paused')
  expect(status.label).toMatch(/by you/i)
})

test('a checks_failed pause names the category in the compact and verbose status chip', () => {
  const item = { ...baseItem, paused: true, failureCategory: 'checks_failed', failureCause: 'tests failed', retryCount: 1 }
  expect(itemStatus(item, false).label).not.toBe('Paused')
  expect(itemStatus(item, false).label).toMatch(/checks/i)
  expect(itemStatus(item, true).label).toMatch(/checks/i)
})

test('an infra-budget-exhausted pause names the category', () => {
  const item = { ...baseItem, paused: true, failureCategory: 'infra', failureCause: 'farm unreachable', retryCount: 4, retryBudget: 3 }
  expect(itemStatus(item).label).toMatch(/infra/i)
})

test('a pending auto-retry (not yet paused) shows as retrying, not as the agent working normally', () => {
  const item = {
    ...baseItem,
    failureCategory: 'infra',
    failureCause: 'farm unreachable',
    retryCount: 1,
    retryBudget: 3,
    nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
  }
  expect(itemStatus(item, true).label).toMatch(/retry/i)
})

test('a past next_retry_at (already fired) does not stick the item in a permanent "retrying" state', () => {
  const item = { ...baseItem, nextRetryAt: new Date(Date.now() - 60_000).toISOString() }
  expect(itemStatus(item, true).label).not.toMatch(/retry/i)
})

test('failureBanner is null when the item is not paused, even mid-retry', () => {
  const item = { ...baseItem, failureCategory: 'infra', nextRetryAt: new Date(Date.now() + 60_000).toISOString() }
  expect(failureBanner(item)).toBeNull()
})

test('failureBanner is null for a plain human pause (no classified failure)', () => {
  expect(failureBanner({ ...baseItem, paused: true })).toBeNull()
})

test('failureBanner surfaces category, cause, attempts, checkpoint and next action for checks_failed', () => {
  const item = { ...baseItem, paused: true, failureCategory: 'checks_failed', failureCause: '2 tests failing', retryCount: 1, retryBudget: null }
  const banner = failureBanner(item)
  expect(banner.category).toBe('checks_failed')
  expect(banner.cause).toBe('2 tests failing')
  expect(banner.attempts).toBe(1)
  expect(banner.retryable).toBe(false)
  expect(banner.checkpoint).toBeTruthy()
  expect(banner.nextAction).toMatch(/never auto-retries/i)
})

test('failureBanner names the HZ-31 checkpoint specifically for a turn_cap pause on the implement step', () => {
  const item = { ...baseItem, cursor: IMPLEMENT_STEP_INDEX, paused: true, failureCategory: 'turn_cap', failureCause: 'timed out', retryCount: 4, retryBudget: 3 }
  const banner = failureBanner(item)
  expect(banner.checkpoint).toMatch(/committed and pushed/i)
  expect(banner.nextAction).toMatch(/budget \(3\) is exhausted after 4 attempt/i)
})

test('failureBanner does not claim a checkpoint exists for a turn_cap pause on a non-implement step', () => {
  const item = { ...baseItem, cursor: 4, paused: true, failureCategory: 'turn_cap', failureCause: 'timed out', retryCount: 3, retryBudget: 3 }
  const banner = failureBanner(item)
  expect(banner.checkpoint).toMatch(/none for this step/i)
})

test('retryPendingInfo is null once the item is paused', () => {
  const item = { ...baseItem, paused: true, failureCategory: 'infra', nextRetryAt: new Date(Date.now() + 60_000).toISOString() }
  expect(retryPendingInfo(item)).toBeNull()
})

test('retryPendingInfo reports the same category/cause/attempts the banner would show once paused', () => {
  const item = { ...baseItem, failureCategory: 'infra', failureCause: 'farm unreachable', retryCount: 2, retryBudget: 3, nextRetryAt: new Date(Date.now() + 30_000).toISOString() }
  const info = retryPendingInfo(item)
  expect(info.category).toBe('infra')
  expect(info.cause).toBe('farm unreachable')
  expect(info.attempts).toBe(2)
  expect(info.budget).toBe(3)
})
