// HZ-540 metrics 1 and 2, guardrail 1: an item with a sub-step snapshot,
// through the real server and UI. Its card stays in its phase column, the
// board keeps its columns, and the tracker draws the snapshot's sub-steps as
// indented rows under their anchors. HZ-711: a return from Accept the code
// (Return to…, the Move dialog) lists the snapshot's targets, the sub-steps
// HZ-799 offers among them, so a return to the audit sub-step lands the item
// on Specialist agent implements at that sub-step, and a reload shows it.
//
// The snapshot is written straight into work_item.substeps_json, as HZ-538's
// intake leaves it; its labels appear in no project file. An open dependency
// holds the item once it is back at implement, so the mock pipeline does not
// walk it on before the reload.
//
// HZ-704: setting the spec's own PIN locks the shared session, so the
// return opens the PIN dialog.

import { existsSync, readFileSync } from 'node:fs'
import { test, expect, answerPinDialog } from '../fixtures/test-base.js'
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

test('the board and tracker show the snapshot’s sub-steps, and a return to the audit sub-step survives a reload', async ({ page }) => {
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
  // Before the return: the item is at the gate, at no sub-step.
  await expect(page.locator('[data-substep] [aria-current="step"]')).toHaveCount(0)
  for (const sub of SUBSTEPS) {
    // Each row follows its anchor's step card, indented.
    const anchor = page.locator('.step:not(.step--sub)', { has: page.locator('.step-card__label', { hasText: STEPS[sub.anchor].label }) })
    await expect(anchor.locator('xpath=following-sibling::div[1]')).toHaveAttribute('data-substep', sub.id)
  }

  // Return to the audit sub-step, picked by its label among the snapshot's
  // targets — named by the served key, `<step>#<sub-step>`.
  const implement = STEPS[IMPLEMENT_STEP_INDEX]
  const audit = SUBSTEPS[1]
  const auditKey = `${implement.key}#${audit.id}`
  const served = (await (await page.request.get('/api/items')).json()).items.find((it) => it.id === ID).moves
  expect(served.actions[auditKey]).toBe('return')
  await page.locator('.step-card--awaiting').getByRole('button', { name: 'Return to…' }).click()
  const dialog = page.getByRole('dialog', { name: `Return to an earlier step · ${ID}` })
  await expect(dialog).toBeVisible()
  const radio = dialog.getByRole('radio', { name: new RegExp(`^${audit.label}`) })
  await expect(radio).toHaveAttribute('value', auditKey)
  await radio.check()
  await expect(dialog.getByTestId('move-summary')).toContainText(served.targets.find((t) => t.stepKey === auditKey).redo)
  await dialog.getByLabel('Note for the step (optional)').fill('Tighten the audit.')
  const moved = page.waitForResponse((res) => res.url().endsWith(`/api/items/${ID}/move`) && res.status() !== 401)
  await dialog.getByRole('button', { name: 'Return here' }).click()
  await answerPinDialog(page, GATE_PIN)
  const res = await moved
  expect(res.status()).toBe(200)
  expect(res.request().postDataJSON()).toEqual({ stepKey: auditKey, from: STEPS[ACCEPT_GATE_INDEX].key, note: 'Tighten the audit.' })
  await expect(dialog).toHaveCount(0, { timeout: 15_000 })

  // The anchor step is current, at the audit sub-step — after a reload too.
  // The open dependency holds it there.
  const expectAtAnchor = async () => {
    await expect
      .poll(async () => {
        const item = (await (await page.request.get('/api/items')).json()).items.find((it) => it.id === ID)
        return [item.currentStepKey, item.substep_cursor]
      })
      .toEqual([implement.key, audit.id])
    await expect(page.locator('.step-card--awaiting')).toHaveCount(0)
    await expect(page.getByTestId('substep-row')).toHaveCount(SUBSTEPS.length)
  }
  await page.reload()
  await expect(page.locator('.tracker__id')).toHaveText(ID, { timeout: 15_000 })
  await expectAtAnchor()

  await page.goto('/')
  const col = column(page, phase)
  await expect(col.locator('.card__id', { hasText: new RegExp(`^${ID}$`) })).toBeVisible({ timeout: 15_000 })
  // The card names the sub-step the item is at.
  await expect(card(page).getByTestId('card-substep')).toContainText(audit.label)
  await expect(page.locator('.col')).toHaveCount(PHASES.length)
})
