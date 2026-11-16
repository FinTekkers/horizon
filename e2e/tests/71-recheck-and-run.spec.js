// HO-842, end to end: a Task at Execute whose dispatch re-check (HO-838)
// refused for a missing MDI_DB_URL. Its banner offers Re-check and run, not
// Retry. The host is still not fixed (the farm's answer is stubbed through
// /api/test/recheck-result — the e2e server has no farm), so the click lists
// MDI_DB_URL by name, never the value the farm sent, asks for no PIN and
// dispatches nothing. After a reload the button is still there and Activity
// holds one entry for the click, naming the login.

import crypto from 'node:crypto'
import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun, insertEvent } from '../fixtures/seed.js'
import { EXECUTE_STEP_INDEX, RUN_PLAN_STEP_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const ID = 'HZ-E2E-RECHECK-RUN'
const SECRET = 'postgres://e2e-842:value-never-shown@db'
const REFUSAL = 'prerequisites changed since approval — failed: MDI_DB_URL'
const PLAN =
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands: ['scripts/a.sh'], budget_minutes: 5, env: { MDI_DB_URL: '$MDI_DB_URL' } }, null, 2) +
  '\n```'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    insertItem(db, { id: ID, title: 'E2E fixture — a task refused at dispatch for a missing env var', cursor: EXECUTE_STEP_INDEX, kind: 'task', paused: 1 })
    const hash = crypto.createHash('sha256').update(PLAN, 'utf8').digest('hex')
    db.prepare("UPDATE work_item SET approved_plan_hash = ?, approved_runner = 'host', paused_at = datetime('now') WHERE id = ?").run(hash, ID)
    insertStepRun(db, { itemId: ID, stepIndex: RUN_PLAN_STEP_INDEX, attempt: 1, agent: 'Eng', output: 'planned', artifact: PLAN, startedAt: '2026-11-16 10:00:00', endedAt: '2026-11-16 10:02:00' })
    // The refusal as HO-838's failFarmRun writes it: the closed Execute run, then its pause event.
    insertStepRun(db, { itemId: ID, stepIndex: EXECUTE_STEP_INDEX, attempt: 1, agent: 'DevOps', status: 'cancelled', output: `FAILED: ${REFUSAL}`, startedAt: '2026-11-16 10:05:00', endedAt: '2026-11-16 10:05:01' })
    insertEvent(db, { itemId: ID, text: `agent step failed (prereq_drift): ${REFUSAL} — item paused; resume to retry` })
  } finally {
    db.close()
  }
})

test.afterAll(async ({ request }) => {
  await request.post('/api/test/recheck-result', { data: { itemId: ID, answer: null } })
})

test('Re-check and run on a host still missing MDI_DB_URL lists it by name, asks no PIN, and logs one entry that survives a reload', async ({ page, request }) => {
  test.setTimeout(60_000)
  const stub = await request.post('/api/test/recheck-result', {
    data: { itemId: ID, answer: { ok: false, failed: ['MDI_DB_URL'], unmet: [{ kind: 'env', name: 'MDI_DB_URL', reason: 'not set', value: SECRET }] } },
  })
  expect(stub.ok()).toBeTruthy()

  await page.goto(`/${ID.toLowerCase()}`)
  const banner = page.locator('[data-hold-banner="runFailed"]')
  const button = banner.getByRole('button', { name: 'Re-check and run' })
  await expect(banner.locator('.pause-banner__title')).toHaveText('Run refused: host changed since approval', { timeout: 15_000 })
  await expect(button).toBeVisible()
  // The banner's one action replaces Retry; the step list's own move controls are not the hold's.
  await expect(banner.locator('[data-hold-action]')).toHaveCount(1)
  await expect(banner.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)

  await button.click()
  await expect(banner.getByTestId('recheck-run-unmet')).toHaveText(['env MDI_DB_URL'], { timeout: 10_000 })
  await expect(banner.getByTestId('recheck-run-refusal')).toContainText('still misses what the run plan needs')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(SECRET)

  const entry = page.locator('.activity-row__text', { hasText: `Re-check and run by ${ADMIN_EMAIL}` })
  await expect(entry).toHaveCount(1, { timeout: 10_000 })
  await page.reload()
  await expect(page.locator('[data-hold-banner="runFailed"]').getByRole('button', { name: 'Re-check and run' })).toBeVisible({ timeout: 15_000 })
  await expect(entry).toHaveCount(1)
  await expect(entry).toContainText('refused — prerequisites_unmet — unmet: env MDI_DB_URL')
  await expect(page.locator('body')).not.toContainText(SECRET)
})
