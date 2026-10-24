// HZ-535: Admin's per-project "Project definitions" switch, end to end. It
// sits right after the Autopilot control, starts on, refuses a request with no
// gate PIN (401, value unchanged), and with the right PIN turns off and stays
// off after a reload. A wrong PIN is refused by the route too
// (server/test/gate-pin-routes.test.mjs).

import { test, expect } from '../fixtures/test-base.js'
import { openDb, insertProject, setGatePinDirect } from '../fixtures/seed.js'

const DB_PATH = process.env.HORIZON_E2E_DB
const ADMIN_EMAIL = 'admin@example.com'
// Its own PIN: earlier specs rotate the admin's.
const GATE_PIN = '535535'
const PROJECT = 'E2E Project Definitions'
let projectId

test.beforeAll(() => {
  const db = openDb(DB_PATH)
  try {
    projectId = insertProject(db, { name: PROJECT, enabled: false })
    setGatePinDirect(db, ADMIN_EMAIL, GATE_PIN)
  } finally {
    db.close()
  }
})

test('the definitions switch sits next to Autopilot; no PIN is 401, the right PIN turns it off and it survives a reload', async ({ page }) => {
  await page.goto('/admin')
  const autopilot = page.getByLabel(`${PROJECT} Autopilot`, { exact: true })
  const definitions = page.getByLabel(`${PROJECT} project definitions`, { exact: true })
  await expect(autopilot).toBeVisible()
  await expect(definitions).toBeChecked()

  // Same project block, and the control right after the Autopilot one.
  const block = page.locator('.project-block').filter({ has: autopilot })
  await expect(block.locator('.project-definitions').getByLabel(`${PROJECT} project definitions`, { exact: true })).toBeVisible()
  await expect(block.locator('.project-autopilot + .project-definitions')).toHaveCount(1)

  // The browser's own session, so the 401 is the PIN's, never login_required.
  const refused = await page.request.post(`/api/projects/${projectId}/definitions-enabled`, { data: { enabled: false } })
  expect(refused.status()).toBe(401)
  expect(await refused.json()).toEqual({ error: 'human_gate_key_required' })
  await page.reload()
  await expect(page.getByLabel(`${PROJECT} project definitions`, { exact: true })).toBeChecked()

  await definitions.click()
  // The box shows the server's value while the PIN is asked for.
  await expect(definitions).toBeChecked()
  await page.getByLabel(`Gate PIN to turn ${PROJECT} project definitions off`).fill(GATE_PIN)
  await block.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(definitions).not.toBeChecked()
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(GATE_PIN)

  await page.reload()
  await expect(page.getByLabel(`${PROJECT} project definitions`, { exact: true })).not.toBeChecked()
})
