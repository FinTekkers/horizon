// HO-848: against the real server, an owner can tell a Verify & report that
// ended work_failed from one that ended done_proof_incomplete, sees Execute's
// cause beside the verdict, and reads HO-841's Verify report from Admin with
// no hand-made API call.
//
// Both Tasks are seeded paused at Review & close, a gate, so nothing runs
// them — as in 42-task-verify-verdict.spec.js.

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun } from '../fixtures/seed.js'
import { STEPS, VERIFY_REPORT_STEP_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const PROOF_ID = 'TK-E2E-PROOF-INCOMPLETE'
const FAILED_ID = 'TK-E2E-WORK-FAILED-PREREQ'
const VERIFY = STEPS[VERIFY_REPORT_STEP_INDEX]

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(PROOF_ID)) return
    const seeds = [
      { id: PROOF_ID, title: 'E2E fixture — work done, proof incomplete', verifyOutcome: 'done_proof_incomplete', executeCause: null },
      { id: FAILED_ID, title: 'E2E fixture — work failed on a prerequisite', verifyOutcome: 'work_failed', executeCause: 'prereq' },
    ]
    for (const { id, title, verifyOutcome, executeCause } of seeds) {
      insertItem(db, { id, title, cursor: VERIFY_REPORT_STEP_INDEX + 1, paused: 1, kind: 'task' })
      insertStepRun(db, {
        itemId: id,
        stepIndex: VERIFY_REPORT_STEP_INDEX,
        attempt: 1,
        agent: VERIFY.agent,
        output: 'ran 1 command',
        artifact: '## Verdict\n**fail**',
        startedAt: '2026-11-10 10:00:00',
        endedAt: '2026-11-10 10:05:00',
        verdict: 'fail',
        verdictSummary: 'Command 1 failed.',
        verifyOutcome,
        executeCause,
      })
    }
  } finally {
    db.close()
  }
})

const verifyStep = (page) =>
  page.locator('.step', {
    has: page.locator('.step-card__label', { hasText: new RegExp(`^${VERIFY.label}(\\s*(Return here|Retry|Approve))?$`) }),
  })

async function expectProofIncomplete(page) {
  const step = verifyStep(page)
  await expect(step.getByRole('img', { name: 'Done, proof incomplete' })).toBeVisible({ timeout: 15_000 })
  await expect(step.getByRole('img', { name: /failed/i })).toHaveCount(0)
  await expect(step.getByTestId('verify-outcome')).toHaveText('Done, proof incomplete')
  await expect(step.getByTestId('verify-execute-cause')).toHaveCount(0)
}

async function expectWorkFailedPrereq(page) {
  const step = verifyStep(page)
  await expect(step.getByRole('img', { name: 'Verify & report failed' })).toBeVisible({ timeout: 15_000 })
  await expect(step.getByRole('img', { name: 'Done, proof incomplete' })).toHaveCount(0)
  await expect(step.getByTestId('verify-execute-cause')).toHaveText('prereq')
}

test('the item page tells done_proof_incomplete from work_failed and shows the Execute cause, after a reload too', async ({ page }) => {
  await page.goto(`/${PROOF_ID.toLowerCase()}`)
  await expectProofIncomplete(page)
  await page.reload()
  await expectProofIncomplete(page)

  await page.goto(`/${FAILED_ID.toLowerCase()}`)
  await expectWorkFailedPrereq(page)
  await page.reload()
  await expectWorkFailedPrereq(page)
})

test('Admin › Verify report reads the endpoint with the start date and N and shows its totals', async ({ page }) => {
  await page.goto('/admin/verify')
  await expect(page.getByRole('heading', { name: 'Verify report' })).toBeVisible({ timeout: 10_000 })
  await page.getByLabel('Start date').fill('2026-01-01')
  await page.getByLabel('Number of Tasks').fill('20')

  const answered = page.waitForResponse((res) => res.url().includes('/api/admin/productivity/verify?since=2026-01-01&n=20'))
  await page.getByRole('button', { name: 'Show' }).click()
  expect((await answered).status()).toBe(200)

  const table = page.getByRole('table', { name: 'Verify report totals' })
  await expect(table).toBeVisible()
  for (const label of ['Pass', 'Work failed', 'Done, proof incomplete', 'No verdict', 'Execute cause: prereq', 'Execute cause: unforeseeable']) {
    await expect(table.getByRole('rowheader', { name: label, exact: true })).toBeVisible()
  }
  await expect(page.getByTestId('verify-report-prereq-share')).toHaveText(/^(\d+\.\d%|—)$/)
  await expect(page.getByTestId('verify-report-first-pass-yield')).toHaveText(/^\d+\.\d%$/)
  await expect(page.getByTestId('verify-report-cohort')).toContainText('all projects')
  await expect(page.getByRole('alert')).toHaveCount(0)
})
