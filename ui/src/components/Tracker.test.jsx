// Smoke test for the persona confirm control at the intake gate — the human
// leg of HZ-4's specialist routing (QA condition 1: this replaces any
// "manually verified" claim) — plus the HZ-14 "See agent output" links that
// replaced inline step output and the HZ-5 Live activity panel.

import { expect, test, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: (itemId, stepIndex) => `https://example.test/api/items/${itemId}/steps/${stepIndex}/output`,
  runLogViewUrl: (runId) => `https://example.test/api/runs/${runId}/log/view`,
}))

import Tracker from './Tracker'

afterEach(() => {
  cleanup()
})

const baseItem = {
  id: 'T-1',
  title: 'A work item',
  desc: '',
  metric: '',
  guardrails: '',
  priority: 'Medium',
  cursor: 3, // the "Approve & prioritize this work" gate
  paused: false,
  rejected: false,
  events: [],
  stepOutputs: {},
  activeRun: null,
}

const noop = () => {}

function renderTracker(item, onSetPersona = noop) {
  return render(
    <Tracker
      item={item}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onTogglePause={noop}
      onRestartPhase={noop}
      onSetPersona={onSetPersona}
    />,
  )
}

test('the intake gate shows the persona select, defaulting to the proposed persona', () => {
  const { getByLabelText } = renderTracker({ ...baseItem, persona: 'python_backend' })
  expect(getByLabelText('Specialist persona').value).toBe('python_backend')
})

test('an item with no persona defaults the select to fullstack', () => {
  const { getByLabelText } = renderTracker(baseItem)
  expect(getByLabelText('Specialist persona').value).toBe('fullstack')
})

test('changing the select fires setPersona with the chosen id', () => {
  const spy = vi.fn()
  const { getByLabelText } = renderTracker({ ...baseItem, persona: 'python_backend' }, spy)
  fireEvent.change(getByLabelText('Specialist persona'), { target: { value: 'frontend_ui' } })
  expect(spy).toHaveBeenCalledWith('T-1', 'frontend_ui')
})

test('the select is absent when the item is past the intake gate', () => {
  const { queryByLabelText } = renderTracker({ ...baseItem, cursor: 4, persona: 'python_backend' })
  expect(queryByLabelText('Specialist persona')).toBeNull()
})

// ---- HZ-33: failure banner never leaves "Paused" as the sole explanation ----

test('a checks_failed pause renders a full banner: category, cause, attempts, checkpoint, next action', () => {
  const item = {
    ...baseItem,
    cursor: 11,
    paused: true,
    failureCategory: 'checks_failed',
    failureCause: 'npm test: 2 failing',
    retryCount: 1,
    retryBudget: null,
  }
  const { getByRole, queryByText } = renderTracker(item)
  const banner = getByRole('alert')
  expect(banner.textContent).toMatch(/checks failed/i)
  expect(banner.textContent).toMatch(/npm test: 2 failing/)
  expect(banner.textContent).toMatch(/1.*never auto-retried/i)
  expect(banner.textContent.toLowerCase()).not.toBe('paused')
  // The bare word "Paused" must never be the ONLY text explaining the state —
  // the status pill next to it must also name the category.
  expect(queryByText('Paused')).toBeNull()
})

test('an infra retry-budget-exhausted pause renders the retryable banner copy', () => {
  const item = {
    ...baseItem,
    cursor: 4,
    paused: true,
    failureCategory: 'infra',
    failureCause: 'farm unreachable',
    retryCount: 4,
    retryBudget: 3,
  }
  const { getByRole } = renderTracker(item)
  const banner = getByRole('alert')
  expect(banner.textContent).toMatch(/infrastructure/i)
  expect(banner.textContent).toMatch(/4 of 3 auto-retries/)
  expect(banner.textContent).toMatch(/resume manually/i)
})

test('no failure banner renders for a plain human pause or a normal working item', () => {
  const { queryByRole: queryPaused } = renderTracker({ ...baseItem, paused: true })
  expect(queryPaused('alert')).toBeNull()
  const { queryByRole: queryWorking } = renderTracker({ ...baseItem, cursor: 4 })
  expect(queryWorking('alert')).toBeNull()
})

test('a pending auto-retry (not yet paused) shows the retry-pending note, not a failure banner', () => {
  const item = {
    ...baseItem,
    cursor: 4,
    failureCategory: 'turn_cap',
    failureCause: 'claude timed out',
    retryCount: 1,
    retryBudget: 3,
    nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
  }
  const { getByText, queryByRole } = renderTracker(item)
  expect(getByText(/auto-retrying around/i)).toBeTruthy()
  expect(queryByRole('alert')).toBeNull()
})

// ---- HZ-14: "See agent output" links (replaces inline output + HZ-5's Live activity panel) ----

