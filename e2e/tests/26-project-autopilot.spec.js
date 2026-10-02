// HZ-270: Admin's per-project Autopilot setting, end to end. It starts off,
// offers exactly off/shadow/on, asks for the gate PIN on every change — a
// wrong PIN changes nothing — and the saved value survives a reload, with the
// change listed in the project's Autopilot history.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertProject, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '650214'
const PROJECT = 'E2E Autopilot'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    insertProject(db, { name: PROJECT, enabled: false })
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test('Autopilot defaults to off; a wrong PIN changes nothing; the right one saves and survives a reload', async ({ page }) => {
  await page.goto('/admin')
  const select = page.getByLabel(`${PROJECT} Autopilot`, { exact: true })
  await expect(select).toHaveValue('off')
  await expect(select.locator('option')).toHaveText(['off', 'shadow', 'on'])

  await select.selectOption('shadow')
  const pin = page.getByLabel(`Gate PIN to set ${PROJECT} Autopilot to shadow`)
  await pin.fill('000000')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Gate PIN incorrect')).toBeVisible()
  await expect(select).toHaveValue('off')

  await pin.fill(GATE_PIN)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(select).toHaveValue('shadow')
  const history = page.getByRole('list', { name: `${PROJECT} Autopilot history` })
  await expect(history).toContainText('off → shadow')
  await captureScreenshot(page, 'project-autopilot')
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(GATE_PIN)

  await page.reload()
  await expect(page.getByLabel(`${PROJECT} Autopilot`, { exact: true })).toHaveValue('shadow')
  await expect(page.getByRole('list', { name: `${PROJECT} Autopilot history` })).toContainText('off → shadow')
})
