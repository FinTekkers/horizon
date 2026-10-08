// Smoke test for the persona confirm control at the intake gate — the human
// leg of HZ-4's specialist routing (QA condition 1: this replaces any
// "manually verified" claim) — plus the HZ-14 "See agent output" links that
// replaced inline step output and the HZ-5 Live activity panel.
//
// HZ-125: personas are agent-scoped, so the gate shows ONE control per persona
// agent, each labelled with that agent's own name and offering only its own
// bucket. These render the real component, so they are the UI-layer proof of
// success metric 11 — not just the domain module's filter logic.

import { expect, test, vi } from 'vitest'
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { afterEach } from 'vitest'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: (itemId, stepIndex) => `https://example.test/api/items/${itemId}/steps/${stepIndex}/output`,
  runLogViewUrl: (runId) => `https://example.test/api/runs/${runId}/log/view`,
  // HZ-318: only items without a stepOutputs field open their stream; each
  // test that needs it sets an implementation.
  subscribeStepOutputs: vi.fn(),
}))

import Tracker from './Tracker'
import { subscribeStepOutputs } from '../api'
import { ACCEPT_GATE_INDEX, DEPLOY_STEP_INDEX, IMPLEMENT_STEP_INDEX, REVIEW_STEP_INDEX } from '../../../domain/js/lifecycle.js'
// HZ-132: reason ids come from domain/reasons.json via the binding, never typed
// here — a second hand-copy of the vocabulary inside ui/src is exactly the
// drift this repo now forbids.
import { REASON, REASON_IDS } from '../../../domain/js/reasons.js'
import { DEFAULT_PERSONAS, PERSONAS, PERSONA_AGENT_ROLES, PRIMARY_PERSONA_AGENT } from '../domain/personas'
import { AGENTS } from '../domain/agentTokens'

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

// The picker's label for one agent's control, built from that agent's own
// lifecycle name rather than a second hand-typed copy of it.
const pickerLabel = (agent) => `${AGENTS[PERSONA_AGENT_ROLES[agent]].label} persona`

test('the intake gate shows one persona select per agent, defaulting to the proposed persona', () => {
  const { getByLabelText } = renderTracker({ ...baseItem, personas: { eng: 'python' } })
  for (const agent of Object.keys(PERSONAS)) {
    expect(getByLabelText(pickerLabel(agent))).toBeTruthy()
  }
  expect(getByLabelText(pickerLabel('eng')).value).toBe('python')
})

test('each agent’s select offers only that agent’s own personas', () => {
  const { getByLabelText } = renderTracker({ ...baseItem, personas: { eng: 'python' } })
  for (const agent of Object.keys(PERSONAS)) {
    const offered = Array.from(getByLabelText(pickerLabel(agent)).options).map((o) => o.value)
    expect(offered.sort()).toEqual(Object.keys(PERSONAS[agent]).sort())
  }
})

test('an item with no personas defaults every select to that agent’s default', () => {
  const { getByLabelText } = renderTracker(baseItem)
  expect(getByLabelText(pickerLabel('eng')).value).toBe('fullstack')
  expect(getByLabelText(pickerLabel('qa')).value).toBe('e2e_journey')
  expect(getByLabelText(pickerLabel('architect')).value).toBe('data_modelling')
  expect(getByLabelText(pickerLabel('pm')).value).toBe('roadmap')
})

test('changing a select fires setPersona with that agent and the chosen id', () => {
  const spy = vi.fn()
  const { getByLabelText } = renderTracker({ ...baseItem, personas: { eng: 'python' } }, spy)
  fireEvent.change(getByLabelText(pickerLabel('eng')), { target: { value: 'ui' } })
  expect(spy).toHaveBeenCalledWith('T-1', 'eng', 'ui')
  fireEvent.change(getByLabelText(pickerLabel('qa')), { target: { value: 'data_integrity' } })
  expect(spy).toHaveBeenCalledWith('T-1', 'qa', 'data_integrity')
})

