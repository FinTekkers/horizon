// HZ-365: a rule-blocked item's page shows the banner — which rule stopped it,
// the whole of what's needed (summary first, the agent's full explanation
// behind a toggle) and HZ-346's ways to clear it (HZ-580 adds Resume). All agent text is
// plain React text with its line breaks kept.

import { expect, test, vi, afterEach } from 'vitest'
import { useState } from 'react'
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
import { IMPLEMENT_STEP_INDEX, STEPS } from '../../../domain/js/lifecycle.js'
import { RULE_BLOCK_ACTIONS, ruleBlockActionsText } from '../../../domain/js/ruleBlockActions.js'
import { itemStatus } from '../domain/status'

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
})

const noop = () => {}
const RULE = 'guardrail 6: "models first: no local workaround"'
const SUMMARY = 'Needs a ledger-models release that adds the settlement field.'
// 3,000 characters with blank lines and single breaks inside.
const NEEDS = (`${SUMMARY}\n\n` + 'Cause: the proto has no field for it.\nFix: ledger-models LM-42 and LM-43.\n\n'.repeat(60)).slice(0, 2999) + '.'

const blockedItem = (ruleBlock = { rule: RULE, needs: NEEDS, runId: 9, blockedAt: '2026-10-08 14:02:11' }) => ({
  id: 'LS-17',
  title: 'Settle trades',
  desc: '',
  metric: '',
  guardrails: '',
  priority: 'High',
  cursor: IMPLEMENT_STEP_INDEX,
  paused: false,
  rejected: false,
  events: [],
  stepOutputs: {},
  activeRun: null,
  ruleBlock,
})

function renderTracker(item, props = {}) {
  return render(
    <Tracker
      item={item}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onResolveConflicts={noop}
      onTogglePause={noop}
      onRestartPhase={noop}
      onSetPersona={noop}
      onAbandon={noop}
      onAddDependency={noop}
      onAmendRule={noop}
      {...props}
    />,
  )
}

const banner = (container) => container.querySelector('#rule-block')

test('the banner names the step and the rule, shows the summary, and the toggle reveals all 3,000 characters with breaks kept', () => {
  expect(NEEDS.length).toBe(3000)
  const { container, getByRole } = renderTracker(blockedItem())
  const el = banner(container)
  expect(el.classList.contains('pause-banner')).toBe(true)
  expect(el.querySelector('.pause-banner__title').textContent).toBe(`Blocked by a rule · ${STEPS[IMPLEMENT_STEP_INDEX].label}`)
  expect(el.querySelector('blockquote').textContent).toBe(RULE)
  expect(el.textContent).toContain('Rule')
  expect(el.textContent).toContain("What's needed")
  expect(el.querySelector('.pause-banner__meta').textContent).toBe('Not a failed attempt · nothing runs until this is cleared')

  // Before the toggle: the summary only.
  expect(el.textContent).toContain(SUMMARY)
  expect(el.textContent).not.toContain('Cause: the proto')
  expect(el.querySelector('[data-testid="rule-block-needs"]')).toBeNull()

  fireEvent.click(getByRole('button', { name: "Show the agent's full explanation" }))
  const full = el.querySelector('[data-testid="rule-block-needs"]')
  expect(full.textContent === NEEDS).toBe(true)
  expect(full.classList.contains('pause-banner__text')).toBe(true)
  expect(el.textContent).not.toContain('…')
})

test('exactly one banner renders, also after switching between rule-blocked items', () => {
  const { container, rerender } = renderTracker(blockedItem())
  expect(container.querySelectorAll('.pause-banner').length).toBe(1)
  const other = { ...blockedItem(), id: 'LS-18' }
  rerender(
    <Tracker item={other} onBack={noop} onApprove={noop} onApproveWithComments={noop} onReject={noop} onResolveConflicts={noop}
      onTogglePause={noop} onRestartPhase={noop} onSetPersona={noop} onAbandon={noop} onAddDependency={noop} onAmendRule={noop} />,
  )
  expect(container.querySelectorAll('.pause-banner').length).toBe(1)
  expect(container.querySelectorAll('#rule-block').length).toBe(1)
})

test('a single short line has no toggle', () => {
  const { container, queryByRole } = renderTracker(blockedItem({ rule: RULE, needs: SUMMARY }))
  expect(banner(container).textContent).toContain(SUMMARY)
  expect(queryByRole('button', { name: /full explanation/ })).toBeNull()
})

