// HZ-540 metrics 1 and 2, guardrail 1: an item with a sub-step snapshot,
// through the real server and UI. Its card stays in its phase column, the
// board keeps its columns, and the tracker draws the snapshot's sub-steps as
// indented rows under their anchors. A send-back from Accept the code to the
// audit sub-step lands the item there, and a reload shows it.
//
// The snapshot is written straight into work_item.substeps_json, as HZ-538's
// intake leaves it; its labels appear in no project file. An open dependency
// holds the item once it is back at implement, so the mock pipeline does not
// walk it on before the reload.

import { existsSync, readFileSync } from 'node:fs'
import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, insertDependency, setGatePinDirect } from '../fixtures/seed.js'
import { STEPS, PHASES, ACCEPT_GATE_INDEX, IMPLEMENT_STEP_INDEX } from '../../domain/js/lifecycle.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Its own PIN: earlier specs rotate the admin's.
const GATE_PIN = '540540'
const ID = 'HZ-E2E-SUBSTEP'
const BLOCKER = 'HZ-E2E-SUBSTEP-BLOCKER'
const PROJECT = 'E2E Sub-steps'
const STEPS_FILE = new URL('../../farm/projects/e2e-sub-steps/steps.json', import.meta.url)
const SUBSTEPS = [
  { id: 'golden-cases', label: 'Golden test cases', kind: 'opening', anchor: 1, persona: 'data_integrity', output: 'golden_cases' },
  { id: 'impl-audit', label: 'Audit the change', kind: 'audit', anchor: IMPLEMENT_STEP_INDEX, persona: 'performance', output: 'findings' },
]

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
    // beforeAll re-runs in a fresh worker after a failed test; seed once.
    if (db.prepare('SELECT 1 FROM work_item WHERE id = ?').get(ID)) return
    const projectId = insertProject(db, { name: PROJECT })
    insertItem(db, { id: BLOCKER, title: 'E2E fixture — holds the sub-step item at implement', cursor: 2, paused: 1 })
    insertItem(db, { id: ID, title: 'E2E fixture — an item with sub-steps', cursor: ACCEPT_GATE_INDEX, project_id: projectId })
    db.prepare('UPDATE work_item SET substeps_json = ? WHERE id = ?').run(JSON.stringify(SUBSTEPS), ID)
    insertDependency(db, { itemId: ID, dependsOnId: BLOCKER })
  } finally {
    db.close()
  }
})

const card = (page) => page.locator('.card').filter({ has: page.locator('.card__id', { hasText: new RegExp(`^${ID}$`) }) })
const column = (page, name) => page.locator('.col').filter({ has: page.locator('.col__name', { hasText: new RegExp(`^${name}$`) }) })

test('the board and tracker show the snapshot’s sub-steps, and a send-back to one survives a reload', async ({ page }) => {
  // The labels are the snapshot's alone: no project file names them.
  const fileText = existsSync(STEPS_FILE) ? readFileSync(STEPS_FILE, 'utf8') : ''
  for (const sub of SUBSTEPS) expect(fileText).not.toContain(sub.label)

  await page.goto('/')
  const phase = PHASES[STEPS[IMPLEMENT_STEP_INDEX].phase]
  await expect(column(page, phase).locator('.card__id', { hasText: new RegExp(`^${ID}$`) })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.col')).toHaveCount(PHASES.length)

  await page.goto(`/${ID.toLowerCase()}`)
  const rows = page.getByTestId('substep-row')
  await expect(rows).toHaveCount(SUBSTEPS.length, { timeout: 15_000 })
  await expect(rows.locator('.step-card__label')).toHaveText(SUBSTEPS.map((s) => s.label))
  for (const sub of SUBSTEPS) {
    // Each row follows its anchor's step card, indented.
    const anchor = page.locator('.step:not(.step--sub)', { has: page.locator('.step-card__label', { hasText: STEPS[sub.anchor].label }) })
    await expect(anchor.locator('xpath=following-sibling::div[1]')).toHaveAttribute('data-substep', sub.id)
  }

  // Send back to the audit sub-step, picked by its label.
  await page.evaluate(() => localStorage.removeItem('horizon_gate_pin'))
  page.once('dialog', (dialog) => dialog.accept(GATE_PIN))
  await page.locator('.step-card--awaiting').getByRole('button', { name: 'Send back with feedback' }).click()
  const picker = page.getByLabel('Send back to')
  const option = picker.locator('option', { hasText: 'Audit the change' })
  await picker.selectOption(await option.getAttribute('value'))
  await page.locator('.composer__input').fill('Tighten the audit.')
  await page.locator('.composer__submit').click()
  await expect(page.locator('.composer')).toHaveCount(0, { timeout: 15_000 })

  await page.reload()
  const current = page.locator('[data-substep="impl-audit"]')
  await expect(current.locator('[aria-current="step"]')).toBeVisible({ timeout: 15_000 })
  await expect(current).toContainText('Current sub-step')
  await expect(current).toContainText('Performance')
  await current.scrollIntoViewIfNeeded()
  await captureScreenshot(page, 'substep-tracker')

  await page.goto('/')
  const col = column(page, phase)
  await expect(col.locator('.card__id', { hasText: new RegExp(`^${ID}$`) })).toBeVisible({ timeout: 15_000 })
  await expect(card(page).getByTestId('card-substep')).toContainText('Audit the change')
  await expect(card(page).getByTestId('card-substep')).toContainText('Performance')
  await expect(page.locator('.col')).toHaveCount(PHASES.length)
})
