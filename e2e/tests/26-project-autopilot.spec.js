// HZ-270: Admin's per-project Autopilot setting, end to end. It starts off,
// offers exactly off/shadow/on, every change is confirmed and gate-PIN
// protected (HZ-704: the PIN dialog), and the saved value survives a reload, with the change listed in the project's
// Autopilot history. A wrong PIN is refused by the route
// (server/test/gate-pin-routes.test.mjs).

import { test, expect, answerPinDialog, adminProjectPath } from '../fixtures/test-base.js'
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

test('Autopilot defaults to off; the right PIN saves it and it survives a reload', async ({ page }) => {
  // HZ-764: Autopilot is on the project's Automation tab.
  await page.goto(await adminProjectPath(page, PROJECT, { tab: 'automation' }))
  const select = page.getByLabel(`${PROJECT} Autopilot`, { exact: true })
  await expect(select).toHaveValue('off')
  await expect(select.locator('option')).toHaveText(['off', 'shadow', 'on'])

  await select.selectOption('shadow')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await answerPinDialog(page, GATE_PIN)
  await expect(select).toHaveValue('shadow')
  const history = page.getByRole('list', { name: `${PROJECT} Autopilot history` })
  await expect(history).toContainText('off → shadow')
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(GATE_PIN)

  await page.reload()
  await expect(page.getByLabel(`${PROJECT} Autopilot`, { exact: true })).toHaveValue('shadow')
  await expect(page.getByRole('list', { name: `${PROJECT} Autopilot history` })).toContainText('off → shadow')
})