test('no banner when the item is not rule-blocked, or is paused', () => {
  expect(banner(renderTracker(blockedItem(null)).container)).toBeNull()
  cleanup()
  expect(banner(renderTracker({ ...blockedItem(), paused: true }).container)).toBeNull()
})

test('Add dependency fires onAddDependency with the item id', () => {
  const spy = vi.fn()
  const { getByRole } = renderTracker(blockedItem(), { onAddDependency: spy })
  const button = getByRole('button', { name: 'Add dependency' })
  expect(button.classList.contains('btn-resume')).toBe(true)
  fireEvent.click(button)
  expect(spy).toHaveBeenCalledWith('LS-17')
})

test('Amend the rule fires onAmendRule with the item id', () => {
  const spy = vi.fn()
  const { getByRole } = renderTracker(blockedItem(), { onAmendRule: spy })
  const button = getByRole('button', { name: 'Amend the rule' })
  expect(button.classList.contains('btn-outline')).toBe(true)
  fireEvent.click(button)
  expect(spy).toHaveBeenCalledWith('LS-17')
})

test("the banner's Abandon fires onAbandon with the item id", () => {
  const spy = vi.fn()
  const { container } = renderTracker(blockedItem(), { onAbandon: spy })
  const button = [...banner(container).querySelectorAll('button')].find((b) => b.textContent === 'Abandon')
  expect(button.classList.contains('btn-reject')).toBe(true)
  fireEvent.click(button)
  expect(spy).toHaveBeenCalledWith('LS-17')
})

test('rule and needs with a script tag and a URL render as plain text: no script element, no link', () => {
  const evil = '<script>alert(1)</script> see https://evil.example/fix'
  const { container, getByRole } = renderTracker(blockedItem({ rule: evil, needs: `${evil}\n\n${evil}` }))
  fireEvent.click(getByRole('button', { name: "Show the agent's full explanation" }))
  const el = banner(container)
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('a[href*="evil"]')).toBeNull()
  expect(el.querySelector('blockquote').textContent).toBe(evil)
})

test('the banner and its new elements carry no inline style', () => {
  const { container, getByRole } = renderTracker(blockedItem())
  fireEvent.click(getByRole('button', { name: "Show the agent's full explanation" }))
  const el = banner(container)
  expect([el, ...el.querySelectorAll('*')].filter((n) => n.hasAttribute('style'))).toEqual([])
})

test('opened at #rule-block, the banner scrolls itself into view once the item has loaded', () => {
  const scroll = vi.fn()
  const original = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = scroll
  try {
    window.history.replaceState({}, '', '/ls-17#rule-block')
    const { container } = renderTracker(blockedItem())
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll.mock.contexts[0]).toBe(banner(container))
  } finally {
    Element.prototype.scrollIntoView = original
  }
})

// HZ-580 metric 1: a dependency added after the block leads; the agent's
// needs move behind the toggle.
test('a dependency added after the block leads the banner, and the needs show only after the toggle', () => {
  const item = {
    ...blockedItem({ rule: RULE, needs: NEEDS, runId: 9, blockedAt: '2026-10-08 14:02:11', waitingOn: [{ id: 'LM-389', title: 'Add settlement field' }] }),
    blocked: true,
    blockedBy: [{ id: 'LM-389', title: 'Add settlement field', abandoned: false, merged: false }],
  }
  const { container, getByRole } = renderTracker(item)
  const el = banner(container)
  const lead = el.querySelector('.pause-banner__title').nextElementSibling
  expect(lead.textContent).toBe('Waiting on LM-389 (added after this block)')
  expect(lead.getAttribute('data-testid')).toBe('rule-block-waiting-on')
  expect(el.textContent).not.toContain(SUMMARY)
  expect(el.textContent).not.toContain("What's needed")
  expect(el.querySelector('[data-testid="rule-block-needs"]')).toBeNull()

  fireEvent.click(getByRole('button', { name: "Show the agent's full explanation" }))
  expect(el.querySelector('[data-testid="rule-block-needs"]').textContent).toBe(NEEDS)
})

