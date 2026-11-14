// HZ-814: a Task's Execute and Verify & report cards show the run's
// database changes as a table — table, before, after, change, inserted,
// updated, deleted — one row per declared table, and Review & close links to
// it. With no summary there is no table and no link.

import { afterEach, expect, test, vi } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'

vi.mock('../api', () => ({
  issueUrl: () => 'https://example.test/issue',
  issueLabel: (item) => `#${item.issue}`,
  artifactUrl: () => 'https://example.test/artifact',
  outputUrl: () => 'https://example.test/output',
  runLogViewUrl: () => 'https://example.test/log',
  jobLogUrl: (id) => `/horizon/api/items/${id}/job/log?format=text`,
  subscribeStepOutputs: vi.fn(() => () => {}),
  stopJob: vi.fn(),
  resumeJob: vi.fn(),
  patchRunPlan: vi.fn(),
}))

import Tracker from './Tracker'
import { STEPS, EXECUTE_STEP_INDEX, VERIFY_REPORT_STEP_INDEX, TASK_REVIEW_CLOSE_GATE_INDEX } from '../../../domain/js/lifecycle.js'

afterEach(() => cleanup())

const COLUMNS = ['table', 'before', 'after', 'change', 'inserted', 'updated', 'deleted']
const DB_CHANGES = {
  source: 'pg_stat',
  tables: [
    { table: 'prices', status: 'ok', before: 10, after: 11, inserted: 3, updated: 0, deleted: 2 },
    { table: 'public.positions', status: 'ok', before: 5, after: 5, inserted: 0, updated: 4, deleted: 0 },
    { table: 'audit', status: 'failed', reason: 'snapshot_timeout' },
  ],
}
const job = (extra = {}) => ({
  status: 'finished',
  elapsedS: 30,
  budgetS: 600,
  commands: [{ command: 'scripts/backfill.sh', status: 'done', exit_code: 0 }],
  logTail: [],
  ...extra,
})
const noop = () => {}

function renderTracker(executeJob) {
  return render(
    <Tracker
      item={{
        id: 'T-814',
        title: 'Backfill prices',
        desc: '',
        metric: '',
        guardrails: '',
        priority: 'Medium',
        kind: 'task',
        cursor: TASK_REVIEW_CLOSE_GATE_INDEX,
        paused: false,
        rejected: false,
        events: [],
        activeRun: null,
        providerChoices: {},
        stepOutputs: {
          [EXECUTE_STEP_INDEX]: { output: '1 command(s) run', attempt: 1, artifact: 'log', label: STEPS[EXECUTE_STEP_INDEX].label, job: executeJob },
          [VERIFY_REPORT_STEP_INDEX]: { output: 'verified', attempt: 1, artifact: '## Verdict\n**pass**', label: STEPS[VERIFY_REPORT_STEP_INDEX].label, verdict: 'pass' },
        },
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

function card(container, index) {
  const label = [...container.querySelectorAll('.step-card__label')].find((el) => el.textContent.startsWith(STEPS[index].label))
  return label.closest('.step-card')
}

function assertTable(scope) {
  const table = within(scope).getByRole('table', { name: /database changes/i })
  const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent.toLowerCase())
  expect(headers).toEqual(COLUMNS)
  const rows = within(table).getAllByRole('row').slice(1)
  expect(rows).toHaveLength(3)
  const cells = (row) => within(row).getAllByRole('cell').map((c) => c.textContent)
  expect(cells(rows[0])).toEqual(['prices', '10', '11', '+1', '3', '0', '2'])
  // An unchanged table shows change 0.
  expect(cells(rows[1])).toEqual(['public.positions', '5', '5', '0', '0', '4', '0'])
  expect(cells(rows[2])).toEqual(['audit', 'could not be counted'])
  expect(within(rows[2]).getByText('could not be counted').getAttribute('title')).toBe('snapshot_timeout')
  return table
}

test('Execute and Verify & report each show the table; Review & close links to it', () => {
  const { container } = renderTracker(job({ dbChanges: DB_CHANGES }))
  const execute = card(container, EXECUTE_STEP_INDEX)
  assertTable(execute)
  expect(execute.querySelector('#db-changes')).not.toBeNull()
  assertTable(card(container, VERIFY_REPORT_STEP_INDEX))
  expect(container.querySelectorAll('#db-changes')).toHaveLength(1)
  const link = within(card(container, TASK_REVIEW_CLOSE_GATE_INDEX)).getByRole('link', { name: /database changes/i })
  expect(link.getAttribute('href')).toBe('#db-changes')
})

test('with no summary there is no table on either card and no link on Review & close', () => {
  const { container } = renderTracker(job())
  for (const index of [EXECUTE_STEP_INDEX, VERIFY_REPORT_STEP_INDEX]) {
    expect(within(card(container, index)).queryByRole('table', { name: /database changes/i })).toBeNull()
  }
  expect(within(card(container, TASK_REVIEW_CLOSE_GATE_INDEX)).queryByRole('link', { name: /database changes/i })).toBeNull()
  expect(container.querySelector('#db-changes')).toBeNull()
})