test('a completed agent step with output renders a "See agent output" link, not the text inline', () => {
  const item = {
    ...baseItem,
    cursor: 12, // past step 11, "Specialist agent implements"
    stepOutputs: { 11: { output: 'did the thing', attempt: 1 } },
  }
  const { getByRole, queryByText } = renderTracker(item)
  const link = getByRole('link', { name: 'See agent output ↗' })
  expect(link.getAttribute('href')).toBe('https://example.test/api/items/T-1/steps/11/output')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  expect(queryByText('did the thing')).toBeNull()
})

test('a running agent step renders a "See agent output" link to the live-tail page', () => {
  const item = {
    ...baseItem,
    cursor: 11, // "Specialist agent implements" — an agent step, currently active
    activeRun: { id: 7, step_index: 11, attempt: 1, started_at: new Date().toISOString() },
  }
  const { getByRole } = renderTracker(item)
  const link = getByRole('link', { name: 'See agent output ↗' })
  expect(link.getAttribute('href')).toBe('https://example.test/api/runs/7/log/view')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
})

test('no output link on an active step without a run id yet', () => {
  const item = { ...baseItem, cursor: 11, activeRun: null }
  const { queryByRole } = renderTracker(item)
  expect(queryByRole('link', { name: 'See agent output ↗' })).toBeNull()
})

test('no output link on a gate step, even if stepOutputs has data at that index', () => {
  const item = {
    ...baseItem,
    cursor: 4, // past gate index 3
    stepOutputs: { 3: { output: 'should never show', attempt: 1 } },
  }
  const { queryByRole } = renderTracker(item)
  expect(queryByRole('link', { name: 'See agent output ↗' })).toBeNull()
})

test('no output link on a done step with no recorded output', () => {
  const item = { ...baseItem, cursor: 12, stepOutputs: {} }
  const { queryByRole } = renderTracker(item)
  expect(queryByRole('link', { name: 'See agent output ↗' })).toBeNull()
})

// ---- HZ-46: version history — the artifact link doubles as the board's entry point to it ----

test('a step with a single retained artifact attempt links out as "View full artifact"', () => {
  const item = {
    ...baseItem,
    cursor: 12,
    stepOutputs: { 11: { output: 'did the thing', artifact: '# plan', attempt: 1, attemptCount: 1 } },
  }
  const { getByRole } = renderTracker(item)
  const link = getByRole('link', { name: 'View full artifact ↗' })
  expect(link.getAttribute('href')).toBe('https://example.test/artifact')
})

test('a step with multiple retained artifact attempts links out labelled "attempt N of Y", not "View full artifact"', () => {
  const item = {
    ...baseItem,
    cursor: 12,
    stepOutputs: { 11: { output: 'did the thing', artifact: '# plan v2', attempt: 2, attemptCount: 2 } },
  }
  const { getByRole, queryByRole } = renderTracker(item)
  const link = getByRole('link', { name: 'attempt 2 of 2 ↗' })
  expect(link.getAttribute('href')).toBe('https://example.test/artifact')
  expect(queryByRole('link', { name: 'View full artifact ↗' })).toBeNull()
})

test('the plain "· attempt N" badge is suppressed once the artifact link already carries the attempt count', () => {
  const item = {
    ...baseItem,
    cursor: 12,
    stepOutputs: { 11: { output: 'did the thing', artifact: '# plan v2', attempt: 2, attemptCount: 2 } },
  }
  const { queryByText } = renderTracker(item)
  expect(queryByText('· attempt 2')).toBeNull()
})

test('a done step with repeated attempts but no artifact still shows the plain "· attempt N" badge', () => {
  const item = {
    ...baseItem,
    cursor: 12,
    stepOutputs: { 11: { output: 'did the thing', attempt: 2, attemptCount: 0 } },
  }
  const { getByText } = renderTracker(item)
  expect(getByText('· attempt 2')).toBeTruthy()
})

// ---- HZ-25: real event colors (server-persisted hex) resolve through the theme ----

test('a real event with a legacy server hex color renders the themed token, not the raw hex, under dark mode', () => {
  document.documentElement.dataset.theme = 'dark'
  try {
    const item = {
      ...baseItem,
      events: [
        { created_at: '2026-01-01 00:00:00', who: 'PM Agent', text: 'proposed a plan', color: '#2E6CB2', initials: 'PM' },
      ],
    }
    const { container } = renderTracker(item)
    const avatar = container.querySelector('.activity-row__avatar')
    expect(avatar.getAttribute('style')).toContain('var(--primary)')
    expect(avatar.getAttribute('style')).not.toContain('#2E6CB2')
  } finally {
    delete document.documentElement.dataset.theme
  }
})
