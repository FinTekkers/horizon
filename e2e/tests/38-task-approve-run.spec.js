// HZ-384: a Task's Approve the run gate is always a human with the gate PIN,
// even on an Autopilot project. The amber awaiting card says so and shows the
// run plan's size; Reject with feedback sends the Task back to Run plan; a
// wrong PIN leaves the gate open; the right one passes it, and a reload keeps
// it passed. Demo mode runs the planning steps through the mock path, whose
// Run plan block is one command with a 5 minute budget.
//
// The fixture is seeded paused at Assess in its own Autopilot 'on' project, so
// no mock agent starts it until this spec resumes it. The spec sets its own
// gate PIN: 23-project-enabled rotates the shared one. HZ-704: setting it locks
// the shared session, so the first gate action opens the PIN dialog; the spec
// locks it again (setGatePinDirect) before the wrong-PIN step.

import { test, expect, answerPinDialog } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, setGatePinDirect } from '../fixtures/seed.js'
import { kindStepIndex } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ID = 'TK-E2E-RUN'
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '384127'
const ASSESS = kindStepIndex('Assess', 'task')

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    const project = insertProject(db, { name: 'E2E Approve the run (Autopilot on)' })
    db.prepare("UPDATE project SET autopilot = 'on' WHERE id = ?").run(project)
    insertItem(db, { id: ID, title: 'E2E fixture — a task waits for a human to approve its run', cursor: ASSESS, paused: 1, kind: 'task', project_id: project })
  } finally {
    db.close()
  }
})

const stepCard = (page, label) =>
  page.locator('.step-card', { has: page.locator('.step-card__label', { hasText: new RegExp(`^${label}$`) }) })

test('Approve the run: the human-only card, Reject back to Run plan, a wrong PIN refused, the right PIN passes', async ({ page }) => {
  test.setTimeout(60_000)
  const pinDialog = page.getByRole('dialog', { name: 'Enter your gate PIN' })

  await page.goto(`/${ID.toLowerCase()}`)
  await page.getByRole('button', { name: 'Resume work' }).click()

  const gate = stepCard(page, 'Approve the run')
  await expect(gate.getByText('Always a human · even on Autopilot')).toBeVisible({ timeout: 15_000 })
  await expect(gate.getByText('Run plan: 1 command · budget 5 min')).toBeVisible()
  await expect(gate).toHaveClass(/step-card--awaiting/)
  await expect(gate.getByRole('button', { name: 'Approve the run' })).toBeVisible()

  // Reject with feedback: back to Run plan, which runs again and returns here.
  // The first gate action since setGatePinDirect locked the session.
  await gate.getByRole('button', { name: 'Reject with feedback' }).click()
  await page.locator('.composer__input').fill('Run it against staging first.')
  await page.locator('.composer__submit').click()
  await answerPinDialog(page, GATE_PIN)
  await expect(page.locator('.activity-row__text', { hasText: 'sent back to the run plan step' })).toBeVisible({
    timeout: 10_000,
  })
  await expect(stepCard(page, 'Run plan').getByRole('link', { name: /attempt 2 of 2/ })).toBeVisible({ timeout: 15_000 })
  await expect(gate.getByText('Always a human · even on Autopilot')).toBeVisible({ timeout: 15_000 })

  // A wrong PIN: lock the session again so the dialog asks; the server
  // refuses, the dialog says so, Cancel leaves the gate open.
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
  await gate.getByRole('button', { name: 'Approve the run' }).click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__submit').click()
  await expect(pinDialog).toBeVisible({ timeout: 10_000 })
  await pinDialog.getByLabel('Gate PIN').fill('000000')
  await pinDialog.getByRole('button', { name: 'Continue' }).click()
  await expect(pinDialog.getByText('PIN incorrect — try again.')).toBeVisible({ timeout: 10_000 })
  await pinDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(pinDialog).toBeHidden()
  await expect(gate).toHaveClass(/step-card--awaiting/)
  await expect(gate.getByRole('button', { name: 'Approve the run' })).toBeVisible()

  // The right PIN passes the gate.
  await gate.getByRole('button', { name: 'Approve the run' }).click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__submit').click()
  await answerPinDialog(page, GATE_PIN)
  await expect(gate.locator('.step-card__meta')).toHaveText('Approved by you', { timeout: 10_000 })
  await expect(gate.getByText('Always a human · even on Autopilot')).toHaveCount(0)

  // Still approved after a reload.
  await page.reload()
  await expect(stepCard(page, 'Approve the run').locator('.step-card__meta')).toHaveText('Approved by you', {
    timeout: 10_000,
  })
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(GATE_PIN)
})
