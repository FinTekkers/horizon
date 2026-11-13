// HO-837, end to end: a Task at Approve the run whose Preflight found a
// missing secret. The card names it, Approve the run is disabled and stays
// so after a reload. Re-run preflight (with the gate PIN) runs the step again
// — the demo farm passes — and the card then says Preflight passed; the PIN
// approves the run, and a reload keeps it approved.

import crypto from 'node:crypto'
import { test, expect, answerPinDialog } from '../fixtures/test-base.js'
import { openDb, insertItem, insertStepRun, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, APPROVE_RUN_GATE_INDEX, PREFLIGHT_STEP_INDEX, RUN_PLAN_STEP_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Earlier specs rotate the PIN (23-project-enabled); this spec sets its own.
const GATE_PIN = '837837'
const ID = 'HZ-E2E-PREFLIGHT'
const GATE = STEPS[APPROVE_RUN_GATE_INDEX].label
const PLAN =
  '## Commands\n1. backfill\n\n## Run plan block\n```json run-plan\n' +
  JSON.stringify({ cwd: '.', commands: ['scripts/a.sh'], budget_minutes: 5, env: { HORIZON_API_TOKEN: '$HORIZON_API_TOKEN' } }, null, 2) +
  '\n```'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    insertItem(db, { id: ID, title: 'E2E fixture — a task whose preflight found a missing secret', cursor: APPROVE_RUN_GATE_INDEX, kind: 'task' })
    insertStepRun(db, { itemId: ID, stepIndex: RUN_PLAN_STEP_INDEX, attempt: 1, agent: 'Eng', output: 'planned', artifact: PLAN, startedAt: '2026-11-12 10:00:00', endedAt: '2026-11-12 10:02:00' })
    // The farm's unmet Preflight for that plan, on the host, as the server stores it.
    const runId = insertStepRun(db, { itemId: ID, stepIndex: PREFLIGHT_STEP_INDEX, attempt: 1, agent: 'DevOps', output: 'preflight found 1 unmet prerequisite', artifact: '## Preflight\n\n**unmet**', startedAt: '2026-11-12 10:03:00', endedAt: '2026-11-12 10:03:05' })
    const hash = crypto.createHash('sha256').update(PLAN, 'utf8').digest('hex')
    const result = { passed: false, runner: 'host', run_user: 'ubuntu', unmet: [{ kind: 'env', name: 'HORIZON_API_TOKEN', reason: "not set in the job's environment" }] }
    db.prepare('UPDATE step_run SET plan_hash = ?, preflight_json = ? WHERE id = ?').run(hash, JSON.stringify(result), runId)
  } finally {
    db.close()
  }
})

// HZ-711: a step's label is a button that may carry a hint after the label.
const stepCard = (page, label) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: new RegExp(`^${label}(\\s*(Return here|Retry|Approve))?$`) }) })

test('Preflight blocks Approve the run naming the secret; Re-run preflight passes; the PIN approves; reloads keep each state', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto(`/${ID.toLowerCase()}`)
  const gate = stepCard(page, GATE)
  const approveButton = gate.getByRole('button', { name: GATE, exact: true })

  const expectBlocked = async () => {
    await expect(gate.getByTestId('preflight-unmet')).toHaveText("env HORIZON_API_TOKEN — not set in the job's environment", { timeout: 15_000 })
    await expect(gate.getByText(/Preflight found 1 unmet prerequisite on host as ubuntu/)).toBeVisible()
    await expect(approveButton).toBeDisabled()
  }
  await expectBlocked()
  await page.reload()
  await expectBlocked()

  await gate.getByRole('button', { name: 'Re-run preflight' }).click()
  const moveDialog = page.getByRole('dialog', { name: `Return to an earlier step · ${ID}` })
  await moveDialog.getByRole('button', { name: 'Return here' }).click()
  await answerPinDialog(page, GATE_PIN)
  await expect(moveDialog).toHaveCount(0)
  await expect(page.locator('.activity-row__text', { hasText: /moved this item back to “Preflight”/ })).toBeVisible({ timeout: 10_000 })

  // The demo farm's Preflight passes for the plan on record.
  await expect(gate.getByText('✓ Preflight passed on host as demo')).toBeVisible({ timeout: 15_000 })
  await expect(gate.getByTestId('preflight-unmet')).toHaveCount(0)
  await expect(approveButton).toBeEnabled()

  await approveButton.click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  // The session is still PIN-verified from Re-run preflight.
  await page.locator('.composer__submit').click()
  await expect(gate.locator('.step-card__meta')).toHaveText('Approved by you', { timeout: 10_000 })

  await page.reload()
  await expect(stepCard(page, GATE).locator('.step-card__meta')).toHaveText('Approved by you', { timeout: 10_000 })
})
