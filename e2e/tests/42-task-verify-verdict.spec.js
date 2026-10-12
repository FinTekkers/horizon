// HZ-429 metric 2: a Task whose Verify & report failed shows a red circle-X
// and its 1-3 line summary, in the step list and in the Activity panel, not
// a green tick. The full Verify markdown still opens beside it.
//
// The fixture is MDI-51's failed run as the server now records it: the
// verdict and summary on the step_run, and the completion event — the newest
// one, since Activity shows only the latest 12 — carrying the same verdict.
// It is seeded paused at Review & close, a gate, so nothing runs it.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun, insertEvent } from '../fixtures/seed.js'
import { STEPS, VERIFY_REPORT_STEP_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'TK-E2E-VERDICT'
const VERIFY = STEPS[VERIFY_REPORT_STEP_INDEX]
const SUMMARY = 'Command 1 crashed on import.\nNone of the 5 metric lines hold.'
const ARTIFACT =
  '## Verdict\n**fail**: command 1 crashed on import of `ledger.backfill`.\n\n' +
  '## Commands\n1 run, 0 passed, 1 failed.\n\n## Metric check\n- none of the 5 metric lines hold'
const FAILURE_RED = 'rgb(156, 51, 62)' // #9C333E, --danger

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    insertItem(db, {
      id: ID,
      title: 'E2E fixture — a task whose Verify & report failed',
      cursor: VERIFY_REPORT_STEP_INDEX + 1,
      paused: 1,
      kind: 'task',
    })
    insertStepRun(db, {
      itemId: ID,
      stepIndex: VERIFY_REPORT_STEP_INDEX,
      attempt: 1,
      agent: VERIFY.agent,
      output: 'ran 1 command; none of the 5 metric lines hold',
      artifact: ARTIFACT,
      startedAt: '2026-10-12 10:00:00',
      endedAt: '2026-10-12 10:05:00',
      verdict: 'fail',
      verdictSummary: SUMMARY,
    })
    insertEvent(db, {
      itemId: ID,
      who: 'QA',
      text: `completed “${VERIFY.label}” — ran 1 command; none of the 5 metric lines hold`,
      color: '#2E7D5B',
      initials: 'QA',
      detail: SUMMARY,
      verdict: 'fail',
    })
  } finally {
    db.close()
  }
})

test('a failed Verify & report shows a red circle-X and its summary in the step list and Activity', async ({ page, request }) => {
  await page.goto(`/${ID.toLowerCase()}`)

  const step = page.locator('.step', {
    has: page.locator('.step-card__label', { hasText: new RegExp(`^${VERIFY.label}$`) }),
  })
  const stepX = step.getByRole('img', { name: /failed/i })
  await expect(stepX).toBeVisible({ timeout: 15_000 })
  await expect(step.locator('.step__icon')).toHaveCSS('background-color', FAILURE_RED)
  await expect(step.locator('.step__icon')).not.toContainText('✓')
  await expect(step.getByText('Command 1 crashed on import.')).toBeVisible()
  await expect(step.getByText('None of the 5 metric lines hold.')).toBeVisible()

  const activity = page.locator('.tracker__activity')
  const activityX = activity.getByRole('img', { name: /failed/i })
  await expect(activityX).toBeVisible()
  await expect(activity.getByTestId('activity-verdict-fail')).toHaveCSS('background-color', FAILURE_RED)
  await expect(activity.getByText('Command 1 crashed on import.')).toBeVisible()

  // The PR screenshot shows the failed step itself, not the page top.
  await step.scrollIntoViewIfNeeded()
  await captureScreenshot(page, 'task-verify-verdict-fail')

  // The full Verify markdown is unchanged and still opens beside the summary.
  const link = step.getByRole('link', { name: 'View full artifact ↗' })
  await expect(link).toBeVisible()
  const res = await request.get(`/api/items/${ID}/artifacts/${VERIFY_REPORT_STEP_INDEX}`)
  expect(res.ok()).toBe(true)
  const body = await res.text()
  expect(body).toContain('command 1 crashed on import of')
  expect(body).toContain('none of the 5 metric lines hold')
})