test('the selects are absent when the item is past the intake gate', () => {
  const { queryByLabelText } = renderTracker({ ...baseItem, cursor: 4, personas: { eng: 'python' } })
  for (const agent of Object.keys(PERSONAS)) {
    expect(queryByLabelText(pickerLabel(agent))).toBeNull()
  }
})

// The header badge is a separate render of the persona from the picker: it
// shows the item's primary (Eng) specialization whatever the gate is doing. An
// item carrying a different persona per agent is the case that tells a
// regression to another agent's slot apart from a correct render.
test('the tracker header badge shows the Eng persona, not another agent’s', () => {
  const { container } = renderTracker({
    ...baseItem,
    personas: { eng: 'ui', qa: 'data_integrity', architect: 'distributed_systems', pm: 'feature_development' },
  })
  const header = container.querySelector('.tracker__header')
  expect(header.textContent).toContain(PERSONAS[PRIMARY_PERSONA_AGENT].ui.label)
  expect(header.textContent).not.toContain(PERSONAS.qa.data_integrity.label)
  expect(header.textContent).not.toContain(PERSONAS.architect.distributed_systems.label)
})

test('the header badge falls back to the Eng default when the item carries no Eng persona', () => {
  const { container } = renderTracker({ ...baseItem, personas: { qa: 'data_integrity' } })
  const header = container.querySelector('.tracker__header')
  expect(header.textContent).toContain(PERSONAS[PRIMARY_PERSONA_AGENT][DEFAULT_PERSONAS[PRIMARY_PERSONA_AGENT]].label)
})

