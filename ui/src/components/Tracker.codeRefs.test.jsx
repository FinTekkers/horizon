// HZ-546 metric 2, the Tracker's wiring: it builds Markdown's link context
// from the item (its kind decides Plan vs single-repo Change, its project
// gives the known repos), the knownItemIds it is passed, and each step's own
// stepOutputs[i].sourceShas — never another step's.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, screen, within } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(() => () => {}),
  // The Close card's Plan items table reads the draft; none here.
  getPlanDraft: vi.fn(() => new Promise(() => {})),
  savePlanDraft: vi.fn(),
}))

import Tracker from './Tracker'
import { itemHref } from './DependencyBadge'
import { STEPS, FILE_ITEMS_STEP_INDEX, REVIEW_CLOSE_GATE_INDEX, PLAN_INVENTORY_STEP_INDEX, IMPLEMENT_STEP_INDEX } from '../../../domain/js/lifecycle.js'
import { FENCE_INFO } from '../../../domain/js/planInventory.js'

afterEach(() => cleanup())

const FILE_SHA = 'f'.repeat(40)
const INVENTORY_SHA = 'a'.repeat(40)
const PROJECTS = [{ id: 7, name: 'FinTekkers', repos: [{ repo: 'FinTekkers/horizon' }, { repo: 'FinTekkers/ui-service' }] }]
const noop = () => {}
const done = (index, extra) => ({ output: '', attempt: 1, attemptCount: 1, artifact: null, label: STEPS[index].label, ...extra })

function renderItem(item, knownItemIds = new Set(['US-243'])) {
  return render(
    <Tracker
      item={{
        title: 'An item',
        desc: '',
        metric: '',
        guardrails: '',
        priority: 'Medium',
        paused: false,
        rejected: false,
        events: [],
        activeRun: null,
        providerChoices: {},
        project_id: 7,
        repo: 'FinTekkers/horizon',
        stepOutputs: {},
        ...item,
      }}
      projects={PROJECTS}
      knownItemIds={knownItemIds}
      onBack={noop}
      onApprove={noop}
      onApproveWithComments={noop}
      onReject={noop}
      onResolveConflicts={noop}
      onTogglePause={noop}
      onRestartPhase={noop}
      onSetPersona={noop}
      onSetStepProvider={noop}
      onAbandon={noop}
    />,
  )
}

const FILED = 'Filed `horizon:src/x.ts:12` and `src/x.ts:12`, after US-243.'
const inventoryArtifact = (ref) =>
  '```' +
  FENCE_INFO +
  '\n' +
  JSON.stringify({ repos: [{ repo: 'FinTekkers/ui-service', has: ['a'], gaps: [], evidence: [{ kind: 'file', ref, note: 'n' }] }], key_facts: [] }) +
  '\n```'

function renderPlan() {
  return renderItem({
    id: 'P-1',
    kind: 'plan',
    cursor: REVIEW_CLOSE_GATE_INDEX,
    stepOutputs: {
      [PLAN_INVENTORY_STEP_INDEX]: done(PLAN_INVENTORY_STEP_INDEX, {
        artifact: inventoryArtifact('src/routes/a.ts:4'),
        sourceShas: { 'FinTekkers/ui-service': INVENTORY_SHA, 'FinTekkers/horizon': INVENTORY_SHA },
      }),
      [FILE_ITEMS_STEP_INDEX]: done(FILE_ITEMS_STEP_INDEX, { output: FILED, sourceShas: { 'FinTekkers/horizon': FILE_SHA } }),
    },
  })
}

test('the File items tile links a repo reference at its own step’s sha, not the Inventory’s', () => {
  renderPlan()
  expect(screen.getByRole('link', { name: 'horizon:src/x.ts:12' }).getAttribute('href')).toBe(
    `https://github.com/FinTekkers/horizon/blob/${FILE_SHA}/src/x.ts#L12`,
  )
})

test('on a Plan (item.kind) a bare path stays plain, even with a sha recorded for the item’s repo', () => {
  const { container } = renderPlan()
  const code = [...container.querySelectorAll('code')].find((el) => el.textContent === 'src/x.ts:12')
  expect(code).toBeTruthy()
  expect(code.closest('a')).toBeNull()
})

test('an Inventory row’s bare evidence ref links against that row’s repo at the Inventory’s sha', () => {
  renderPlan()
  const table = screen.getByRole('table', { name: 'Current state per repo' })
  expect(within(table).getByRole('link', { name: 'src/routes/a.ts:4' }).getAttribute('href')).toBe(
    `https://github.com/FinTekkers/ui-service/blob/${INVENTORY_SHA}/src/routes/a.ts#L4`,
  )
})

test('a known id links to its Horizon page and an unknown one stays text', () => {
  renderPlan()
  const tile = screen.getByRole('link', { name: 'horizon:src/x.ts:12' }).closest('.md-body')
  expect(within(tile).getByRole('link', { name: 'US-243' }).getAttribute('href')).toBe(itemHref('US-243'))
})

test('a Change’s description links known ids from knownItemIds only; code references stay plain with no step sha', () => {
  const { container } = renderItem(
    { id: 'C-1', kind: 'change', cursor: IMPLEMENT_STEP_INDEX, desc: 'After US-243 and VS-110, not ZZ-9. See `src/x.ts:12`.' },
    new Set(['US-243', 'VS-110']),
  )
  const desc = container.querySelector('.tracker__desc')
  expect(within(desc).getByRole('link', { name: 'US-243' }).getAttribute('href')).toBe(itemHref('US-243'))
  expect(within(desc).getByRole('link', { name: 'VS-110' }).getAttribute('href')).toBe(itemHref('VS-110'))
  expect(within(desc).queryByRole('link', { name: 'ZZ-9' })).toBeNull()
  expect(within(desc).queryByRole('link', { name: 'src/x.ts:12' })).toBeNull()
})

test('with no knownItemIds nothing in the description links', () => {
  const { container } = renderItem({ id: 'C-2', kind: 'change', cursor: IMPLEMENT_STEP_INDEX, desc: 'After US-243.' }, null)
  expect(within(container.querySelector('.tracker__desc')).queryByRole('link')).toBeNull()
})
