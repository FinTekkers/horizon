// HZ-713 metric 3: an item stopped on its step shows exactly one banner naming
// why — paused, run failed, rule blocked, usage limit, dependency or isolation
// refusal — and the one action that continues it.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(),
}))

import Tracker from './Tracker'
import { IMPLEMENT_STEP_INDEX } from '../../../domain/js/lifecycle.js'
import { REASON } from '../../../domain/js/reasons.js'
import { HOLD_REASONS, holdFor } from '../domain/hold'

afterEach(cleanup)

const noop = () => {}
const base = {
  id: 'HD-1',
  title: 'Held item',
  desc: '',
  metric: '',
  guardrails: '',
  priority: 'High',
  cursor: IMPLEMENT_STEP_INDEX,
  project_id: 7,
  paused: false,
  rejected: false,
  events: [],
  stepOutputs: {},
  activeRun: null,
  ruleBlock: null,
  usageWait: null,
  isolationRefusal: null,
}

const RULE_BLOCK = { rule: 'guardrail 6: models first', needs: 'A ledger-models release.', runId: 9, blockedAt: '2026-10-08 14:02:11' }
const ISOLATION = 'Held: this project has no credential reference — set one in its settings'
const WAIT = 'Waiting for usage limits to reset, earliest 2026-10-12 14:00 UTC'

// reason → [item, banner title, continue label, the prop the action calls, its argument(s)]
const CASES = {
  paused: [
    { ...base, paused: true, events: [{ created_at: '2026-01-01 00:00:00', text: 'paused agent work on this item' }] },
    'Paused by you',
    'Resume',
    'onTogglePause',
    ['HD-1', false],
  ],
  runFailed: [
    {
      ...base,
      paused: true,
      events: [{ created_at: '2026-01-01 00:00:00', text: `agent step failed (${REASON.TIMEOUT}): step timed out — item paused; resume to retry` }],
    },
    'Timed out',
    'Retry',
    'onTogglePause',
    ['HD-1', false],
  ],
  ruleBlocked: [{ ...base, ruleBlock: RULE_BLOCK }, 'Blocked by a rule', 'Release with PIN', 'onReleaseRuleBlock', ['HD-1']],
  usageLimit: [{ ...base, usageWait: { until: '2026-10-12T14:00:00.000Z', text: WAIT } }, WAIT, 'Release now', 'onReleaseUsageWait', ['HD-1']],
  dependency: [
    { ...base, blocked: true, blockedBy: [{ id: 'HD-9', title: 'Upstream fix', abandoned: false, merged: false }] },
    'Waiting on HD-9',
    'Open HD-9',
    'onOpenItem',
    ['HD-9'],
  ],
  isolation: [{ ...base, isolationRefusal: ISOLATION }, ISOLATION, 'Open project settings', 'onOpenProjectSettings', [7]],
}

const CONTINUE_LABELS = ['Resume', 'Retry', 'Release with PIN', 'Release now', 'Open HD-9', 'Open project settings']

function renderTracker(item) {
  const handlers = {
    onTogglePause: vi.fn(() => Promise.resolve({ ok: true })),
    onReleaseRuleBlock: vi.fn(() => Promise.resolve({ ok: true })),
    onReleaseUsageWait: vi.fn(() => Promise.resolve({ ok: true })),
    onOpenProjectSettings: vi.fn(),
    onOpenItem: vi.fn(),
  }
  const view = render(
    <Tracker
      item={item}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onResolveConflicts={noop}
      onRestartPhase={noop}
      onSetPersona={noop}
      onAbandon={noop}
      onAddDependency={noop}
      onAmendRule={noop}
      {...handlers}
    />,
  )
  return { ...view, handlers }
}

// Every banner a hold could show, old selectors included, counted once each.
const BANNERS = '[data-hold-banner], .pause-banner, #rule-block, [data-testid="isolation-hold"]'

test('the six reasons are the ones the order names', () => {
  expect([...HOLD_REASONS].sort()).toEqual(Object.keys(CASES).sort())
})

test.each(Object.entries(CASES))('%s: one banner with its own text and one continue action', async (reason, [item, title, label, prop, args]) => {
  expect(holdFor(item).reason).toBe(reason)
  const { container, getByRole, queryByRole, handlers } = renderTracker(item)

  const banners = container.querySelectorAll(BANNERS)
  expect(banners.length).toBe(1)
  const banner = banners[0]
  expect(banner.getAttribute('data-hold-banner')).toBe(reason)
  expect(banner.querySelector('.pause-banner__title').textContent).toContain(title)

  // One continue action, and no other reason's label anywhere on the page.
  expect(banner.querySelectorAll('[data-hold-action]').length).toBe(1)
  const button = getByRole('button', { name: label })
  expect(button.getAttribute('data-hold-action')).toBe(holdFor(item).action.key)
  expect(banner.contains(button)).toBe(true)
  for (const other of CONTINUE_LABELS.filter((l) => l !== label)) expect(queryByRole('button', { name: other })).toBeNull()

  await act(async () => {
    fireEvent.click(button)
  })
  expect(handlers[prop]).toHaveBeenCalledTimes(1)
  expect(handlers[prop]).toHaveBeenCalledWith(...args)
  for (const [name, fn] of Object.entries(handlers)) if (name !== prop) expect(fn).not.toHaveBeenCalled()
})

test('the rule-blocked item offers no header Resume work and nothing else that resumes it', async () => {
  for (const item of [CASES.ruleBlocked[0], { ...CASES.ruleBlocked[0], paused: true }]) {
    const { container, queryByRole, getByRole, handlers } = renderTracker(item)
    expect(queryByRole('button', { name: 'Resume work' })).toBeNull()
    expect(container.querySelectorAll(BANNERS).length).toBe(1)
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Release with PIN' }))
    })
    expect(handlers.onTogglePause).not.toHaveBeenCalled()
    cleanup()
  }
})

test('a paused, rule-blocked item with every other hold too renders one banner: the rule block', () => {
  const item = {
    ...CASES.dependency[0],
    paused: true,
    ruleBlock: RULE_BLOCK,
    usageWait: { until: '2026-10-12T14:00:00.000Z', text: WAIT },
    isolationRefusal: ISOLATION,
    events: CASES.runFailed[0].events,
  }
  const { container } = renderTracker(item)
  const banners = container.querySelectorAll(BANNERS)
  expect(banners.length).toBe(1)
  expect(banners[0].getAttribute('data-hold-banner')).toBe('ruleBlocked')
})

test('the order: run failed over usage, isolation over dependency, usage over dependency', () => {
  const failed = { ...CASES.runFailed[0], usageWait: CASES.usageLimit[0].usageWait }
  expect(holdFor(failed).reason).toBe('runFailed')
  expect(holdFor({ ...CASES.dependency[0], isolationRefusal: ISOLATION }).reason).toBe('isolation')
  expect(holdFor({ ...CASES.dependency[0], usageWait: CASES.usageLimit[0].usageWait }).reason).toBe('usageLimit')
  expect(holdFor(base)).toBeNull()
  expect(holdFor({ ...CASES.paused[0], abandoned_at: '2026-01-01 00:00:00' })).toBeNull()
})

test('an item with no hold renders no hold banner', () => {
  const { container } = renderTracker(base)
  expect(container.querySelectorAll(BANNERS).length).toBe(0)
})