// HZ-121: no shipped persona is testOnly anymore, so this test proves the
// filter itself (Tracker.jsx's `.filter(([, p]) => !p.testOnly)`) against a
// synthetic entry rather than relying on a real one to exist. HZ-125 applies it
// per agent bucket, so the fixture is registered inside one.
test('the persona picker never offers a testOnly persona', () => {
  PERSONAS.eng.__fixture_test_only__ = { label: 'Fixture (test-only)', initials: 'FX', color: '#000', testOnly: true }
  try {
    const { getByLabelText } = renderTracker({ ...baseItem, personas: { eng: 'python' } })
    for (const agent of Object.keys(PERSONAS)) {
      const offered = Array.from(getByLabelText(pickerLabel(agent)).options).map((o) => o.value)
      expect(offered).not.toContain('__fixture_test_only__')
    }
  } finally {
    delete PERSONAS.eng.__fixture_test_only__
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

test('a PR with merge conflicts at the Accept gate offers "Resolve conflicts…", and clicking it fires onResolveConflicts', () => {
  const item = { ...baseItem, cursor: ACCEPT_GATE_INDEX, pr: 42, pr_mergeable: false }
  const spy = vi.fn()
  const { getByText } = renderTracker(item, noop, noop, spy)
  fireEvent.click(getByText('Resolve conflicts…'))
  expect(spy).toHaveBeenCalledWith('T-1', 42)
})

test('a mergeable PR at the Accept gate shows no conflict-resolution button', () => {
  const item = { ...baseItem, cursor: ACCEPT_GATE_INDEX, pr: 42, pr_mergeable: true }
  const { queryByText } = renderTracker(item)
  expect(queryByText('Resolve conflicts…')).toBeNull()
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

// ---- HZ-343: the banner finds the pause event under newer events, and a
// multi-line check-failure cause still renders ----

const FORWARD_REFUSED_EVENT = {
  created_at: '2026-10-07 10:05:00',
  text: 'forward to “Accept the code” refused — the review still has blocking findings; “Specialist agent implements” restarts with the review findings',
}
const LS98_SECRETS_LINE = 'bash: scripts/checks/secrets.sh: No such file or directory'

function failurePauseEvent(cause) {
  return { created_at: '2026-10-07 10:00:00', text: `agent step failed: ${cause} — item paused; resume to retry` }
}

test('an LS-98-shaped item shows its multi-line cause under two newer forward-refused events', () => {
  const cause = ['repo checks failed: ./gradlew check exited 127', '> Task :test', LS98_SECRETS_LINE, 'BUILD FAILED in 4s'].join('\n')
  const item = { ...baseItem, paused: true, events: [FORWARD_REFUSED_EVENT, FORWARD_REFUSED_EVENT, failurePauseEvent(cause)] }
  const { container, queryByText } = renderTracker(item)
  expect(container.querySelector('.pause-banner__detail').textContent).toContain(LS98_SECRETS_LINE)
  expect(queryByText(/No failure details were recorded/)).toBeNull()
})

test('the "No failure details" fallback shows only when no pause event exists since the last resume', () => {
  const withoutPause = { ...baseItem, paused: true, events: [FORWARD_REFUSED_EVENT, { created_at: '2026-10-07 09:00:00', text: 'resumed work' }, failurePauseEvent('old cause')] }
  const absent = renderTracker(withoutPause)
  expect(absent.getByText(/No failure details were recorded for this pause/)).toBeTruthy()
  expect(absent.container.querySelector('.pause-banner__detail').textContent).not.toContain('old cause')
  cleanup()

  const withPause = { ...baseItem, paused: true, events: [FORWARD_REFUSED_EVENT, failurePauseEvent('new cause')] }
  const present = renderTracker(withPause)
  expect(present.container.querySelector('.pause-banner__detail').textContent).toContain('new cause')
  expect(present.queryByText(/No failure details were recorded/)).toBeNull()
})

test('a manual pause under newer events still shows no pause banner', () => {
  const item = {
    ...baseItem,
    paused: true,
    events: [FORWARD_REFUSED_EVENT, FORWARD_REFUSED_EVENT, { created_at: '2026-10-07 10:00:00', text: 'paused agent work on this item' }],
  }
  const { container } = renderTracker(item)
  expect(container.querySelector('.pause-banner')).toBeNull()
})

test('a cause containing markup renders as literal text, never as HTML', () => {
  const item = { ...baseItem, paused: true, events: [failurePauseEvent('<b>x</b>')] }
  const { container } = renderTracker(item)
  expect(container.querySelector('.pause-banner__detail').textContent).toContain('<b>x</b>')
  expect(container.querySelector('.pause-banner b')).toBeNull()
})

test('the retry count comes from the retries just below a pause that is not the newest event', () => {
  const cause = `repo checks failed\n${LS98_SECRETS_LINE}`
  const item = {
    ...baseItem,
    paused: true,
    events: [
      FORWARD_REFUSED_EVENT,
      FORWARD_REFUSED_EVENT,
      failurePauseEvent(cause),
      { created_at: '2026-10-07 09:59:00', text: `transient failure (${REASON.TIMEOUT}): ${cause} — auto-retrying (2/3)` },
      { created_at: '2026-10-07 09:58:00', text: `transient failure (${REASON.TIMEOUT}): ${cause} — auto-retrying (1/3)` },
    ],
  }
  const { container } = renderTracker(item)
  expect(container.querySelector('.pause-banner__meta').textContent).toContain('Auto-retried 2 times')
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

// ---- HZ-185: forward a rejected review to Accept the code ----

function renderWithForward(item, onForwardToAccept) {
  return render(
    <Tracker
      item={item}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onResolveConflicts={noop}
      onForwardToAccept={onForwardToAccept}
      onTogglePause={noop}
      onRestartPhase={noop}
      onSetPersona={noop}
      onAbandon={noop}
    />,
  )
}

const rejectedItem = { ...baseItem, cursor: IMPLEMENT_STEP_INDEX, reviewRejected: true }

test('the forward button disables while its request runs, and two clicks make one call (R11)', async () => {
  let settle
  const onForward = vi.fn(() => new Promise((resolve) => (settle = resolve)))
  const { getByRole } = renderWithForward(rejectedItem, onForward)
  const button = getByRole('button', { name: 'Forward to Accept the code' })

  fireEvent.click(button)
  fireEvent.click(button)

  expect(onForward).toHaveBeenCalledTimes(1)
  expect(onForward).toHaveBeenCalledWith('T-1')
  expect(button.disabled).toBe(true)
  expect(button.getAttribute('aria-busy')).toBe('true')

  // A 409 settles the request: the button comes back and says why.
  settle({ error: 'branch_moved' })
  await waitFor(() => expect(button.disabled).toBe(false))
  expect(getByRole('alert').textContent).toMatch(/moved past the reviewed commit/)
  fireEvent.click(button)
  expect(onForward).toHaveBeenCalledTimes(2)
})

test('a failed forward request re-enables the button too', async () => {
  const onForward = vi.fn(() => Promise.reject(new Error('network down')))
  const { getByRole } = renderWithForward(rejectedItem, onForward)
  const button = getByRole('button', { name: 'Forward to Accept the code' })
  fireEvent.click(button)
  await waitFor(() => expect(button.disabled).toBe(false))
  expect(getByRole('alert').textContent).toMatch(/did not go through/)
})

test('the forward button is absent when the latest review did not reject (O2)', () => {
  const { queryByRole } = renderWithForward({ ...rejectedItem, reviewRejected: false }, vi.fn())
  expect(queryByRole('button', { name: 'Forward to Accept the code' })).toBeNull()
})

test("the Accept gate shows who forwarded it and the forwarded run's findings, not the newest review (R12)", () => {
  const { container, getByText } = renderWithForward(
    {
      ...baseItem,
      cursor: ACCEPT_GATE_INDEX,
      stepOutputs: { [REVIEW_STEP_INDEX]: { output: 'newer', attempt: 2, artifact: '## Newest review\n- not this one', attemptCount: 2 } },
      forwardedReview: { runId: 41, by: 'Alice', sha: 'abc', attempt: 1, artifact: '## Code review\n- **unchecked input** in x.js' },
    },
    vi.fn(),
  )
  expect(getByText(/Forwarded by Alice with the failing review \(run #41\)/)).toBeTruthy()
  const body = container.querySelector('.step-card__forwarded-body')
  expect(body.textContent).toContain('unchecked input in x.js')
  expect(body.querySelector('strong').textContent).toBe('unchecked input')
  expect(container.querySelector('.step-card__forwarded').textContent).not.toContain('Newest review')
})

// HZ-208: the tracker row for an item names its project — for each project.
test('the tracker row shows a badge with the item’s own project name', () => {
  const projects = [
    { id: 1, name: 'Alpha', enabled: true },
    { id: 2, name: 'Beta', enabled: true },
  ]
  for (const [id, projectId, name] of [['AL-1', 1, 'Alpha'], ['BE-1', 2, 'Beta']]) {
    const { container, unmount } = render(
      <Tracker
        item={{ ...baseItem, id, project_id: projectId }}
        projects={projects}
        onBack={noop}
        onApprove={noop}
        onApproveWithComments={noop}
        onReject={noop}
        onResolveConflicts={noop}
        onTogglePause={noop}
        onRestartPhase={noop}
        onSetPersona={noop}
        onAbandon={noop}
      />,
    )
    const row = container.querySelector('.tracker__meta')
    expect(row.querySelector('.tracker__id').textContent).toBe(id)
    expect([...row.querySelectorAll('.proj-badge')].map((b) => b.textContent)).toEqual([name])
    unmount()
  }
})

// ---- HZ-310: remove a dependency from the item view ----

test('clicking X beside a blocker in the item view calls onRemoveDependency(item.id, depId)', () => {
  const spy = vi.fn().mockResolvedValue({ ok: true })
  const item = {
    ...baseItem,
    blockedBy: [
      { id: 'T-B1', title: 'First blocker', abandoned: false },
      { id: 'T-B2', title: 'Second blocker', abandoned: false },
    ],
    dependents: [],
  }
  const { getAllByRole, getByRole } = render(
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
      onRemoveDependency={spy}
    />,
  )
  expect(getAllByRole('button', { name: /^Remove dependency on / })).toHaveLength(2)
  fireEvent.click(getByRole('button', { name: 'Remove dependency on T-B2' }))
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy).toHaveBeenCalledWith('T-1', 'T-B2')
})

test('a failed remove does not carry its error or disabled X over to the next item', async () => {
  const spy = vi.fn().mockRejectedValue(new Error('not_found'))
  const blockedBy = [{ id: 'T-B1', title: 'Shared blocker', abandoned: false }]
  const props = {
    onBack: noop,
    onApprove: noop,
    onApproveWithComments: noop,
    onReject: noop,
    onResolveConflicts: noop,
    onTogglePause: noop,
    onRestartPhase: noop,
    onSetPersona: noop,
    onAbandon: noop,
    onRemoveDependency: spy,
  }
  const { rerender, getByRole, findByText, queryByText } = render(
    <Tracker item={{ ...baseItem, blockedBy, dependents: [] }} {...props} />,
  )
  fireEvent.click(getByRole('button', { name: 'Remove dependency on T-B1' }))
  await findByText(/Couldn't remove: not_found/)

  rerender(<Tracker item={{ ...baseItem, id: 'T-2', blockedBy, dependents: [] }} {...props} />)
  expect(queryByText(/Couldn't remove/)).toBeNull()
  expect(getByRole('button', { name: 'Remove dependency on T-B1' }).disabled).toBe(false)
})

// ---- HZ-318: the slim board feed has no stepOutputs; the Tracker loads them ----

// A fake per-item stream per id: push(id, outputs) sends a frame, closed(id)
// says whether the Tracker closed it.
function fakeStreams() {
  const open = {}
  subscribeStepOutputs.mockReset().mockImplementation((id, onOutputs) => {
    const close = vi.fn()
    open[id] = { onOutputs, close }
    return close
  })
  return {
    push: (id, outputs) => act(async () => open[id].onOutputs(outputs)),
    closed: (id) => open[id].close.mock.calls.length > 0,
  }
}

const slimItem = (id, extra = {}) => {
  const { stepOutputs, ...rest } = { ...baseItem, id, cursor: 12, ...extra }
  return rest
}

const trackerProps = {
  onBack: noop,
  onApprove: noop,
  onApproveWithComments: noop,
  onReject: noop,
  onResolveConflicts: noop,
  onTogglePause: noop,
  onRestartPhase: noop,
  onSetPersona: noop,
  onAbandon: noop,
}

test('an item without stepOutputs streams them, showing no "no output recorded" while loading', async () => {
  const streams = fakeStreams()
  const { queryAllByText, findByRole, queryByRole } = renderTracker(slimItem('T-1'))
  expect(subscribeStepOutputs).toHaveBeenCalledTimes(1)
  expect(subscribeStepOutputs.mock.calls[0][0]).toBe('T-1')
  expect(queryAllByText(/no output recorded/)).toHaveLength(0)
  expect(queryByRole('link', { name: 'See agent output ↗' })).toBeNull()

  await streams.push('T-1', { 11: { output: 'did the thing', artifact: '# v2', attempt: 2, attemptCount: 2 } })
  expect((await findByRole('link', { name: 'See agent output ↗' })).getAttribute('href')).toBe(
    'https://example.test/api/items/T-1/steps/11/output',
  )
  expect(queryByRole('link', { name: 'attempt 2 of 2 ↗' })).not.toBeNull()
  // Done steps with nothing recorded say so once loaded, as before.
  expect(queryAllByText(/no output recorded/).length).toBeGreaterThan(0)
})

test('a later frame on the open stream updates the cards; a board change to the item reopens nothing', async () => {
  const streams = fakeStreams()
  const { rerender, queryByRole, findByRole } = render(<Tracker item={slimItem('T-1')} {...trackerProps} />)
  await streams.push('T-1', { 11: { output: 'first', artifact: '# v1', attempt: 1, attemptCount: 1 } })
  await findByRole('link', { name: 'View full artifact ↗' })
  rerender(<Tracker item={slimItem('T-1', { title: 'renamed on the board' })} {...trackerProps} />)
  await streams.push('T-1', { 11: { output: 'second', artifact: '# v2', attempt: 2, attemptCount: 2 } })
  expect(queryByRole('link', { name: 'attempt 2 of 2 ↗' })).not.toBeNull()
  expect(subscribeStepOutputs).toHaveBeenCalledTimes(1)
  expect(streams.closed('T-1')).toBe(false)
})

test('switching items fast closes the old stream, and a late frame for it never shows on the new one', async () => {
  const streams = fakeStreams()
  const { rerender, queryByRole, findByRole } = render(<Tracker item={slimItem('T-A')} {...trackerProps} />)
  rerender(<Tracker item={slimItem('T-B')} {...trackerProps} />)
  expect(streams.closed('T-A')).toBe(true)

  await streams.push('T-B', { 11: { output: 'B output', artifact: '# B', attempt: 1, attemptCount: 1 } })
  await findByRole('link', { name: 'View full artifact ↗' })
  await streams.push('T-A', { 11: { output: 'A output', artifact: '# A', attempt: 3, attemptCount: 3 } })

  expect(queryByRole('link', { name: 'attempt 3 of 3 ↗' })).toBeNull()
  expect(queryByRole('link', { name: 'View full artifact ↗' })).not.toBeNull()
  expect(queryByRole('link', { name: 'See agent output ↗' }).getAttribute('href')).toBe(
    'https://example.test/api/items/T-B/steps/11/output',
  )
})

test('leaving the item (back to the Board) closes its stream', () => {
  const streams = fakeStreams()
  const { unmount } = render(<Tracker item={slimItem('T-1')} {...trackerProps} />)
  expect(streams.closed('T-1')).toBe(false)
  unmount()
  expect(streams.closed('T-1')).toBe(true)
})

test('an item that still carries stepOutputs (a server from before HZ-318) opens no stream', () => {
  subscribeStepOutputs.mockReset()
  renderTracker({ ...baseItem, cursor: 12, stepOutputs: { 11: { output: 'x', attempt: 1 } } })
  expect(subscribeStepOutputs).not.toHaveBeenCalled()
})

// ---- HZ-335: a dependency-blocked item reads Blocked, with no Pause work ----

const blockedAt = (extra = {}) => ({
  ...baseItem,
  cursor: IMPLEMENT_STEP_INDEX,
  blocked: true,
  blockedBy: [{ id: 'T-0', title: 'The prerequisite', abandoned: false }],
  dependents: [],
  ...extra,
})

test('a blocked item shows the Blocked status and no Pause work', () => {
  const { container, queryByText, getByText } = renderTracker(blockedAt())
  expect(container.querySelector('.tracker__status').textContent).toBe('Blocked')
  expect(queryByText('Pause work')).toBeNull()
  expect(queryByText('Resume work')).toBeNull()
  expect(getByText('Abandon')).toBeTruthy()
})

test('a paused and blocked item still shows Resume work', () => {
  const { container, getByText, queryByText } = renderTracker(blockedAt({ paused: true }))
  expect(container.querySelector('.tracker__status').textContent).toBe('Paused')
  expect(getByText('Resume work')).toBeTruthy()
  expect(queryByText('Pause work')).toBeNull()
})

test.each([
  ['blocked: false', { blocked: false }],
  ['blocked absent', {}],
])('a non-blocked agent-step item (%s) still shows Pause work', (_, extra) => {
  const item = { ...baseItem, cursor: IMPLEMENT_STEP_INDEX, ...extra }
  const { getByText, queryByText } = renderTracker(item)
  expect(getByText('Pause work')).toBeTruthy()
  expect(queryByText('Resume work')).toBeNull()
})

// HZ-333: an item waiting in its deploy target's queue says so on its current
// step, with the window's close time in the viewer's local HH:MM.
test('a queued deploy step shows "waiting for next <target> deploy" and when the window closes', () => {
  const closes = new Date(2026, 9, 7, 14, 5).toISOString()
  const item = {
    ...baseItem,
    cursor: DEPLOY_STEP_INDEX,
    deploy_queue: { target: 'horizon', status: 'queued', batch_status: 'open', window_closes_at: closes, tag: null },
  }
  const { container } = renderTracker(item)
  const label = container.querySelector('.step-card__deploy-queue')
  expect(label?.textContent).toBe(' · waiting for next horizon deploy · window closes 14:05')
})

test('an item not in a deploy queue shows no queue label', () => {
  const { container } = renderTracker({ ...baseItem, cursor: DEPLOY_STEP_INDEX, deploy_queue: null })
  expect(container.querySelector('.step-card__deploy-queue')).toBeNull()
  expect(container.textContent).not.toMatch(/waiting for next/)
})
