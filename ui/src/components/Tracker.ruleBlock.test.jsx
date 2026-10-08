// HZ-365: a rule-blocked item's page shows the banner — which rule stopped it,
// the whole of what's needed (summary first, the agent's full explanation
// behind a toggle) and HZ-346's three ways to clear it. All agent text is
// plain React text with its line breaks kept.

import { expect, test, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'

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
