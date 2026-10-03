// HZ-226: one wording source. The Tracker and a Board card show the same
// status text for the same Accept-gate item, and the status strings live only
// in ui/src/domain/gateAction.js.

import { expect, test, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
}))

import Board from './Board'
import Tracker from './Tracker'
import { ACCEPT_GATE_INDEX } from '../../../domain/js/lifecycle.js'
import { gateActionView } from '../domain/gateAction'

afterEach(() => {
  cleanup()
})

const noop = () => {}
const PR = 42

function action(state, extra = {}) {
  return {
    kind: 'premerge',
    state,
    detail: null,
    since: new Date().toISOString(),
    deadline: null,
    finishedAt: state === 'running' ? null : new Date().toISOString(),
    reason: null,
    failingCheck: null,
    startedBeforeRestart: false,
    ...extra,
  }
}

function item(gateAction) {
  return {
    id: 'PAR-1',
    title: 'Parity item',
    desc: '',
    metric: '',
    guardrails: '',
    priority: 'Medium',
    cursor: ACCEPT_GATE_INDEX,
    issue: null,
    pr: PR,
    pr_url: 'https://example.test/pr/42',
    paused: false,
    rejected: false,
    events: [],
    stepOutputs: {},
    activeRun: null,
    personas: { eng: 'fullstack' },
    gateAction,
    conflictRun: null,
  }
}

// The status text with the Tracker's elapsed clock removed.
function statusText(container) {
  const el = container.querySelector('.gate-action-status__text').cloneNode(true)
  el.querySelector('.gate-action-status__elapsed')?.remove()
  return el.textContent
}

test.each([
  ['running', action('running', { detail: 'npm test' })],
  ['merged', action('merged')],
  ['blocked', action('blocked', { failingCheck: 'unit-tests' })],
  ['timed_out', action('timed_out', { reason: 'pre-merge checks did not finish: timed out' })],
])('Tracker and Board card show identical status text when %s', (_, a) => {
  const it = item(a)
  const tracker = render(
    <Tracker
      item={it}
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
  const trackerText = statusText(tracker.container)
  cleanup()
  const board = render(<Board items={[it]} onOpen={noop} onApprove={noop} onReject={noop} onTogglePause={noop} onNewItem={noop} />)
  const boardText = statusText(board.container)
  expect(boardText).toBe(trackerText)
  expect(boardText).toBe(gateActionView(a, PR).text)
})

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(jsx?|tsx?)$/.test(name) && !/\.test\.[jt]sx?$/.test(name) ? [path] : []
  })
}

test('the gate action status strings live only in domain/gateAction.js', () => {
  const STRINGS = ['Merging:', 'Merged PR #', 'Blocked: pre-merge check', 'Checks did not finish']
  for (const s of STRINGS) {
    const hits = sourceFiles(SRC)
      .filter((f) => readFileSync(f, 'utf8').includes(s))
      .map((f) => relative(SRC, f))
    expect(hits, s).toEqual(['domain/gateAction.js'])
  }
})