test('a short needs line still gets the toggle once a dependency leads', () => {
  const item = blockedItem({ rule: RULE, needs: SUMMARY, runId: 9, blockedAt: '2026-10-08 14:02:11', waitingOn: [{ id: 'LM-389', title: 'x' }] })
  const { container, getByRole } = renderTracker(item)
  expect(banner(container).textContent).not.toContain(SUMMARY)
  fireEvent.click(getByRole('button', { name: "Show the agent's full explanation" }))
  expect(banner(container).querySelector('[data-testid="rule-block-needs"]').textContent).toBe(SUMMARY)
})

// HZ-580 metric 2: a dependency from before the block is not why it waits.
test('a dependency from before the block adds no lead line, and the summary stays the lead', () => {
  const item = {
    ...blockedItem({ rule: RULE, needs: NEEDS, runId: 9, blockedAt: '2026-10-08 14:02:11', waitingOn: [] }),
    blockedBy: [{ id: 'LM-1', title: 'Older dependency', abandoned: false, merged: false }],
  }
  const { container } = renderTracker(item)
  const el = banner(container)
  expect(el.textContent).not.toContain('(added after this block)')
  expect(el.querySelector('[data-testid="rule-block-waiting-on"]')).toBeNull()
  expect(el.textContent).toContain("What's needed")
  expect(el.textContent).toContain(SUMMARY)
})

// HZ-580 metric 3: Resume is the paused banner's setPaused(false) path. The
// server clearing the block is proven in server/test/rule-block.test.mjs and
// the e2e journey; here the parent re-renders with what the server returns.
function ResumeHarness({ initial, afterResume, onTogglePause }) {
  const [item, setItem] = useState(initial)
  const toggle = (id, paused) =>
    Promise.resolve(onTogglePause(id, paused)).then(() => setItem(afterResume))
  return (
    <Tracker item={item} onBack={noop} onApprove={noop} onApproveWithComments={noop} onReject={noop} onResolveConflicts={noop}
      onTogglePause={toggle} onRestartPhase={noop} onSetPersona={noop} onAbandon={noop} onAddDependency={noop} onAmendRule={noop} />
  )
}

const DEP = { id: 'LM-389', title: 'Add settlement field', abandoned: false, merged: false }

test.each([
  ['an open dependency: the item then shows as blocked by it', { blocked: true, blockedBy: [DEP] }, 'Blocked'],
  ['no dependency: the item then shows as ready for its agent', { blocked: false, blockedBy: [] }, null],
])('Resume sends one setPaused(false) and the rule-block banner goes away — %s', async (_name, deps, label) => {
  const spy = vi.fn(() => Promise.resolve({ ok: true, paused: false }))
  const initial = { ...blockedItem(), ...deps }
  const after = { ...initial, ruleBlock: null, paused: false }
  const { container, getByRole } = render(<ResumeHarness initial={initial} afterResume={after} onTogglePause={spy} />)
  expect(container.querySelector('.tracker__status').textContent).toBe('Blocked by a rule')

  await act(async () => {
    fireEvent.click(getByRole('button', { name: 'Resume' }))
  })
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy).toHaveBeenCalledWith('LS-17', false)
  expect(banner(container)).toBeNull()
  const status = container.querySelector('.tracker__status').textContent
  expect(status).toBe(label ?? itemStatus(after, true).label)
  expect(status).not.toBe('Blocked by a rule')
  if (label) expect(container.textContent).toContain('LM-389')
  else expect(status).not.toMatch(/Blocked|Paused/)
})

test('two clicks on Resume while the call is pending send one call, and the button is disabled', () => {
  const spy = vi.fn(() => new Promise(() => {}))
  const { getByRole } = renderTracker(blockedItem(), { onTogglePause: spy })
  const button = getByRole('button', { name: 'Resume' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy).toHaveBeenCalledWith('LS-17', false)
  expect(button.disabled).toBe(true)
})

// HZ-580 metric 4: every action the block's text names has a button here.
test('every action in RULE_BLOCK_ACTIONS has a banner button, and the block text names each one', () => {
  const { container } = renderTracker(blockedItem())
  const el = banner(container)
  expect(RULE_BLOCK_ACTIONS.length).toBeGreaterThan(0)
  for (const { key, phrase } of RULE_BLOCK_ACTIONS) {
    const button = el.querySelector(`button[data-rule-block-action="${key}"]`)
    expect(button, `no button for "${phrase}"`).not.toBeNull()
    expect(ruleBlockActionsText()).toContain(phrase)
  }
  expect(ruleBlockActionsText()).toBe('add a dependency on the item that delivers it, resume to retry, or abandon')
})
