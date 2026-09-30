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
import { ACCEPT_GATE_INDEX } from '../../../domain/js/lifecycle.js'
// HZ-132: reason ids come from domain/reasons.json via the binding, never typed
// here — a second hand-copy of the vocabulary inside ui/src is exactly the
// drift this repo now forbids.
import { REASON, REASON_IDS } from '../../../domain/js/reasons.js'
import { PERSONAS } from '../domain/personas'

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

function renderTracker(item, onSetPersona = noop, onAbandon = noop, onResolveConflicts = noop) {
  return render(
    <Tracker
      item={item}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onResolveConflicts={onResolveConflicts}
      onTogglePause={noop}
      onRestartPhase={noop}
      onSetPersona={onSetPersona}
      onAbandon={onAbandon}
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

// HZ-121: no shipped persona is testOnly anymore, so this test proves the
// filter itself (Tracker.jsx's `.filter(([, p]) => !p.testOnly)`) against a
// synthetic entry rather than relying on a real one to exist.
test('the persona picker never offers a testOnly persona', () => {
  PERSONAS.__fixture_test_only__ = { label: 'Fixture (test-only)', initials: 'FX', color: '#000', testOnly: true }
  try {
    const { getByLabelText } = renderTracker({ ...baseItem, persona: 'python_backend' })
    const options = Array.from(getByLabelText('Specialist persona').options).map((o) => o.value)
    expect(options).not.toContain('__fixture_test_only__')
  } finally {
    delete PERSONAS.__fixture_test_only__
  }
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

// ---- resolve conflicts (HZ-92) ----

test('a PR with merge conflicts at the Accept gate offers "Send back to resolve conflicts", and clicking it fires onResolveConflicts', () => {
  const item = { ...baseItem, cursor: ACCEPT_GATE_INDEX, pr: 42, pr_mergeable: false }
  const spy = vi.fn()
  const { getByText } = renderTracker(item, noop, noop, spy)
  fireEvent.click(getByText('Send back to resolve conflicts'))
  expect(spy).toHaveBeenCalledWith('T-1', 42)
})

test('a mergeable PR at the Accept gate shows no conflict-resolution button', () => {
  const item = { ...baseItem, cursor: ACCEPT_GATE_INDEX, pr: 42, pr_mergeable: true }
  const { queryByText } = renderTracker(item)
  expect(queryByText('Send back to resolve conflicts')).toBeNull()
})

// ---- abandon (HZ-59) ----

test('a live item shows an Abandon button, and clicking it fires onAbandon with the item id', () => {
  const spy = vi.fn()
  const { getByText } = renderTracker(baseItem, noop, spy)
  fireEvent.click(getByText('Abandon'))
  expect(spy).toHaveBeenCalledWith('T-1')
})

test('an abandoned item hides Pause/Resume and Abandon, and shows the reason instead', () => {
  const item = { ...baseItem, cursor: 11, abandoned_at: '2026-01-01 00:00:00', abandoned_reason: 'no longer needed', abandoned_by: 'Dana' }
  const { queryByText, getByText } = renderTracker(item)
  expect(queryByText('Abandon')).toBeNull()
  expect(queryByText('Pause work')).toBeNull()
  expect(queryByText('Resume work')).toBeNull()
  expect(getByText(/Abandoned by Dana: no longer needed/)).toBeTruthy()
})

test('an abandoned item offers no "Restart phase" button — reopening must be a deliberate act, not a leftover lever', () => {
  const item = { ...baseItem, cursor: 11, abandoned_at: '2026-01-01 00:00:00', abandoned_reason: 'stopping this' }
  const { queryByText } = renderTracker(item)
  expect(queryByText('Restart phase')).toBeNull()
})

// ---- HZ-54: queued vs running ----
// A dispatched step the farm reports as still queued must read "Queued", not
// "In progress…" — the exact confusion the ticket was filed against.

// Steps not yet reached also render a "Queued" meta label (a different,
// pre-existing concept — see STEP_META.pending), so these assertions scope
// to the active step's own card rather than searching the whole document.
function activeStepCard(getByText) {
  return getByText('Specialist agent implements').closest('.step-card')
}

test('a dispatched-but-queued step reads "Queued", not "In progress…", with the farm-reported reason', () => {
  const item = {
    ...baseItem,
    cursor: 11,
    activeRun: {
      id: 7,
      step_index: 11,
      attempt: 1,
      started_at: new Date().toISOString(),
      state: 'queued',
      reason: 'waiting for a free agent slot (4/4 in use)',
    },
  }
  const { getByText } = renderTracker(item)
  const card = activeStepCard(getByText)
  expect(card.textContent).toContain('Queued')
  expect(card.textContent).toContain('waiting for a free agent slot (4/4 in use)')
  expect(card.textContent).not.toContain('In progress…')
})

test('a dispatched step the farm reports as running still reads "In progress…"', () => {
  const item = {
    ...baseItem,
    cursor: 11,
    activeRun: { id: 7, step_index: 11, attempt: 1, started_at: new Date().toISOString(), state: 'running', reason: null },
  }
  const { getByText } = renderTracker(item)
  const card = activeStepCard(getByText)
  expect(card.textContent).toContain('In progress…')
  expect(card.textContent).not.toContain('Queued')
})

test('an active step with no farm state at all (mock mode / farm silent) defaults to "In progress…" — fail soft', () => {
  const item = { ...baseItem, cursor: 11, activeRun: { id: 7, step_index: 11, attempt: 1, started_at: new Date().toISOString() } }
  const { getByText } = renderTracker(item)
  const card = activeStepCard(getByText)
  expect(card.textContent).toContain('In progress…')
  expect(card.textContent).not.toContain('Queued')
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

// ---- HZ-94: a paused item explains itself, not just "Paused" ----

test(`a ${REASON.TURN_CAP} pause renders its own distinct message naming the category, cause and next action`, () => {
  const item = {
    ...baseItem,
    paused: true,
    events: [
      {
        created_at: '2026-01-01 00:00:00',
        text: `agent step failed (${REASON.TURN_CAP}): ran out of turns — auto-retry budget (3) exhausted; item paused, resume to retry`,
      },
      { created_at: '2026-01-01 00:00:00', text: `transient failure (${REASON.TURN_CAP}): ran out of turns — auto-retrying (3/3)` },
      { created_at: '2026-01-01 00:00:00', text: `transient failure (${REASON.TURN_CAP}): ran out of turns — auto-retrying (2/3)` },
      { created_at: '2026-01-01 00:00:00', text: `transient failure (${REASON.TURN_CAP}): ran out of turns — auto-retrying (1/3)` },
    ],
  }
  const { container } = renderTracker(item)
  const banner = container.querySelector('.pause-banner')
  expect(banner.querySelector('.pause-banner__title').textContent).toBe('Ran out of turns')
  expect(banner.querySelector('.pause-banner__detail').textContent).toContain('ran out of turns')
  expect(banner.querySelector('.pause-banner__meta').textContent).toContain('retry budget exhausted')
  expect(banner.querySelector('.pause-banner__meta').textContent).toContain('Resume to retry')
})

// HZ-132: driven off REASON_IDS rather than a hand-typed four. That widens it
// from the retryable set to EVERY declared reason — required_input_incomplete
// renders a banner too — and makes it success criterion 5 at the render layer:
// a reason added to domain/reasons.json with no pause-banner copy collapses two
// titles into one and fails here.
test('every declared pause category renders a distinct banner title from the others', () => {
  const titles = REASON_IDS.map((reason) => {
    const item = {
      ...baseItem,
      paused: true,
      events: [{ created_at: '2026-01-01 00:00:00', text: `agent step failed (${reason}): x — item paused; resume to retry` }],
    }
    const { container } = renderTracker(item)
    const title = container.querySelector('.pause-banner__title').textContent
    cleanup()
    return title
  })
  expect(new Set(titles).size).toBe(REASON_IDS.length)
})

test('an unrecognized pause reason degrades to the raw cause rather than a blank banner', () => {
  const item = {
    ...baseItem,
    paused: true,
    events: [
      { created_at: '2026-01-01 00:00:00', text: 'agent step failed (not_a_real_reason): something odd happened — item paused; resume to retry' },
    ],
  }
  const { container } = renderTracker(item)
  expect(container.querySelector('.pause-banner__detail').textContent).toContain('something odd happened')
})

test('a pause with no classified reason still shows the real failure cause, never a blank banner', () => {
  const item = {
    ...baseItem,
    paused: true,
    events: [{ created_at: '2026-01-01 00:00:00', text: 'agent step failed: repo checks failed: eslint exited 1 — item paused; resume to retry' }],
  }
  const { container } = renderTracker(item)
  expect(container.querySelector('.pause-banner__detail').textContent).toContain('repo checks failed: eslint exited 1')
})

test('the banner never reads as just "Paused" with nothing else — a title alone is always paired with real detail text', () => {
  const item = {
    ...baseItem,
    paused: true,
    events: [{ created_at: '2026-01-01 00:00:00', text: 'agent step failed: repo checks failed — item paused; resume to retry' }],
  }
  const { container } = renderTracker(item)
  const banner = container.querySelector('.pause-banner')
  expect(banner.textContent).not.toBe('Paused')
  expect(banner.querySelector('.pause-banner__detail').textContent.length).toBeGreaterThan(0)
})

test('a human-initiated manual pause (not a failure) shows no pause banner', () => {
  const item = {
    ...baseItem,
    paused: true,
    events: [{ created_at: '2026-01-01 00:00:00', text: 'paused agent work on this item' }],
  }
  const { container } = renderTracker(item)
  expect(container.querySelector('.pause-banner')).toBeNull()
})

test('the pause banner coexists with the Resume control and the activity feed, replacing neither', () => {
  const item = {
    ...baseItem,
    paused: true,
    events: [
      { created_at: '2026-01-01 00:00:00', text: `agent step failed (${REASON.TIMEOUT}): step timed out — item paused; resume to retry` },
    ],
  }
  const { getByText, container } = renderTracker(item)
  expect(getByText('Resume work')).toBeTruthy()
  expect(container.querySelector('.pause-banner')).toBeTruthy()
  expect(container.querySelector('.activity-row__text').textContent).toContain('agent step failed')
})

test('a paused item whose newest event matches no known shape still renders a non-empty banner, not blank', () => {
  const item = { ...baseItem, paused: true, events: [{ created_at: '2026-01-01 00:00:00', text: 'some unrelated event text' }] }
  const { container } = renderTracker(item)
  const banner = container.querySelector('.pause-banner')
  expect(banner).toBeTruthy()
  expect(banner.querySelector('.pause-banner__detail').textContent.length).toBeGreaterThan(0)
})

test('an unpaused item shows no pause banner', () => {
  const { container } = renderTracker({ ...baseItem, paused: false })
  expect(container.querySelector('.pause-banner')).toBeNull()
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

// ---- HZ-95: both dependency directions in the tracker detail view ----

test('an item blocked by another names the blocker and shows nothing under Blocks', () => {
  const item = { ...baseItem, blockedBy: [{ id: 'T-0', title: 'The prerequisite', abandoned: false }], dependents: [] }
  const { getByText, queryByText } = renderTracker(item)
  expect(getByText('Blocked by')).toBeTruthy()
  expect(getByText('The prerequisite')).toBeTruthy()
  expect(queryByText('Blocks')).toBeNull()
})

test('an item with dependents shows what is waiting behind it, with nothing under Blocked by', () => {
  const item = { ...baseItem, blockedBy: [], dependents: [{ id: 'T-2', title: 'The waiting item', abandoned: false }] }
  const { getByText, queryByText } = renderTracker(item)
  expect(getByText('Blocks')).toBeTruthy()
  expect(getByText('The waiting item')).toBeTruthy()
  expect(queryByText('Blocked by')).toBeNull()
})

test('an item with both a blocker and dependents shows both sections', () => {
  const item = {
    ...baseItem,
    blockedBy: [{ id: 'T-0', title: 'The prerequisite', abandoned: false }],
    dependents: [{ id: 'T-2', title: 'The waiting item', abandoned: false }],
  }
  const { getByText } = renderTracker(item)
  expect(getByText('Blocked by')).toBeTruthy()
  expect(getByText('The prerequisite')).toBeTruthy()
  expect(getByText('Blocks')).toBeTruthy()
  expect(getByText('The waiting item')).toBeTruthy()
})

test('an item with neither direction renders no dependency section at all', () => {
  const item = { ...baseItem, blockedBy: [], dependents: [] }
  const { container, queryByText } = renderTracker(item)
  expect(container.querySelector('.dep-detail')).toBeNull()
  expect(queryByText('Blocked by')).toBeNull()
  expect(queryByText('Blocks')).toBeNull()
})

test('an abandoned blocker is flagged in the detail view rather than silently dropped', () => {
  const item = { ...baseItem, blockedBy: [{ id: 'T-0', title: 'Dead end', abandoned: true }], dependents: [] }
  const { getByText } = renderTracker(item)
  expect(getByText(/Dead end/)).toBeTruthy()
  expect(getByText(/abandoned/)).toBeTruthy()
})

// ===== HZ-153: markdown in the description and the two tiles =====
//
// These render through components/Markdown.jsx, which maps marked's *lexer*
// tokens onto React elements. The security cases below are the point of that
// design: no HTML string exists at any stage, so raw markup can only ever
// become visible text.

test('a rich description renders real heading, list, emphasis, code, link and paragraph elements', () => {
  const desc = [
    '### A heading',
    '',
    'First paragraph with **bold**, `FARM_MAX_EPHEMERAL` and [a link](https://example.test).',
    '',
    '- first bullet',
    '- second bullet',
    '',
    'Second paragraph.',
  ].join('\n')
  const { container } = renderTracker({ ...baseItem, desc })

  // `###` is depth 3, clamped to h5 so it can never outrank the item title.
  expect(container.querySelector('.tracker__desc h5').textContent).toBe('A heading')
  expect(container.querySelector('.tracker__desc strong').textContent).toBe('bold')
  expect(container.querySelector('.tracker__desc code').textContent).toBe('FARM_MAX_EPHEMERAL')
  expect(container.querySelectorAll('.tracker__desc ul li')).toHaveLength(2)
  expect(container.querySelectorAll('.tracker__desc p').length).toBeGreaterThanOrEqual(2)

  const link = container.querySelector('.tracker__desc a')
  expect(link.getAttribute('href')).toBe('https://example.test')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')

  // No literal markup survives anywhere in the rendered description.
  const text = container.querySelector('.tracker__desc').textContent
  expect(text).not.toContain('###')
  expect(text).not.toContain('**')
  expect(text).not.toContain('`')
  expect(text).not.toMatch(/(^|\n)- /)
})

test('raw HTML in a description is inert visible text, in block and inline position', () => {
  const desc = 'Text with <img src=x onerror=alert(1)> inline.\n\n<script>alert(1)</script>'
  const { container } = renderTracker({ ...baseItem, desc })

  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('img')).toBeNull()
  // textContent, not getByText: React may split these across sibling text
  // nodes, and this is the one assertion that must not silently pass.
  expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  expect(container.textContent).toContain('<script>alert(1)</script>')
})

test('only http(s) and mailto links are clickable; everything else keeps its label as text', () => {
  const desc = [
    '[click me](javascript:alert(1))',
    '[data one](data:text/html,hi)',
    '[mixed case](JavaScript:alert(1))',
    '[protocol relative](//evil.test)',
  ].join('\n\n')
  const { container } = renderTracker({ ...baseItem, desc })

  expect(container.querySelectorAll('.tracker__desc a')).toHaveLength(0)
  // Rejecting a link must not delete what it said.
  for (const label of ['click me', 'data one', 'mixed case', 'protocol relative']) {
    expect(container.textContent).toContain(label)
  }
})

test('a mailto link and a bare autolinked URL both render as safe external links', () => {
  const desc = 'Mail <a@b.test> or read https://example.test/docs'
  const { container } = renderTracker({ ...baseItem, desc })

  const links = Array.from(container.querySelectorAll('.tracker__desc a'))
  expect(links.map((a) => a.getAttribute('href'))).toEqual(['mailto:a@b.test', 'https://example.test/docs'])
  for (const a of links) {
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  }
})

test('inline formatting inside a list item is rendered, not flattened to its source text', () => {
  const desc = '- **bold** and `code`\n- plain'
  const { container } = renderTracker({ ...baseItem, desc })
  expect(container.querySelector('.tracker__desc li strong').textContent).toBe('bold')
  expect(container.querySelector('.tracker__desc li code').textContent).toBe('code')
})

test('nested and ordered lists keep their structure, with no literal bullet markers left', () => {
  const desc = '- outer\n  - inner\n\n1. one\n2. two'
  const { container } = renderTracker({ ...baseItem, desc })
  expect(container.querySelector('.tracker__desc ul ul li').textContent).toBe('inner')
  expect(container.querySelectorAll('.tracker__desc ol > li')).toHaveLength(2)
  expect(container.querySelector('.tracker__desc').textContent).not.toMatch(/(^|\n)\s*- /)
})

test('ampersands and angle brackets are not double-escaped', () => {
  const desc = 'A & B < C, and `a && b` in code.'
  const { container } = renderTracker({ ...baseItem, desc })
  const text = container.querySelector('.tracker__desc').textContent
  expect(text).toContain('A & B < C')
  expect(text).not.toContain('&amp;')
  expect(text).not.toContain('&lt;')
  expect(container.querySelector('.tracker__desc code').textContent).toBe('a && b')
})

test('an intra-word underscore is left alone rather than turned into emphasis', () => {
  const { container } = renderTracker({ ...baseItem, desc: 'Set FARM_MAX_EPHEMERAL to 4.' })
  expect(container.querySelector('.tracker__desc em')).toBeNull()
  expect(container.querySelector('.tracker__desc').textContent).toContain('FARM_MAX_EPHEMERAL')
})

test('a fenced code block renders as a pre/code pair keeping both lines', () => {
  const { container } = renderTracker({ ...baseItem, desc: '```\nline one\nline two\n```' })
  const code = container.querySelector('.tracker__desc pre > code')
  expect(code).not.toBeNull()
  expect(code.textContent).toBe('line one\nline two')
})

test('a markdown table falls back to its source text instead of crashing or vanishing', () => {
  const { container } = renderTracker({ ...baseItem, desc: '| a | b |\n| --- | --- |\n| 1 | 2 |' })
  expect(container.querySelector('.tracker__desc table')).toBeNull()
  expect(container.querySelector('.tracker__desc').textContent).toContain('| a | b |')
})

test('a top-level heading is demoted so it cannot outrank the item title', () => {
  const { container } = renderTracker({ ...baseItem, desc: '# One' })
  expect(container.querySelector('.tracker__desc h1, .tracker__desc h2')).toBeNull()
  expect(container.querySelector('.tracker__desc h3').textContent).toBe('One')
})

test('a null or undefined description renders nothing instead of throwing', () => {
  const { container } = renderTracker({ ...baseItem, desc: null, metric: undefined })
  expect(container.querySelector('.tracker__desc')).toBeNull()
  expect(container.querySelector('.tile__value')).toBeNull()
})

test('a plain-text description keeps both of its lines and gains no markup', () => {
  const { container } = renderTracker({ ...baseItem, desc: 'First line.\nSecond line.' })
  const desc = container.querySelector('.tracker__desc')
  expect(desc.textContent).toContain('First line.')
  expect(desc.textContent).toContain('Second line.')
  expect(desc.querySelector('ul')).toBeNull()
  expect(desc.querySelector('strong')).toBeNull()
})

test('the success metric and guardrails tiles each render their bullets as a real list', () => {
  const { container } = renderTracker({
    ...baseItem,
    metric: '- metric one\n- metric two',
    guardrails: '- only guardrail',
  })
  const tiles = container.querySelectorAll('.tile__value')
  expect(tiles).toHaveLength(2)
  expect(tiles[0].querySelectorAll('li')).toHaveLength(2)
  expect(tiles[1].querySelectorAll('li')).toHaveLength(1)
})

// Scope pin: HZ-153 covers the description and the two tiles only. The
// abandoned-reason line reuses .tile__value but is deliberately still plain
// text — if that ever changes, this test should be the thing that says so.
test('the abandoned reason stays plain text', () => {
  const { container } = renderTracker({
    ...baseItem,
    cursor: 11,
    abandoned_at: '2026-01-01 00:00:00',
    abandoned_reason: 'went **nowhere**',
    abandoned_by: 'a human',
  })
  expect(container.textContent).toContain('went **nowhere**')
  expect(container.querySelector('.tile__value strong')).toBeNull()
})
