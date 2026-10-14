// HZ-454: the pause-banner variants that used to be e2e cases in
// e2e/tests/13-pause-reason.spec.js — each one only checked how the banner
// renders one pause event, so it lives here now. The turn_cap case stays in
// e2e, where it drives the real Resume round-trip. The event text is the same
// text those specs seeded; the HZ-366 and HZ-373 cases read the farm's own
// check-output fixtures, as the e2e spec did.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(() => () => {}),
}))

import Tracker from './Tracker'
// Reason ids come from the binding, never typed here (HZ-132).
import { REASON } from '../../../domain/js/reasons.js'

afterEach(() => cleanup())

const CHECK_OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '../../../farm/tests/fixtures/check_output')
const fixture = (name) => readFileSync(join(CHECK_OUTPUT, name), 'utf8')
// HZ-366: the farm's message for HZ-365's failed e2e check.
const HZ365_MESSAGE = fixture('hz365_message.txt')
const HZ365_HEADLINE = HZ365_MESSAGE.split('\n')[0]
// HZ-373: the farm's message for US-207's failed e2e check, which no runner
// summary parses — its headline comes from the spec line that failed.
const US207_MESSAGE = fixture('us207_message.txt')
const US207_HEADLINE = US207_MESSAGE.split('\n')[0]

const noop = () => {}

// Events are newest first, as GET /api/items returns them.
function renderPaused(events) {
  return render(
    <Tracker
      item={{
        id: 'PAUSE-1',
        title: 'A paused item',
        desc: '',
        metric: '',
        guardrails: '',
        priority: 'Medium',
        cursor: 0,
        paused: true,
        rejected: false,
        events: events.map((event) => ({ created_at: '2026-10-14 10:00:00', ...event })),
        stepOutputs: {},
        activeRun: null,
      }}
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
}

test('a pause reason the UI does not recognize still shows the raw cause, never a blank banner', () => {
  const { container } = renderPaused([
    { text: 'agent step failed (some_future_reason): repo checks failed: eslint exited 1 — item paused; resume to retry' },
  ])
  const banner = container.querySelector('.pause-banner')
  expect(banner).toBeTruthy()
  expect(banner.textContent).not.toBe('Paused')
  expect(banner.querySelector('.pause-banner__detail').textContent).toContain('repo checks failed: eslint exited 1')
})

test(`a ${REASON.REQUIRED_INPUT_INCOMPLETE} pause names the artifact, its size, and the shortfall, and is never auto-retried`, () => {
  const { container, getByRole } = renderPaused([
    {
      text: `agent step failed (${REASON.REQUIRED_INPUT_INCOMPLETE}): required input incomplete: "Draft implementation plan" needs 40000 chars, only 20034 could be supplied (19966 short) — item paused; resume to retry`,
    },
  ])
  const banner = container.querySelector('.pause-banner')
  expect(banner.querySelector('.pause-banner__title').textContent).toBe('Required input incomplete')
  const detail = banner.querySelector('.pause-banner__detail').textContent
  expect(detail).toContain('a capacity limit, not a bug')
  expect(detail).toContain('"Draft implementation plan" needs 40000 chars, only 20034 could be supplied (19966 short)')
  expect(banner.querySelector('.pause-banner__meta').textContent).toContain('Not auto-retried')
  expect(getByRole('button', { name: 'Resume work' })).toBeTruthy()
})

test('a multi-line pause cause under two newer forward-refused events is still shown (LS-98)', () => {
  const forwardRefused = {
    text: 'forward to “Accept the code” refused — the review still has blocking findings; “Specialist agent implements” restarts with the review findings',
  }
  const { container, getByRole } = renderPaused([
    forwardRefused,
    forwardRefused,
    {
      text: [
        'agent step failed: repo checks failed: ./gradlew check exited 127',
        '> Task :test',
        'bash: scripts/checks/secrets.sh: No such file or directory',
        'BUILD FAILED in 4s — item paused; resume to retry',
      ].join('\n'),
    },
  ])
  const banner = container.querySelector('.pause-banner')
  expect(banner.querySelector('.pause-banner__detail').textContent).toContain('bash: scripts/checks/secrets.sh: No such file or directory')
  expect(banner.textContent).not.toContain('No failure details were recorded')
  expect(getByRole('button', { name: 'Resume work' })).toBeTruthy()
})

test("a check failure shows its headline — counts and the failing test — as the banner's first line (HZ-366)", () => {
  expect(HZ365_MESSAGE.length).toBeGreaterThan(0)
  expect(HZ365_HEADLINE.length).toBeGreaterThan(0)
  expect(HZ365_HEADLINE).toContain('2 failed')
  expect(HZ365_HEADLINE).toContain('31-rule-block.spec.js:131')

  // No detail: an event written before failFarmRun stored one.
  const { container, getByRole, queryByRole } = renderPaused([{ text: `agent step failed: ${HZ365_HEADLINE} — item paused; resume to retry` }])
  const banner = container.querySelector('.pause-banner')
  expect(banner.querySelector('.pause-banner__detail').textContent.split('\n')[0]).toBe(HZ365_HEADLINE)
  expect(banner.textContent).not.toContain('No failure details were recorded')
  expect(getByRole('button', { name: 'Resume work' })).toBeTruthy()
  // HZ-373: an event with no stored detail has no toggle to open.
  expect(queryByRole('button', { name: 'Show details' })).toBeNull()
})

test('a check failure with no runner summary shows its headline, never the command, and Show details opens the rest (HZ-373)', () => {
  expect(US207_MESSAGE.length).toBeGreaterThan(0)
  expect(US207_HEADLINE.length).toBeGreaterThan(0)

  // failFarmRun's event, exactly as it writes it: the headline line as text,
  // the whole message as detail.
  const { container, getByRole } = renderPaused([
    { text: `agent step failed: ${US207_HEADLINE} — item paused; resume to retry`, detail: US207_MESSAGE },
  ])
  const banner = container.querySelector('.pause-banner')
  expect(banner.querySelector('.pause-banner__cause').textContent).toBe(
    'repo checks failed: e2e failed (exit 1): sidebar-links-after-login.spec.ts: 0/1 passed',
  )
  expect(banner.textContent).not.toContain('sh -c')
  expect(banner.textContent).not.toContain('git show')

  // A digest line the headline leaves out, only behind the toggle.
  const leftOut = 'screenshot "securities-list" not captured'
  expect(US207_MESSAGE).toContain(leftOut)
  expect(banner.textContent).not.toContain(leftOut)
  fireEvent.click(getByRole('button', { name: 'Show details' }))
  expect(banner.querySelector('.pause-banner__full-error').textContent).toContain(leftOut)
  fireEvent.click(getByRole('button', { name: 'Hide details' }))
  expect(banner.querySelector('.pause-banner__full-error')).toBeNull()
  expect(banner.textContent).not.toContain(leftOut)
})
