// HZ-384: a Task's Approve the run gate is always a human with the gate PIN,
// even on an Autopilot project. The amber awaiting card says so and shows the
// run plan's size; Reject with feedback sends the Task back to Run plan; a
// wrong PIN leaves the gate open; the right one passes it, and a reload keeps
// it passed. Demo mode runs the planning steps through the mock path, whose
// Run plan block is one command with a 5 minute budget.
//
// The fixture is seeded paused at Assess in its own Autopilot 'on' project, so
// no mock agent starts it until this spec resumes it. The spec sets its own
// gate PIN: 23-project-enabled rotates the shared one.

import { test, expect } from '../fixtures/test-base.js'
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
  // Every PIN prompt, answered in order; each answer records the prompt text.
  const answers = []
  const prompts = []
  page.on('dialog', (dialog) => {
    prompts.push(dialog.message())
    const answer = answers.shift()
    return answer === undefined ? dialog.dismiss() : dialog.accept(answer)
  })

  await page.goto(`/${ID.toLowerCase()}`)
  await page.evaluate(() => localStorage.removeItem('horizon_gate_pin'))
  await page.getByRole('button', { name: 'Resume work' }).click()

  const gate = stepCard(page, 'Approve the run')
  await expect(gate.getByText('Always a human · even on Autopilot')).toBeVisible({ timeout: 15_000 })
  await expect(gate.getByText('Run plan: 1 command · budget 5 min')).toBeVisible()
  await expect(gate).toHaveClass(/step-card--awaiting/)
  await expect(gate.getByRole('button', { name: 'Approve the run' })).toBeVisible()

  // Reject with feedback: back to Run plan, which runs again and returns here.
  answers.push(GATE_PIN)
  await gate.getByRole('button', { name: 'Reject with feedback' }).click()
  await page.locator('.composer__input').fill('Run it against staging first.')
  await page.locator('.composer__submit').click()
  await expect(page.locator('.activity-row__text', { hasText: 'sent back to the run plan step' })).toBeVisible({
    timeout: 10_000,
  })
  await expect(stepCard(page, 'Run plan').getByRole('link', { name: /attempt 2 of 2/ })).toBeVisible({ timeout: 15_000 })
  await expect(gate.getByText('Always a human · even on Autopilot')).toBeVisible({ timeout: 15_000 })

  // A wrong PIN: the server refuses, the prompt says so, the gate stays open.
  await page.evaluate(() => localStorage.removeItem('horizon_gate_pin'))
  answers.push('000000') // the retry prompt gets no answer: dismissed
  const promptsBefore = prompts.length
  await gate.getByRole('button', { name: 'Approve the run' }).click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__submit').click()
  await expect.poll(() => prompts.length, { timeout: 10_000 }).toBe(promptsBefore + 2)
  expect(prompts.at(-1)).toContain('Gate PIN incorrect')
  await expect(gate).toHaveClass(/step-card--awaiting/)
  await expect(gate.getByRole('button', { name: 'Approve the run' })).toBeVisible()

  // The right PIN passes the gate.
  answers.push(GATE_PIN)
  await gate.getByRole('button', { name: 'Approve the run' }).click()
  await expect(page.locator('.composer__title')).toHaveText('Approve this gate?')
  await page.locator('.composer__submit').click()
  await expect(gate.locator('.step-card__meta')).toHaveText('Approved by you', { timeout: 10_000 })
  await expect(gate.getByText('Always a human · even on Autopilot')).toHaveCount(0)

  // Still approved after a reload.
  await page.reload()
  await expect(stepCard(page, 'Approve the run').locator('.step-card__meta')).toHaveText('Approved by you', {
    timeout: 10_000,
  })
})
