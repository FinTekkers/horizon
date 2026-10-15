// HZ-462 metric 1 (R6, R7): a Plan item's done Inventory step shows its block
// as tables on the item page — the current state per repo (has now / gaps /
// evidence) and the key facts — one row per input row, each evidence ref in
// the mono id style. The input is the shared 2-repo fixture, wrapped as
// domain/py/plan_inventory.py's render() appends it to the artifact.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, within, screen } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  subscribeStepOutputs: vi.fn(() => () => {}),
}))

import Tracker from './Tracker'
import { STEPS, PLAN_INVENTORY_STEP_INDEX } from '../../../domain/js/lifecycle.js'
import { FENCE_INFO } from '../../../domain/js/planInventory.js'
import fixtures from '../../../domain/fixtures/plan-inventory-cases.json'

afterEach(() => cleanup())

const INVENTORY = PLAN_INVENTORY_STEP_INDEX
const BLOCK = fixtures.cases.find((c) => c.case === 'a 2-repo sample with key facts').block
const rendered = (block) => '```' + FENCE_INFO + '\n' + JSON.stringify(block, null, 2) + '\n```'
const output = (artifact) => ({ output: 'inventoried 2 repos', attempt: 1, attemptCount: 1, artifact, label: STEPS[INVENTORY].label })
const noop = () => {}

function renderPlan(stepOutputs, cursor = INVENTORY + 1) {
  return render(
    <Tracker
      item={{
        id: 'P-462',
        title: 'Plan the retention work',
        desc: '',
        metric: '',
        guardrails: '',
        priority: 'Medium',
        kind: 'plan',
        cursor,
        paused: false,
        rejected: false,
        events: [],
        activeRun: null,
        providerChoices: {},
        stepOutputs,
      }}
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

const headers = (table) => within(table).getAllByRole('columnheader').map((th) => th.textContent)
const bodyRows = (table) => within(table).getAllByRole('row').slice(1)
const refsIn = (el) => [...el.querySelectorAll('code.data-table__ref')].map((code) => code.textContent)

test('R6: the current-state table has one row per repo, with has now, gaps and mono evidence', () => {
  renderPlan({ [INVENTORY]: output(`## Current state\n\nProse.\n\n${rendered(BLOCK)}`) })
  const table = screen.getByRole('table', { name: 'Current state per repo' })
  expect(table.classList.contains('data-table')).toBe(true)
  expect(headers(table)).toEqual(['Repo', 'Has now', 'Gaps', 'Evidence'])
  const rows = bodyRows(table)
  expect(rows).toHaveLength(BLOCK.repos.length)
  BLOCK.repos.forEach((repo, i) => {
    const cells = within(rows[i]).getAllByRole('cell')
    expect(cells[0].textContent).toBe(repo.repo)
    for (const line of repo.has) expect(cells[1].textContent).toContain(line)
    if (repo.gaps.length === 0) expect(cells[2].textContent).toBe('—')
    for (const line of repo.gaps) expect(cells[2].textContent).toContain(line)
    expect(refsIn(cells[3])).toEqual(repo.evidence.map((e) => e.ref))
    for (const e of repo.evidence) expect(cells[3].textContent).toContain(e.note)
  })
  // The full artifact stays one click away.
  expect(screen.getByText('View full artifact ↗')).toBeTruthy()
})

test('R7: the key-facts table has one row per key fact, with its topic, fact and mono evidence', () => {
  renderPlan({ [INVENTORY]: output(rendered(BLOCK)) })
  const table = screen.getByRole('table', { name: 'Key facts' })
  expect(table.classList.contains('data-table')).toBe(true)
  expect(headers(table)).toEqual(['Topic', 'Fact', 'Evidence'])
  const rows = bodyRows(table)
  expect(rows).toHaveLength(BLOCK.key_facts.length)
  BLOCK.key_facts.forEach((fact, i) => {
    const cells = within(rows[i]).getAllByRole('cell')
    expect(cells[0].textContent).toBe('Storage')
    expect(cells[1].textContent).toBe(fact.fact)
    expect(refsIn(cells[2])).toEqual(fact.evidence.map((e) => e.ref))
  })
})

test('with no block the step card shows no table and keeps the artifact link', () => {
  renderPlan({ [INVENTORY]: output('## Current state\n\nNo block here.') })
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.getByText('View full artifact ↗')).toBeTruthy()
})

test('no table while the Inventory step is still running', () => {
  renderPlan({ [INVENTORY]: output(rendered(BLOCK)) }, INVENTORY)
  expect(screen.queryByRole('table')).toBeNull()
})
