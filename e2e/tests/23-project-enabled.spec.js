// HZ-208: Admin's per-project enabled switch, end to end. Every flip asks for
// the gate PIN; a wrong one changes nothing, the right one flips the project
// and the board picks its items up.

import { test, expect, captureScreenshot } from '../fixtures/test-base.js'
import { openDb, insertItem, insertProject, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
const GATE_PIN = '650214'
const DELTA = 'E2E Delta'

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    const delta = insertProject(db, { name: DELTA, enabled: false })
    // Some project must be active, or every project counts as enabled. Keeps
    // spec 22's choice when it ran first.
    db.prepare("INSERT OR IGNORE INTO setting (key, value) VALUES ('active_project_id', ?)").run(String(delta))
    insertItem(db, { id: 'PE-D1', title: 'E2E fixture — Delta item', cursor: 3, project_id: delta })
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test('flipping a project on with the gate PIN: a wrong PIN changes nothing, the right one enables it', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.board__title')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('E2E fixture — Delta item')).toHaveCount(0)

  await page.goto('/admin')
  const toggle = page.getByRole('switch', { name: `${DELTA} enabled` })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  await toggle.click()
  const pin = page.getByLabel(`Gate PIN to enable ${DELTA}`)
  await pin.fill('000000')
  await page.getByRole('button', { name: 'Enable', exact: true }).click()
  await expect(page.getByText('Gate PIN incorrect')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  await pin.fill(GATE_PIN)
  await page.getByRole('button', { name: 'Enable', exact: true }).click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await captureScreenshot(page, 'project-enabled')
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(GATE_PIN)

  await page.getByRole('button', { name: 'Back to board' }).click()
  await expect(page.getByText('E2E fixture — Delta item')).toBeVisible()
})
